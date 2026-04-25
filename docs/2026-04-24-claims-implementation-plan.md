# Claims-First Memory Layer — Implementation Plan

Companion to `docs/2026-04-24-claims-layer-design.md`. The design doc is the "what" and "why"; this is the "how" and "in what order."

## Principles

- Each phase leaves the system in a runnable, tested state. No half-migrated world in `main`.
- Schema and consumer code move together per phase. No dangling rename.
- Destructive DDL (the table rename, the typeid rewrite, the structural-predicate deletion) runs inside a single transactional migration per user. No live reads against half-renamed columns.
- Behavior-preserving refactors land first; behavior changes land on top of a green build. "Adapt, then evolve."
- Every phase has concrete acceptance gates tied to specific tests that must pass.

## Inventory Snapshot (2026-04-24)

From the pre-plan grep:

- 23 files import `edges` / `edgeEmbeddings` / `EdgeType` / `EdgeTypeEnum`.
- 9 write sites (LLM-authored extraction, system-authored Atlas/Dream/day nodes, manual APIs, cleanup).
- 10 read sites (search, graph query, cleanup, atlas routes).
- 2 core search primitives: `findSimilarEdges`, `findOneHopNodes` in `src/lib/graph.ts`.
- 3 manual `/edge/*` routes.
- TypeID prefixes: `edge → "edge"`, `edge_embedding → "eemb"` in `src/types/typeid.ts`.
- Existing edge tests: none dedicated. Incidental coverage via `atlas-improvements.test.ts` and ingestion tests.
- System-authored edges that are not LLM extraction: `src/lib/atlas.ts:164` (Atlas `OWNED_BY`), `src/lib/ingestion/ensure-source-node.ts:85` (`OCCURRED_ON` day linkage), `src/lib/jobs/dream.ts:247` (Dream `OWNED_BY`).

---

## Phase 1 — Schema + Provenance Backbone

**Goal.** All factual memory lives in `claims`, sourced and lifecycle-capable, while external behavior is unchanged. Extraction still emits edge-shaped output internally; an adapter translates to claim inserts. Every existing consumer reads from `claims`. `/edge/*` routes replaced by `/claim/*`.

**Out of scope this phase.** New attribute predicates, supersession, profile synthesis, identity upgrade, cleanup rewrites, evals. Those are Phases 2–4.

### Task breakdown (execution order)

1. **Types & TypeID prefixes.** `src/types/typeid.ts`: add `"claim"`, `"claim_embedding"` to `ID_TYPE_NAMES`; add prefixes `claim: "claim"`, `claim_embedding: "cemb"`. Keep `"edge"` / `"edge_embedding"` entries present until step 13.

2. **New type exports.** `src/types/graph.ts`:

   - Add `ClaimStatusEnum`, `ClaimStatus` type.
   - Add `AttributePredicateEnum` (even though extraction doesn't emit attributes yet — schema & API need it).
   - Add `RelationshipPredicateEnum`, `PredicateEnum`.
   - Extend `SourceType` with `"legacy_migration"` and `"manual"`.
   - Keep `EdgeTypeEnum` / `EdgeType` exports alive for now; they're used transiently by the extraction adapter in step 8.

3. **Schema migration (DDL).** New drizzle migration file. Ordered SQL:

   1. `ALTER TABLE edges RENAME TO claims`.
   2. Rename columns: `source_node_id` → `subject_node_id`; `target_node_id` → `object_node_id` (nullable); `edge_type` → `predicate` (widen to `varchar(80)`).
   3. Add columns: `object_value text`, `statement text`, `source_id typeid-ref`, `stated_at timestamp`, `valid_from timestamp`, `valid_to timestamp`, `status varchar(30) default 'active'`, `updated_at timestamp default now()`.
   4. Drop `UNIQUE(source_node_id, target_node_id, edge_type)`.
   5. `DELETE FROM claims WHERE predicate IN ('MENTIONED_IN', 'CAPTURED_IN', 'INVALIDATED_ON')`.
   6. Create one synthetic `legacy_migration` source per user (via `INSERT ... SELECT DISTINCT user_id FROM claims` into `sources`).
   7. Backfill per remaining row: `statement` = templated sentence joined from `node_metadata`; `source_id` = user's legacy source; `stated_at` = `created_at`; `status` = `'active'`; `updated_at` = `created_at`; `metadata = coalesce(metadata, '{}'::jsonb) || '{"backfilled": true}'::jsonb`.
   8. Apply `NOT NULL` to `statement`, `source_id`, `stated_at`, `status`.
   9. `CHECK` constraints on object shape.
   10. Indexes: `(user_id, status, stated_at)`, `(user_id, subject_node_id, status)`, partial `(user_id, object_node_id, status)` WHERE `object_node_id IS NOT NULL`, `(source_id)`.
   11. `ALTER TABLE edge_embeddings RENAME TO claim_embeddings`; `RENAME COLUMN edge_id TO claim_id`.
   12. `UPDATE claims SET id = replace(id, 'edge_', 'claim_')`; `UPDATE claim_embeddings SET id = replace(id, 'eemb_', 'cemb_'), claim_id = replace(claim_id, 'edge_', 'claim_')`.
   13. `ALTER TABLE aliases ADD COLUMN normalized_alias_text text`; backfill `trim(lower(alias_text))`; add `UNIQUE(user_id, normalized_alias_text, canonical_node_id)`.

   Make the migration **idempotent by check**: guard each step with `IF NOT EXISTS` / `IF EXISTS` / column-existence checks so rerunning after partial failure is safe.

4. **Schema definition update.** `src/db/schema.ts`:

   - Rename exported `edges` → `claims` table with new columns.
   - Rename `edgeEmbeddings` → `claimEmbeddings`, `edge_id` → `claimId`.
   - Add `aliases.normalizedAliasText` column and the new unique constraint.
   - Relations: rename and wire `sourceId` → `sources`. Keep legacy export aliases (`export const edges = claims`) **temporarily** to narrow the blast radius; remove in step 12.

5. **Edge → claim core library rename.** `src/lib/edge.ts` → `src/lib/claim.ts`:

   - `createEdge` → `createClaim`; add required `sourceId` (manual API uses the per-user `manual` source — auto-create on first call).
   - `updateEdge` → `updateClaim`; restrict to `status` transitions per design (only `active → retracted` from user input).
   - `deleteEdge` → `deleteClaim`.
   - Keep existing embedding upsert logic; point at `claimEmbeddings`.

6. **Graph search primitives.** `src/lib/graph.ts`:

   - `findSimilarEdges` → `findSimilarClaims` with `FindSimilarClaimsOptions` (statuses, asOf, subjectNodeIds, includePastValid). Default filter: `status IN ('active')` AND (`valid_to IS NULL OR valid_to > asOf`).
   - `findOneHopNodes` queries claims in subject-or-object position, filtered by `status = 'active'` and validity window.
   - Embedding text for claims excludes node labels: `{predicate} {statement} status={status} statedAt={statedAt}`. Implemented in `src/lib/embeddings-util.ts`.

7. **Every call site updated.** Mechanical rename pass. Groups:

   - `src/lib/extract-graph.ts`, `src/lib/atlas.ts`, `src/lib/ingestion/ensure-source-node.ts`, `src/lib/jobs/dream.ts`, `src/lib/jobs/cleanup-graph.ts`, `src/lib/jobs/deep-research.ts`.
   - `src/lib/query/graph.ts`, `src/lib/query/search.ts`, `src/lib/query/day.ts`.
   - `src/routes/query/atlas-nodes.ts`, `src/routes/query/graph.ts`, `src/routes/query/search.ts`, `src/routes/query/day.ts`, `src/routes/node/neighborhood.post.ts`, `src/routes/node/get.post.ts`, `src/routes/node/type.ts`.
   - `src/lib/schemas/edge.ts`, `…/node.ts`, `…/query-day.ts`, `…/query-graph.ts`, `…/query-search.ts`. Schemas export claim-shaped types; reuse `PredicateEnum`.
   - `src/lib/node.ts:396` raw-SQL DELETE — port to drizzle querybuilder on `claims` so predicate renames are statically checked.

8. **Extraction adapter (the only non-rename behavior change in Phase 1).** `src/lib/extract-graph.ts`: the LLM output schema still contains `edges: LLMEdge[]`; the post-processing loop now builds `claim` rows instead of `edge` rows. Mapping:

   - `sourceNodeId` → `subjectNodeId`.
   - `targetNodeId` → `objectNodeId`.
   - `edgeType` → `predicate` (string-equal since all kept edge types also appear in `RelationshipPredicateEnum`).
   - `description` → `statement` (templated sentence if missing), plus `description` column preserved.
   - `sourceId` = the conversation's/document's top-level source (the same one the conversation / document node links to). Chunk-level source refs come in Phase 2 alongside source-ref threading.
   - `statedAt` = the ingested source's timestamp (message `createdAt` for conversation messages once threading lands; for now, the parent source's `createdAt`).
   - `status` = `'active'`.
     This keeps Phase 1 compatible with the existing prompt.

9. **System-authored claims.** The three edges that aren't LLM-extracted become claims with appropriate sources:

   - `src/lib/atlas.ts:164` (Atlas node `OWNED_BY` user) → claim with a per-user `manual` source.
   - `src/lib/jobs/dream.ts:247` (Dream node `OWNED_BY` user) → same.
   - `src/lib/ingestion/ensure-source-node.ts:85` (`OCCURRED_ON` day linkage) → claim with the ingested source's id (conversation / document source) as `sourceId`.
     The per-user `manual` source row is auto-created on first use by a helper in `src/lib/sources.ts`.

10. **Manual API surface.**

    - New routes: `src/routes/claim/create.post.ts`, `src/routes/claim/update.post.ts`, `src/routes/claim/delete.post.ts`, `src/routes/alias/create.post.ts`, `src/routes/alias/delete.post.ts`.
    - Delete: `src/routes/edge/create.post.ts`, `src/routes/edge/update.post.ts`, `src/routes/edge/delete.post.ts`.
    - `src/routes/node/get.post.ts`: include the node's aliases in the response shape.
    - `src/routes/node/update.post.ts`: reject a `description` field in input (405 with clear message). Description writes go through trusted paths only (extraction seed, synthesis, cleanup).

11. **Source-ref threading stubs (partial — finish in Phase 2).** To avoid reshuffling the ingestion internals twice, land the plumbing now:

    - `src/lib/formatting.ts:22`: `formatConversationAsXml` reads an optional `externalMessageIds` parallel array and emits `id="{externalId}"` when present; falls back to sequential index otherwise.
    - `src/lib/ingestion/insert-new-sources.ts:79`: return `{ externalId: TypeId<"source"> }[]` for inserted child sources in addition to the existing IDs.
    - `src/lib/jobs/ingest-conversation.ts`: pass the map through but don't yet use per-message `sourceId` — extraction adapter still uses the parent source. Wiring ready for Phase 2.
      This way Phase 2 only has to flip the extraction schema and consume the map, not touch formatting / insert-sources again.

12. **Remove transitional exports.** Once the tree compiles, delete the `export const edges = claims` alias, drop `EdgeTypeEnum` / `EdgeType` from `src/types/graph.ts`, and delete `src/lib/schemas/edge.ts` (if any public consumers remain, re-export `PredicateEnum` under the old name and note the break in a commit message).

13. **Migration idempotency test.** A drizzle migration test that:
    - Seeds a fresh DB, applies migrations, asserts `claims` exists with the full column set and none of the old column names remain.
    - Seeds a synthetic "pre-migration" state (a minimal `edges` table snapshot), applies the migration, asserts row counts, sample statements, `legacy_migration` source existence, and backfilled `metadata.backfilled = true`.
    - Re-runs the migration on the already-migrated DB and asserts it's a no-op (idempotent).

### Phase 1 acceptance gate

- `pnpm run type-check`, `pnpm run lint`, `pnpm run test` clean.
- Drizzle migration applies on a clone of prod and rolls back cleanly from a pre-migration snapshot.
- All existing ingestion, query, and atlas-nodes routes return payloads equivalent (under the rename) to pre-Phase-1 behavior — a golden-file test per route is sufficient.
- Reprocessing a source replaces its claims idempotently (first new acceptance check enforced by test).
- `/edge/*` routes return 404; `/claim/*` routes pass round-trip create/update/delete tests.
- `metadata.backfilled = true` on 100% of legacy rows.

### Phase 1 PR slicing

Either one PR or two:

- **Option A (single PR):** everything above. Big, reviewable, but the intermediate states during code review don't matter.
- **Option B (two PRs):** PR 1a = steps 1–4 (schema + typeid + schema.ts + types/graph.ts) with `edges = claims` transitional alias keeping all consumers green; PR 1b = steps 5–13 (all consumer rewrites, route cutover, transitional-alias removal). I recommend 1a+1b; PR 1a is small, reviewable, and de-risks the data migration before touching 20+ files.

---

## Phase 2 — Claims-Native Extraction + Lifecycle + Alias Authoring

**Goal.** Extraction emits claim-native output (relationships, attributes, aliases); lifecycle engine runs; source-scoped replacement closes the idempotency loop.

### Task breakdown

1. **Extraction LLM schema.** `src/lib/extract-graph.ts`:

   - Replace edge-shaped output with `llmExtractionSchema` from the design doc (`nodes`, `relationshipClaims`, `attributeClaims`, `aliases`).
   - `llmNodeSchema.description` optional (seed description, see design).
   - Parse with Zod; reject/repair partials per current error semantics.

2. **Prompt rewrite.** Update the extraction prompt to match the rules in the design doc (relationship vs. attribute split; alias emission; seed descriptions as gist, not episode; explicit `sourceRef` citation).

3. **Consume source-ref map.** Plumb `{ externalMessageId → internal sourceId }` from `ingest-conversation` into extraction; map each claim's `sourceRef` to a real internal id. Reject claims whose ref is unresolvable — do not silently attach to the parent source. Document ingestion continues to cite the document source id.

4. **Insertion flow.** Transaction per ingested source:

   1. Resolve candidate nodes (still label-only identity resolution; upgrade in Phase 3).
   2. Resolve source refs to sourceIds.
   3. If reprocessing: `DELETE FROM claims WHERE source_id = $1` first.
   4. Insert claims.
   5. Upsert aliases (normalized text, ON CONFLICT DO NOTHING via the unique constraint).
   6. Run lifecycle engine (below).
   7. Generate claim embeddings.
   8. Enqueue profile-synthesis job IDs (handler lands Phase 3; the enqueue is a no-op target for now, or we push to a Bull queue that has no worker yet — safer to just write a TODO marker + enqueue wired up with handler stub).

5. **Lifecycle engine.** New file `src/lib/claims/lifecycle.ts`:

   - Input: batch of newly inserted active claims.
   - For each claim with `predicate = 'HAS_STATUS'`: mark prior active `HAS_STATUS` on the same subject as `superseded`; set their `valid_to = new.stated_at`; set new claim's `valid_from = valid_from ?? stated_at`.
   - No action for multi-valued attribute predicates or relationship predicates (explicit `validTo` only).
   - All mutations go through drizzle with `updated_at = now()`.
   - Unit tests: single-valued supersession, multi-valued no-op, relationship no-op.

6. **Seed descriptions.** When extraction emits a `description` on a new node, write it to `node_metadata.description`. Existing nodes are untouched by extraction; profile synthesis takes over in Phase 3.

7. **Eval fixture scaffolding (not the full harness).** Create `src/evals/memory/` with one fixture: the "project starts, then completes" story. A single test that runs the ingestion pipeline end-to-end against the test DB and asserts that the second `HAS_STATUS` claim supersedes the first. This is the minimum viable proof that attribute lifecycle works. The other five stories land in Phase 4 alongside identity/cleanup.

### Phase 2 acceptance gate

- New ingestions produce `relationshipClaims`, `attributeClaims`, and `aliases` rows. Verified against a fixture transcript.
- Lifecycle test: second `HAS_STATUS` supersedes first; claim count = 2, active count = 1.
- Reprocessing acceptance check now passes against claim-native output (not just the Phase 1 adapter).
- `sourceRef` resolution: a fixture with a bad ref results in a rejected claim and a test-visible warning, not a silent attach.

---

## Phase 3 — Profile Synthesis + Identity Upgrade + Atlas Derivation

**Goal.** The compression loop runs: descriptions get rewritten from claims; duplicates shrink because identity resolution uses all four signals; Atlas is derived.

### Task breakdown

1. **Profile synthesis job.** `src/lib/jobs/profile-synthesis.ts`:

   - Triggered from the insertion flow when a node's active attribute claim set changes beyond the threshold (≥ 1 new attribute claim or any supersession).
   - Inputs: prior description, all active attribute claims on the node, up to N high-centrality relationship claims (N configurable, start at 10), the node's aliases.
   - LLM call: prompt enforces "durable profile, not recent-events log" and "no inventing facts."
   - Writes `node_metadata.description`; logs inputs + output for audit.
   - Idempotent: running twice with unchanged inputs produces the same output (or is skipped via content hash).

2. **Identity resolution upgrade.** `src/lib/extract-graph.ts` (or extract into `src/lib/identity-resolution.ts`):

   - Signal 1: existing `(userId, nodeType, canonicalLabel)` exact match.
   - Signal 2: alias match — `SELECT canonical_node_id FROM aliases WHERE user_id=$1 AND normalized_alias_text=$2` joined against nodeType.
   - Signal 3: embedding similarity — reuse existing node embeddings; add helper `findSimilarNodeIds(candidateEmbedding, { userId, nodeType, minScore })`; thresholds 0.85 / 0.7 configurable via env.
   - Signal 4: claim-profile compatibility — new helper that compares provisional claims against the existing node's active claims (overlap, no contradictions on `HAS_STATUS` or strong relationship predicates).
   - Apply signals in cheapness order; short-circuit on merge decision.
   - Log decision trace per candidate for eval harness replay.

3. **Background re-evaluation pass.** After each ingestion, enqueue a per-affected-node job that tests the node's updated claim profile against other existing nodes of the same type via signals 3+4. Positive hits → enqueue a cleanup proposal (no auto-merge).

4. **Atlas derivation.** Rewrite `src/lib/jobs/atlas-user.ts`:

   - Query active `HAS_PREFERENCE`, `HAS_GOAL`, `HAS_STATUS` claims for the user.
   - Rank by subject centrality (count of touching relationship claims) and time-in-effect.
   - LLM synthesis over the top-K into a compact narrative (top-level system prompt budget: ~500 tokens).
   - Concatenate with `userProfiles.content` (pinned override).
   - Write to the existing Atlas node's description.
   - Trigger: on schedule (nightly) + after significant ingestion events (enqueued from insertion flow when total active-claim delta per user crosses a threshold).

5. **Node formatting with aliases.** `src/lib/formatting.ts`: node-format helper batches alias lookups and emits `Label (also: alias1, alias2)`. Used by search response formatting (`src/lib/query/search.ts`) and wherever else nodes go to a downstream LLM.

### Phase 3 acceptance gate

- Profile synthesis produces a description that references only supported claims (verified by an LLM-as-judge eval or regex-checked against the claim set for a fixture).
- Identity resolution test suite: the "nickname + full name" and "rename" stories merge correctly; a contradicting-profile case does not merge.
- Atlas output on a seeded graph surfaces the expected preferences/goals/statuses and omits low-centrality claims.
- Node-format output in search includes alias annotations.

---

## Phase 4 — Cleanup + Evals

**Goal.** Close the loop. Dedup and cleanup work end-to-end over claims; the full six-story regression suite is green; observability makes regressions catchable.

### Task breakdown

1. **Dedup sweep rewrite.** `src/lib/jobs/dedup-sweep.ts` (new `rewireNodeClaims`, `rewireNodeAliases`):

   - On merge: update `claims.subject_node_id` and `claims.object_node_id` from removed to kept.
   - Dedup resulting duplicates (same `subjectNodeId`, `predicate`, `objectNodeId | objectValue`, `sourceId`), keep earliest `createdAt`.
   - Rewire aliases: update `canonical_node_id`; insert removed node's label (and existing aliases) as aliases on kept node; conflicts dropped by unique constraint.
   - No claim-embedding regeneration needed (embedding text excludes node labels).

2. **LLM cleanup rewrite.** `src/lib/jobs/cleanup-graph.ts`:

   - New operation vocabulary: `merge_nodes`, `retract_claim`, `contradict_claim` (with citation), `add_claim` (via cleanup's synthetic source), `add_alias`, `remove_alias`.
   - Prompt rewrites: Atlas consumed as structured persistent context (not free-text narrative); contradiction detection examples in the prompt for multi-valued predicates; description rewrites treated as derived summaries (instructions match the design doc's cleanup section).
   - Backward-incompatible change to the cleanup operation schema — update the Zod schema and the prompt in lockstep; add fixture-level tests for each operation.

3. **Full eval harness.** `src/evals/memory/`:

   - All six regression stories as fixtures (transcripts + expected post-ingestion state).
   - Helper `runIngestionEval(fixture)` that seeds a test DB, runs ingestion, asserts claim counts, statuses, node labels, alias sets.
   - Threshold-calibration sub-harness: sweep identity-resolution thresholds over a small grid and print merge-correctness per threshold so calibration is data-driven.
   - Runs as part of `pnpm run test` via `@evals/*` suite tag (opt-in with `--tag eval` for local, required in CI).

4. **Observability.** Structured logs at key transitions:
   - `claim.inserted`, `claim.superseded`, `claim.contradicted`, `claim.retracted`.
   - `identity.resolved` with decision trace (which signal matched, scores).
   - `atlas.derived` with input claim count and output token count.
   - `profile.synthesized` with input claim count and content hash.
   - Align with existing telemetry naming conventions in the project.

### Phase 4 acceptance gate

- All six regression-story tests pass.
- A seeded graph with intentional duplicates runs through dedup + cleanup and results in the expected canonical state (fixture-driven).
- Contradiction detection test: two coexisting `HAS_PREFERENCE` claims in conflict → cleanup emits `contradict_claim` with a citation; manual review unnecessary.
- Threshold-calibration output is reviewable in CI artifacts so we can iterate in follow-up PRs without code changes.

---

## Cross-Phase Concerns

### Database & environments

- Migrations always run in CI against a fresh DB and against a pre-Phase-1 snapshot fixture. Both must succeed.
- The test DB uses a non-default Postgres port per CLAUDE.md; all new eval tests follow that convention.
- Production migration is a one-time operation per user. Run it during a low-traffic window with the ingestion queue paused to avoid double-inserts during the rename.

### Backward compatibility (external)

- `edge_*` TypeIDs in external systems will not resolve after Phase 1. This is an acknowledged break per the design doc. Communicate before the cut.
- The SDK (see `0.7.0` version tag in recent commits) needs a coordinated release that drops `/edge/*` and adds `/claim/*` / `/alias/*`. SDK work is a direct dependency of Phase 1 and should be scoped alongside it.

### Observability / rollback

- Rollback from Phase 1 is hard because the DDL rename is destructive. Mitigations:
  - Take a full DB snapshot immediately before the migration runs.
  - Keep the Phase 1 migration PR gated behind a feature branch; merge only after a dry-run against a prod-clone database succeeds.
  - Restore path is `pg_restore` + code rollback; not a runtime toggle.
- Rollback from Phases 2–4 is just a code revert; data remains valid under the schema.

### Known traps

- **Raw SQL DELETE in `src/lib/node.ts:396`** hits `edges.target_node_id` directly. It has to move to the drizzle querybuilder and the renamed column in Phase 1, or the next migration will not find the column and it'll fail silently depending on how it's executed.
- **System-authored edges** in `atlas.ts`, `dream.ts`, `ensure-source-node.ts` are easy to miss because they're not in the extraction path. They need sources attached in Phase 1 or the `NOT NULL` constraint bites.
- **Claim embedding text** must drop node labels. If we accidentally include them, merges will invalidate embeddings and we lose the win that justifies the decoupling.
- **Source-ref threading** touches XML formatting. Preserving both the existing sequential-index fallback and the new external-id path avoids breaking downstream LLM prompts that reference `<message id="0">` implicitly.
- **Manual source auto-creation** must be idempotent per user (lookup or create), or we'll leak duplicate `manual` sources.

### PR cadence estimate

- Phase 1: 1 large PR (split into 1a/1b if review capacity is tight).
- Phase 2: 1 PR (extraction schema + lifecycle + alias authoring are cohesive).
- Phase 3: 2 PRs — (a) profile synthesis + Atlas derivation; (b) identity upgrade + background re-eval. Splittable because (a) and (b) touch different files and both leave the system green.
- Phase 4: 1–2 PRs — cleanup rewrite and eval harness can land together or separately.

Total: 5–6 PRs to complete the architecture.
