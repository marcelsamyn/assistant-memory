# Claims-First Memory Layer — Implementation Plan

Companion to `docs/2026-04-24-claims-layer-design.md`. The design doc is the "what" and "why"; this is the "how" and "in what order."

## Principles

- Each phase leaves the system in a runnable, tested state. No half-migrated world in `main`.
- Schema and consumer code move together per phase. No dangling rename.
- Destructive DDL runs inside a single transactional migration per user. No live reads against half-renamed columns.
- Behavior-preserving refactors land first; behavior changes land on top of a green build. "Adapt, then evolve."
- Every phase has concrete acceptance gates tied to specific tests that must pass.
- **Every new field must land with its full operational contract** — producer, validation boundary, storage, lifecycle effects, atlas/retrieval defaults, read-surface rendering, MCP tool description (if applicable), and eval. A field without all rows in the contract matrix is not done.

## Revisions

### 2026-04-26 — refactor for registry, scope, provenance, tasks, read models

The design doc gained five concepts (predicate policy registry, scope, provenance, tasks/commitments, read models / context bundles). This plan absorbs them with two structural changes:

- **Phase 2 splits into 2a (landed) and 2b (this revision).** Phase 2b adds the registry, scope, and provenance foundations end-to-end before Phase 3 touches synthesis. This is deliberate — synthesis and read models depend on the new fields being present and queryable.
- **Phase 4 grows.** Transcript ingestion lands in Phase 4 (it leans on the Phase 3 identity upgrade). The cleanup rewrite gains a `promote_assertion` operation. Eval harness gains five new stories from the design doc.

Existing Phase 3 (synthesis + identity + atlas) keeps its shape but gains the read-model assembly layer, which sits on top of synthesis and the registry.

## Implementation Status (2026-04-26)

- **Phase 1 — schema + provenance backbone — LANDED.** Commits `0f0e04d`, `b598d59`, `a4d23fd`. Claims table, migration, typeid rewrite, alias normalization, `/claim/*` and `/alias/*` routes, system-authored claims for Atlas/Dream/day linkage. All consumers cut over.
- **Phase 2a — claims-native extraction + lifecycle v1 + alias authoring — LANDED.** Commit `f5d7181`. LLM extracts `nodes` + `relationshipClaims` + `attributeClaims` + `aliases`; source-ref threading via `formatConversationAsXml` + `insertNewSources`; source-scoped replacement; `applyClaimLifecycle` for `HAS_STATUS` supersession; alias upsert.
- **Phase 2b — registry + scope + provenance + tasks foundation — IN PROGRESS.** Registry, additive schema fields, registry-driven lifecycle, default scope/provenance retrieval filters, `getOpenCommitments`, `POST /commitments/open`, and MCP `list_open_commitments` are implemented in the working tree. Extraction `assertionKind`, `currentlyOpenTasks` prompt injection, and tool-description snapshots remain. The 2b.9 invalidation hook is deferred to Phase 3 (no cache to invalidate yet).
- **Phase 3 — profile synthesis + identity upgrade + atlas derivation + read-model assemblers + MCP tools — NOT STARTED.** Existing Phase 3, expanded.
- **Phase 4 — transcript ingestion + cleanup rewrite + full eval harness — NOT STARTED.** Existing Phase 4, expanded.

## Inventory Snapshot (current state, partial 2b)

- `claims`, `claim_embeddings`, `scope`, `assertedByKind`, `assertedByNodeId`, `supersededByClaimId`, and `contradictedByClaimId` schemas live; `aliases.normalized_alias_text` + unique constraint live.
- Extraction emits `relationshipClaims`, `attributeClaims`, `aliases` (`src/lib/extract-graph.ts`). `assertionKind` is **not** yet emitted; speaker map is **not** yet plumbed; `currentlyOpenTasks` injection is **not** yet plumbed.
- Predicate-policy registry exists; lifecycle handles registry-driven `single_current_value` predicates including `HAS_STATUS` and `HAS_TASK_STATUS`.
- Default semantic claim, one-hop, and node search paths exclude reference-scope and assistant-inferred personal claims unless explicitly opted in.
- Full context bundles do not exist yet. The first read model exists: `getOpenCommitments` with `POST /commitments/open` and MCP `list_open_commitments`. Atlas is still a single artifact (`src/lib/atlas.ts`, `src/lib/jobs/atlas-user.ts`).
- Manual API `/claim/*`, `/alias/*` live; `/transcript/ingest` does not exist.
- MCP server (`src/lib/mcp/mcp-server.ts`) exposes existing query tools plus `list_open_commitments`; no `bootstrap_memory` or `search_reference` tools yet.

---

## Phase 1 — Schema + Provenance Backbone (LANDED)

Reference only. See git log for details. The original Phase 1 task breakdown is preserved in the prior revision of this document.

Acceptance gates met:

- `pnpm run type-check`, `pnpm run lint`, `pnpm run test` clean on the post-Phase-1 commit.
- Drizzle migrations applied; `legacy_migration` source created per user; `metadata.backfilled = true` on all backfilled rows.
- `/edge/*` routes return 404; `/claim/*` round-trips green.

---

## Phase 2a — Claims-Native Extraction + Lifecycle + Alias Authoring (LANDED)

Reference only. Commit `f5d7181`.

Acceptance gates met:

- New ingestions produce `relationshipClaims`, `attributeClaims`, and `aliases` rows.
- `HAS_STATUS` supersession test passes.
- Reprocessing-same-source replaces idempotently.
- Unresolvable `sourceRef` results in claim rejection with a logged warning.

---

## Phase 2b — Registry + Scope + Provenance + Tasks Foundation (NEW)

**Goal.** Land the three claim-level fields (`scope`, `assertedByKind` + `assertedByNodeId`, `supersededByClaimId` + `contradictedByClaimId`), the predicate policy registry, and the Task/HAS_TASK_STATUS shape. Wire each through extraction, lifecycle, and the existing read paths so nothing is "stored but ignored." Read-model assemblers and their insertion-flow invalidation hooks are both deferred to Phase 3 — there is no consumer cache to invalidate yet, so a stub hook would be speculative.

**Out of scope this phase.** Profile synthesis, identity-resolution upgrade, Atlas derivation rewrite, transcript ingestion, cleanup rewrite, full eval harness. Those are Phases 3–4.

### Task breakdown

#### 2b.1 — Predicate policy registry

Create `src/lib/claims/predicate-policies.ts`:

- Export `PredicatePolicy` type, `PREDICATE_POLICIES` const map (one entry per `Predicate`).
- Add `HAS_TASK_STATUS` to `AttributePredicateEnum` in `src/types/graph.ts`.
- Add `DUE_ON` to `RelationshipPredicateEnum`.
- Add `Task` to `NodeTypeEnum`.
- Add `TaskStatusEnum` (z.enum of `pending | in_progress | done | abandoned`).
- Compile-time check: every `Predicate` value has a registry entry (use a mapped type that fails to compile on missing keys).

Unit test: `predicate-policies.test.ts` asserts the registry is exhaustive and that key invariants hold (e.g., `single_current_value` predicates always have `lifecycle = 'supersede_previous'`).

#### 2b.2 — Schema migration (additive)

New drizzle migration. Forward-only; no destructive changes.

```sql
ALTER TABLE sources ADD COLUMN scope varchar(16) NOT NULL DEFAULT 'personal';
ALTER TABLE sources ADD CONSTRAINT sources_scope_ck CHECK (scope IN ('personal','reference'));

ALTER TABLE claims ADD COLUMN scope varchar(16) NOT NULL DEFAULT 'personal';
UPDATE claims c SET scope = s.scope FROM sources s WHERE c.source_id = s.id AND c.scope <> s.scope;
ALTER TABLE claims ADD CONSTRAINT claims_scope_ck CHECK (scope IN ('personal','reference'));

ALTER TABLE claims ADD COLUMN asserted_by_kind varchar(24);
ALTER TABLE claims ADD COLUMN asserted_by_node_id text REFERENCES nodes(id) ON DELETE SET NULL;
-- Backfill rules:
UPDATE claims SET asserted_by_kind = 'system'
  FROM sources s
  WHERE claims.source_id = s.id AND s.type IN ('manual')
    AND claims.predicate IN ('OWNED_BY','OCCURRED_ON');
UPDATE claims SET asserted_by_kind = 'user' WHERE asserted_by_kind IS NULL;
ALTER TABLE claims ALTER COLUMN asserted_by_kind SET NOT NULL;
ALTER TABLE claims ADD CONSTRAINT claims_asserted_by_kind_ck CHECK (
  asserted_by_kind IN ('user','user_confirmed','assistant_inferred','participant','document_author','system')
);
ALTER TABLE claims ADD CONSTRAINT claims_asserted_by_node_consistency_ck CHECK (
  (asserted_by_kind = 'participant' AND asserted_by_node_id IS NOT NULL)
  OR (asserted_by_kind <> 'participant')
);

ALTER TABLE claims ADD COLUMN superseded_by_claim_id text REFERENCES claims(id) ON DELETE SET NULL;
ALTER TABLE claims ADD COLUMN contradicted_by_claim_id text REFERENCES claims(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS claims_user_scope_status_stated_at_idx ON claims (user_id, scope, status, stated_at);
CREATE INDEX IF NOT EXISTS claims_user_scope_kind_status_idx ON claims (user_id, scope, asserted_by_kind, status);
DROP INDEX IF EXISTS claims_user_id_status_stated_at_idx;
```

Each statement guarded by `IF NOT EXISTS` / column-existence check; the migration test re-runs the migration on a migrated DB and asserts no-op.

Update `src/db/schema.ts` to reflect the new columns; update relations for `assertedByNode` (one-to-one nullable to `nodes`).

Reuse the existing migration test pattern from `src/db/migrations-claims.test.ts`.

#### 2b.3 — Source registration: `scope` at the API boundary

- Update `src/lib/schemas/...` for `POST /source/register` (or whatever the current source-creation surface is — there isn't a public one yet; sources are created internally by `insertNewSources` and `ensureSourceNode`). For internal callers:
  - `insertNewSources` accepts a `scope` parameter; default `personal`. Conversation/message ingestion always passes `personal`.
  - Document ingestion (`src/lib/jobs/ingest-document.ts`): the existing `POST /ingest/document` request schema gains a `scope?: 'personal' | 'reference'` field, default `personal`. Plumb through to source insert.
- `ensureSourceNode` for system sources (`legacy_migration`, `manual`) hardcodes `personal`.

#### 2b.4 — Claim insert path: stamp `scope` and accept provenance

In `src/lib/extract-graph.ts:_processAndInsertLlmClaims`:

- For each claim insert, look up the source's `scope` (cached per-source within the call) and stamp `claims.scope`.
- Accept `assertionKind` and `assertedBySpeakerLabel` from the LLM output (see 2b.5). Resolve `participant` labels to `nodeId` via the speaker map (empty map for current two-party conversations — falls back to either `user` or `assistant_inferred` based on the existing user-only extraction rule).
- Reject claims with `participant` kind and unresolvable label (warn + skip).

In `src/lib/claim.ts:createClaim` (manual API):

- Hardcode `assertedByKind = 'user'`, `scope = 'personal'`.

In system-claim sites (`src/lib/atlas.ts`, `src/lib/jobs/dream.ts`, `src/lib/ingestion/ensure-source-node.ts`):

- Pass `assertedByKind = 'system'`, `scope = 'personal'`.

#### 2b.5 — Extraction LLM schema: emit `assertionKind`

In `src/lib/extract-graph.ts`:

- Extend `llmRelationshipClaimSchema` and `llmAttributeClaimSchema` with required `assertionKind: AssertedByKindEnum` and optional `assertedBySpeakerLabel: z.string()`.
- Update the prompt to define the kinds explicitly. Two-party conversation rules:
  - User-stated claims → `assertionKind: "user"`.
  - User-confirmed-an-assistant-statement (explicit "yes," "right," etc.) → `assertionKind: "user_confirmed"`.
  - Anything else (assistant-only assertions) → still not extracted by default. If the model decides to extract one, it MUST set `assertionKind: "assistant_inferred"`.
- Document ingestion: LLM emits `assertionKind: "document_author"`.
- Add few-shot examples to the prompt for each kind.

Compile/runtime: validate post-LLM that `assertionKind = 'participant'` does not appear in two-party conversation extraction (no speaker map → reject).

#### 2b.6 — Lifecycle engine: registry-driven

In `src/lib/claims/lifecycle.ts`:

- Replace `statusLifecycleSubjects` with `singleCurrentValueSubjects` that consults `PREDICATE_POLICIES` and yields `(userId, subjectNodeId, predicate)` triples for any predicate where `cardinality = 'single_current_value'` and `lifecycle = 'supersede_previous'`.
- `recomputeStatusLifecycleForSubject` is renamed `recomputeSingleValuedLifecycleForSubject` and takes the predicate as a parameter.
- Sort tiebreaker: among ties, prefer `assertedByKind` of `user`/`user_confirmed` over `participant` over `document_author` over `assistant_inferred` over `system`.
- Trust rule: if the latest claim by `statedAt` is `assertedByKind = 'assistant_inferred'` AND any prior claim (by `statedAt`) for the same `(user, subject, predicate)` is `assertedByKind ∈ {user, user_confirmed}`, the new claim is demoted to `superseded` immediately and the prior remains active.
- On supersession, set `supersededByClaimId = nextClaim.id`. Set `validTo = nextClaim.statedAt`.

Tests:

- Existing `HAS_STATUS` tests must still pass.
- New tests: `HAS_TASK_STATUS` supersession, trust-rule rejection of `assistant_inferred` over `user`, sort-tiebreaker behavior.

#### 2b.7 — Tasks: extraction + identity context injection + lifecycle

- Add `Task` to allowed node types in extraction prompt; instruct the model to create Task nodes for explicit commitments / todos / "will do X by Y."
- Add `HAS_TASK_STATUS` to the AttributePredicateEnum surfaced to the LLM, with prompt rules for when to emit it.
- Plumb `currentlyOpenTasks` into the extraction call:
  - Before the LLM call, query the user's open tasks: `SELECT t.id, t.label, owner.label, due.value, latest.stated_at FROM nodes t JOIN claims latest ON ... WHERE t.type='Task' AND latest.predicate='HAS_TASK_STATUS' AND latest.status='active' AND latest.object_value IN ('pending','in_progress')`. Cap at 20.
  - Render into the prompt under "Currently open tasks" with a clear instruction: "If the source mentions completing, abandoning, or progressing one of these existing tasks, emit a `HAS_TASK_STATUS` attribute claim on that task's id rather than creating a new Task node."
- Lifecycle: `HAS_TASK_STATUS` now goes through 2b.6's registry-driven engine; supersession just works.

#### 2b.8 — Read paths: scope + assertedBy in default filters

In `src/lib/graph.ts` and `src/lib/query/search.ts`:

- Add default `WHERE` clauses: `claims.scope = 'personal'` and `claims.asserted_by_kind <> 'assistant_inferred'`.
- Add opt-in options `includeReference` and `includeAssistantInferred` to `FindSimilarClaimsOptions` for explicit deep paths.
- Add default scope filtering to `findSimilarNodes` as well. Node results must be eligible only when the node has personal-scope support through `sourceLinks -> sources` or through an active personal-scope claim touching the node. A node supported only by reference sources/claims must not appear in default `searchMemory`.
- Update existing callers: pass-through behavior preserved (defaults match prior hidden defaults plus the new filters).

In `src/routes/query/search.ts` and friends: nothing changes externally; the route's response now omits `assistant_inferred` claims in the default mode.

In `src/routes/node/get.post.ts` and `src/routes/node/neighborhood.post.ts`: continue to return raw claim data including `scope` and `assertedByKind` (visualization callers depend on this — explicitly NOT filtering on those endpoints).

#### 2b.9 — `getOpenCommitments` and `open_commitments` invalidation hook

New file `src/lib/query/open-commitments.ts`:

- `getOpenCommitments(userId, { ownedBy?, dueBefore? })`: reads each Task node's newest active personal non-inferred `HAS_TASK_STATUS` claim, filters that latest status to `pending`/`in_progress`, and returns `{ taskId, label, owner, dueOn, statedAt, sourceId }[]`.
- New route `POST /commitments/open` that calls it; new MCP tool `list_open_commitments` registered in `src/lib/mcp/mcp-server.ts` with the description from the design doc.

Insertion-flow invalidation hook — **deferred (Phase 3)**:

- Originally specified to fire a `read_model_invalidate(userId)` event after `applyClaimLifecycle` for any claim with `forceRefreshOnSupersede = true`. Deferred to Phase 3 alongside bootstrap cache introduction; no cache layer exists yet (only `src/lib/cache/deep-research-cache.ts`, unrelated), so a stub adds noise without value. Phase 3 will wire the hook and the consuming read-model assemblers together.

Tests:

- Insert pending Task; bootstrap-equivalent query returns it.
- Insert done supersession; same query no longer returns it; `recent_supersessions` (Phase 3) will pick it up. Include the defensive case where an older active `pending` row still exists, so the read model proves it keys off the newest status rather than any open-looking status.
- `assistant_inferred` `HAS_TASK_STATUS` cannot supersede a `user` one (covered by 2b.6 tests; reassert at API level).

#### 2b.10 — MCP tool descriptions for the new APIs

Update `src/lib/mcp/mcp-server.ts`:

- Add `list_open_commitments` tool with the design-doc description.
- Existing search tools get scope-aware descriptions (no logic change yet; design doc text becomes the tool description).
- A regression test that asserts the registered tool descriptions match a snapshot — these strings are part of the design and shouldn't drift silently.

### Phase 2b acceptance gate

- `pnpm run type-check`, `pnpm run lint`, `pnpm run test` clean.
- Migration applies idempotently; backfill leaves every claim with non-null `assertedByKind` and correct `scope`.
- Extraction emits `assertionKind` per claim; default search excludes `assistant_inferred`.
- Tasks created from a fixture conversation have `HAS_TASK_STATUS=pending`; a follow-up conversation that says "I sent the spec" produces a `done` claim that supersedes the prior; `getOpenCommitments` no longer returns the task; `supersededByClaimId` is set.
- A reference-scope document ingestion test produces claims with `scope=reference`; default `searchMemory` does not return them; `searchMemory({ includeReference: true })` does.
- Default `searchMemory` does not return reference-only node hits from `similarNodes`, not just reference claims. This is the regression that the 2026-04-26 consumer-contract reflection caught.
- Trust rule test: an `assistant_inferred` claim cannot supersede a `user` one.
- Visualization endpoints (`/node/get`, `/node/neighborhood`, `/query/graph`, `/query/timeline`) return claim data including `scope` and `assertedByKind`.

### Phase 2b PR slicing

Recommended split:

- **PR 2b-i**: registry + schema migration + scope/provenance columns + claim-insert wiring + system-claim updates. Tree compiles and behaves identically because no read path filters yet.
- **PR 2b-ii**: extraction `assertionKind` + lifecycle generalization + trust rule. The `HAS_STATUS` supersession test still passes; new tests added.
- **PR 2b-iii**: Tasks (node type, predicate, prompt updates, currentlyOpenTasks injection) + `getOpenCommitments` + MCP tool + default search filters. (Invalidation hook deferred to Phase 3 — see 2b.9.)

Three reviewable PRs is the right granularity; one giant PR risks losing the wiring story in review.

---

## Phase 3 — Profile Synthesis + Identity Upgrade + Atlas Derivation + Read-Model Assemblers

**Goal.** The compression loop runs (descriptions get rewritten from claims; duplicates shrink). Atlas and the read-model context bundles are assembled and shipped via MCP/SDK.

### Phase 3 prerequisites

- Predicate policy must support `(predicate, subjectType)` cardinality before read-model assemblers (evidence, atlas) can rely on active-only filters; OWNED_BY/DUE_ON on Tasks specifically need single-current-value semantics. **Done.** Registry now carries `subjectTypeOverrides`; resolver `resolvePredicatePolicy(predicate, subjectType)` is the single entry point; lifecycle engine resolves `subjectType` from `nodes` and supersedes accordingly. Backfill: `drizzle/0012_claims_task_owned_by_due_on_backfill.sql` (idempotent SQL).

### Task breakdown

#### 3.1 — Profile synthesis job

`src/lib/jobs/profile-synthesis.ts`:

- Triggered from insertion when `personal`-scope active attribute claim set on a node changes by ≥1 attribute or any supersession.
- Inputs: prior description, active attribute claims (filtered by `assertedByKind ∈ {user, user_confirmed, system}` and `scope='personal'`), top-N relationship claims, aliases.
- LLM prompt enforces durable profile + no fact invention.
- Writes `node_metadata.description`. Idempotent via input content hash.
- Excludes `reference`-scope nodes from synthesis (reference nodes' descriptions come from extraction seed only).

Tests:

- Fixture node with mix of attribute claims; synthesis output references only those claims (LLM-as-judge or string-overlap check).
- Re-running with unchanged inputs: no LLM call (cache hit on hash).

#### 3.2 — Identity resolution upgrade (scope-bounded)

Extract from `src/lib/extract-graph.ts` into `src/lib/identity-resolution.ts`:

- Signal 1 (canonical label) — existing.
- Signal 2 (alias) — `SELECT canonical_node_id FROM aliases WHERE user_id=$1 AND normalized_alias_text=$2 AND <node-type-match>`. Speaker-mapping output writes here for transcripts.
- Signal 3 (embedding similarity) — thresholds via env. **Scope-bounded**: candidate's scope (from source) must match candidate node's scope.
- Signal 4 (claim profile compatibility) — weights claims by `assertedByKind`. Only `user`/`user_confirmed`/`system` claims contribute to profile compatibility.
- Cross-scope merge attempts return null (no merge); flagged as a cleanup signal.
- Decision trace logged for eval replay.

#### 3.3 — Background re-evaluation pass

After ingestion, enqueue per-affected-node job that runs signals 3+4 against existing nodes of same type AND same scope. Positive hits → cleanup-pipeline proposal (no auto-merge).

#### 3.4 — Atlas derivation (registry-driven)

Rewrite `src/lib/jobs/atlas-user.ts`:

- Query active claims with `feedsAtlas = true` (registry), `scope = 'personal'`, `assertedByKind ∈ {user, user_confirmed}`.
- Rank by subject centrality + time-in-effect.
- LLM synthesis to ~500 tokens.
- Concatenate with `userProfiles.content` (pinned override).
- Trigger: schedule + invalidation events from 2b.9 (now wired to a real handler).

#### 3.5 — Read-model assemblers (the `ContextBundle`)

New `src/lib/context/`:

- `assemble-bootstrap-context.ts`: returns `ContextBundle` with `pinned`, `atlas`, `open_commitments`, `recent_supersessions`, `preferences` sections.
- Each section has its own assembler that:
  - Queries claims via the registry's `retrievalSection` mapping.
  - Renders compact text + usage hint.
  - Stays under the section's token budget.
- `recent_supersessions` queries claims with `status IN ('superseded','contradicted','retracted')` and `updated_at > now() - interval '24 hours'` for predicates with `forceRefreshOnSupersede = true`. Renders as "you completed/marked X" lines.
- Cache layer: bundle cached per user; invalidated by the 2b.9 hook (now real).

#### 3.6 — Node card synthesis for the read API

`src/lib/context/node-card.ts`:

- Given a node id, returns the `NodeCard` shape (see design doc).
- `summary` from `node_metadata.description` (synthesis output).
- `currentFacts` from active `single_current_value` attribute claims.
- `preferencesGoals` from active `multi_value` attribute claims with `feedsAtlas`.
- `openCommitments` from `getOpenCommitments({ ownedBy: nodeId })` when `nodeId` is a Person.
- `recentEvidence`: top-N active claims, statement + sourceId.
- For `reference`-scope nodes: `reference: { author?, title? }` populated from source metadata.

Used by `getEntityContext`, `searchMemory`, `searchReference`.

#### 3.7 — Search API rewrite to return cards, not raw claims

Update `searchMemory` and create `searchReference`:

- Returns `{ cards: NodeCard[], evidence: ClaimEvidence[] }` instead of raw nodes + claims.
- Default scope `personal` for `searchMemory`; hardcoded `reference` for `searchReference`.
- Existing `/query/search` route preserved for raw output (visualization); new `POST /context/search` returns the card-shaped response. Coexist.

#### 3.8 — MCP tool surface

`src/lib/mcp/mcp-server.ts`:

- `bootstrap_memory` tool → `getConversationBootstrapContext`.
- `search_memory` → card-shaped `searchMemory` (personal default).
- `search_reference` → `searchReference`.
- `get_entity` → `getEntityContext`.
- `list_open_commitments` already added in 2b.10 — verify description.
- Tool descriptions snapshotted in tests.

#### 3.9 — Node formatting with aliases

`src/lib/formatting.ts`: node-format helper batches alias lookups, emits `Label (also: alias1, alias2)`. Used by all card-rendering helpers.

### Phase 3 acceptance gate

- Profile synthesis output references only supported claims (fixture).
- Identity resolution: nickname + full-name and rename stories merge correctly; cross-scope merge attempts return null; contradicting-profile cases do not merge.
- Atlas output on a seeded graph surfaces expected preferences/goals/statuses, omits low-centrality and reference-scope claims.
- `getConversationBootstrapContext` returns a bundle whose sections match the design's filter rules; total token budget respected.
- `recent_supersessions` lists task transitions from the prior 24h, including the regression-story task that just went `pending → done`.
- `searchReference` returns reference nodes; `searchMemory` does not.

### Phase 3 PR slicing

- **PR 3-i**: profile synthesis + identity upgrade + background re-eval. Self-contained; doesn't touch read APIs.
- **PR 3-ii**: Atlas derivation rewrite + read-model assemblers + node card synthesis.
- **PR 3-iii**: search API rewrite (cards) + MCP tools + tool-description snapshots. **Done.** `searchMemory` / `searchReference` return `{ cards, evidence }` via `getNodeCards` batch loader; new `POST /context/search` route coexists with raw `/query/search`. Reference docs gain optional `author`/`title` at ingest, surfacing on `NodeCard.reference`. MCP server replaces legacy `"search memory"` with snake_case `bootstrap_memory`, `search_memory`, `search_reference`, `get_entity` — all four descriptions pinned via inline snapshots. SDK gains `contextSearch()` and re-exports the new schemas.

---

## Phase 4 — Transcript Ingestion + Cleanup Rewrite + Full Eval Harness

**Goal.** Multi-party transcripts ingest cleanly with speaker provenance. Cleanup operates over claims with the new operation vocabulary including `promote_assertion`. Full six-plus-five regression suite green.

### Task breakdown

#### 4.1 — Transcript ingestion path

New `src/lib/jobs/ingest-transcript.ts`:

- Entry point `POST /transcript/ingest { content, scope = 'personal', knownParticipants?, userSelfAliases? }`.
- Pipeline:
  1. Detect/segment via LLM call (`segmentTranscript`) if input is raw text. Pre-segmented input passes through.
  2. Extract speaker labels.
  3. Resolve speakers: user-self via `userSelfAliases` (per-user config stored on `userProfiles.metadata`), then alias system, then create placeholder `Person` nodes with `metadata.unresolvedSpeaker = true`.
  4. Insert parent transcript source (`type: 'meeting_transcript'`) and per-utterance child sources (`type: 'conversation_message'` reuse — same shape).
  5. Each child source records `metadata.speakerNodeId`.
  6. Run extraction with speaker map injected; LLM emits `assertedBySpeakerLabel` per claim; resolver fills `assertedByNodeId`.
  7. Claims attributed to user-self collapse to `assertedByKind = 'user'`; others to `participant`.

Storage: speaker map persisted on each child source's metadata so re-extraction is deterministic.

#### 4.2 — `userSelfAliases` config

Tiny addition on `userProfiles` (or new `user_settings` table):

- `metadata.userSelfAliases: string[]` — labels by which the user appears in transcripts.
- API to set/update: `POST /user/self-aliases`.
- Used by transcript ingestion only.

#### 4.3 — Dedup sweep — scope-bounded + provenance-aware

Update `src/lib/jobs/dedup-sweep.ts`:

- `rewireNodeClaims`: refuse cross-scope merges.
- Dedup tiebreaking after rewiring: claims that differ only in `assertedByKind` are both kept; identical (subject, predicate, object, sourceId, kind, nodeId) → keep earliest.
- `rewireNodeAliases`: unchanged.

#### 4.4 — LLM cleanup rewrite

Update `src/lib/jobs/cleanup-graph.ts`:

- New operation vocabulary:
  - `merge_nodes` (scope-bounded; refuses cross-scope merges, logs).
  - `retract_claim`.
  - `contradict_claim` (citation required, sets `contradictedByClaimId`).
  - `add_claim` (`assertedByKind = 'system'`, scope inherits source's).
  - `add_alias` / `remove_alias`.
  - `promote_assertion` (NEW): given an `assistant_inferred` claim id and a corroborating `user` source, writes a new `user_confirmed` claim that supersedes (single-valued) or coexists (multi-valued).
- Prompt rewritten to use the bootstrap `ContextBundle` (Atlas + open commitments + preferences) as structured context.
- Prompt explicitly asks the model to flag `assistant_inferred` claims with no corroboration for `retract_claim`.
- Operation Zod schema updated; tests per operation.

#### 4.5 — Full eval harness

`src/evals/memory/`:

- All eleven regression stories (six original + five new):
  1. Project starts → completes (HAS_STATUS supersedes).
  2. Project rename via alias.
  3. Same person nickname + full name.
  4. Assistant suggestion not confirmed.
  5. User correction supersedes.
  6. Old current-state expires (validTo).
  7. **Pending task across sessions** (HAS_TASK_STATUS lifecycle end-to-end).
  8. **Assistant fabrication** (assertedByKind filtering).
  9. **Reference scope isolation** (book ingestion does not pollute personal context).
  10. **Multi-party transcript** (speaker attribution).
  11. **Cross-scope merge refused**.
- Helper `runIngestionEval(fixture)`: seeds DB, runs ingestion, asserts claim counts, statuses, scopes, kinds, alias sets.
- Threshold-calibration sub-harness: sweeps identity-resolution thresholds; CI artifact for review.

#### 4.6 — Observability

Structured logs + metrics:

- `claim.inserted` (with kind, scope).
- `claim.superseded` (with predicate, supersededByClaimId).
- `claim.contradicted` / `claim.retracted`.
- `identity.resolved` with decision trace + scope-bounded?.
- `atlas.derived` (input claim count, output token count).
- `profile.synthesized` (input claim count, content hash).
- `bootstrap_context.assembled` (sections, total tokens).
- `transcript.ingested` (utterance count, resolved/unresolved speakers).

#### 4.7 — Cleanup of placeholder transcript speakers

A Phase-4 maintenance job that surfaces placeholder `Person` nodes (`metadata.unresolvedSpeaker = true`) older than N days for cleanup-pipeline review. Prevents speaker-placeholder churn.

### Phase 4 acceptance gate

- All eleven regression-story tests pass.
- Seeded transcript fixture: claims correctly attributed; user-assigned task lands in user's `getOpenCommitments`.
- Cross-scope merge attempt: returns 4xx, no rows changed.
- Cleanup `promote_assertion` test: `assistant_inferred` claim explicitly corroborated by a later user statement is promoted to `user_confirmed`.
- Threshold-calibration output is reviewable in CI artifacts.
- Observability: a fixture run produces all expected log events with correct fields.

### Phase 4 PR slicing

- **PR 4-i**: dedup sweep + cleanup rewrite + new operations.
- **PR 4-ii**: transcript ingestion + speaker mapping + userSelfAliases.
- **PR 4-iii**: full eval harness + observability + placeholder cleanup job.

---

## Cross-Phase Concerns

### Consumer integration contract

The README's chat-assistant usage model is part of the product contract. New MCP/SDK work must preserve these actor boundaries and timings:

- **After source persistence, the chat host ingests.** Current REST: `POST /ingest/conversation` with `{ userId, conversation: { id, messages: [{ id, role, content, name?, timestamp }] } }`; `POST /ingest/document` with `{ userId, updateExisting?, document: { id, content, scope, timestamp? } }`. Target SDK/MCP wrappers may rename these, but they must still require stable external IDs and explicit document scope.
- **Before the first LLM call, the chat host bootstraps.** Current REST approximation: `POST /query/atlas` plus optional `POST /query/day`. Target: `bootstrap_memory` / `getConversationBootstrapContext`, returning a `ContextBundle` with section usage hints and evidence refs.
- **Before later LLM calls, the host or assistant searches just in time.** Current REST: `POST /query/search`. Target: `search_memory`, returning card-shaped personal results and evidence. This must not return reference-scope results by default.
- **Host-side search query construction is deterministic.** Current default: use the latest user message verbatim as the query. Optionally append host-known labels such as active task title, selected entity/project, conversation title, or route context in a fixed template. Do not add an LLM query-rewrite call to the default prefetch path.
- **For reference material, the host or assistant uses a separate path.** Target: `search_reference`, hard-filtered to `scope = reference`. Reference results are never rendered as personal facts.
- **For tasks, the host or assistant uses lifecycle-aware commitment APIs.** Current: `POST /commitments/open` and MCP `list_open_commitments`; target SDK wrapper: `getOpenCommitments`. The host either renders an `open_commitments` section before the model call, or the model is instructed to call `list_open_commitments` before answering about outstanding, next, pending, follow-up, completed, or abandoned work. Never infer pending work from arbitrary search hits.
- **For known entities, the host or assistant fetches a card.** Target: `get_entity` / `getEntityContext`, after search/bootstrap/UI gives a node id.
- **For repair and visualization, tools use raw graph endpoints.** Raw node/claim/neighborhood/timeline endpoints stay supported but are not the normal prompt surface. Destructive or corrective tools require a user-confirmed UI flow.

Host prefetch rules for commitments are deterministic:

- Always call `POST /commitments/open` during session bootstrap and render an `open_commitments` section if any rows exist.
- Call it again before a model call when the current product surface is task/planning/reminders/project-status/daily-brief, when the user selected a Task/Project/Person node, or after ingestion inserts/supersedes a `HAS_TASK_STATUS` claim.
- If the host has a selected Person node, pass `ownedBy`. If the UI supplies a date cutoff, pass `dueBefore` as `YYYY-MM-DD`.
- Do not run a pre-call LLM classifier to decide this.

Model tool-use instruction for commitments:

```text
Use `list_open_commitments` before you answer with any statement about the user's open, pending, in-progress, completed, abandoned, outstanding, next, or follow-up work, unless the current model input already contains a `<section kind="open_commitments">` rendered for this same model call.

Call it for user requests such as: "what should I do next?", "what is still open?", "continue with the next part", "remind me what I owe", "summarize pending work", "is X done?", or "plan my day/project/week".

If the user names a known assignee/person and you have their node id, pass `ownedBy`.
If the user gives a date cutoff, pass `dueBefore` as YYYY-MM-DD.
Do not infer pending work from semantic search results.
```

Reflection checks that must become tests before the target contract is considered real:

- Repeat this consumer-contract reflection before each assistant-facing PR is considered complete. The first pass paid for itself by catching the node-similarity scope leak after claim filters had already landed.
- Query construction: host-side prefetch requires no extra LLM hop; tests/docs show latest-user-message plus host-known labels. Any LLM-based query expansion must be an explicit optional feature with latency and eval coverage.
- Stable source IDs: re-sending the same conversation with the same message IDs is idempotent; changing content for an existing ID is either rejected or explicitly reprocessed.
- Async freshness: docs state that accepted ingestion jobs are not immediately searchable unless the caller waits for the worker pipeline.
- Reference isolation: default `search_memory` excludes both reference claims and reference-derived node cards. The current graph search path now scope-bounds claims, one-hop traversal, and node similarity; Phase 3 card assembly must preserve this.
- Commitment freshness: `list_open_commitments` returns only latest `HAS_TASK_STATUS in ('pending','in_progress')`; a `done` supersession removes the task before the next bootstrap. Tool-use eval must include turns like "continue with the next part" and "is X done?" and assert that the model calls `list_open_commitments` before answering when no `open_commitments` section was rendered for that model call.
- MCP descriptions: `bootstrap_memory`, `search_memory`, `search_reference`, `get_entity`, and `list_open_commitments` descriptions are snapshotted because they are model-facing behavior.
- Prompt rendering: every `ContextSection` includes `kind`, `content`, `usage`, and evidence refs where available; the renderer preserves usage hints in the model context.

### Wiring discipline

Per the design doc's Operational Contracts: every new field must land with producer + validation + storage + lifecycle + atlas/retrieval defaults + read-surface rendering + MCP description (if applicable) + eval. PR review uses the matrix as a checklist. A field that lands without all rows is not done.

### Database & environments

- Migrations always run in CI against a fresh DB and a pre-Phase-1 snapshot. Both must succeed.
- Test DB on a non-default Postgres port per CLAUDE.md.
- Production migrations for Phase 2b are forward-only, additive; safer than Phase 1.

### Backward compatibility (external)

- The SDK gains new methods (`getConversationBootstrapContext`, `searchReference`, `getOpenCommitments`, `getEntityContext`) and new MCP tools across Phases 2b–3. Coordinated SDK release at the end of Phase 3.
- Existing visualization endpoints (`/node/get`, `/node/neighborhood`, `/query/graph`, `/query/timeline`, `/query/day`) remain stable in shape; their responses gain `scope` and `assertedByKind` fields on claims (additive).
- Existing `/query/search` keeps its raw shape. The card-shaped response is on a new route (`/context/search`).

### Observability / rollback

- Phase 2b–4 migrations are forward-only and additive; rollback is a code revert (data remains valid).
- Phase 1 rollback is still hard (rename DDL); previous mitigation guidance unchanged.

### Known traps

- **`assertionKind` extraction reliability** — the model may default to `user` for everything in a multi-party transcript. Prompt engineering with few-shot examples, eval-driven calibration. Don't ship transcript ingestion without an eval that fails when attribution is wrong.
- **Cache invalidation for read models** — easy to under-fire (stale bundles) or over-fire (every claim insert recomputes). Trigger only on `forceRefreshOnSupersede = true` events; everything else uses scheduled refresh.
- **Tasks with fuzzy labels** — `currentlyOpenTasks` injection covers most cases; the rest is dedup. If extraction creates duplicate Task nodes despite injection, the dedup sweep is the safety net.
- **Speaker placeholder explosion** — every unresolved transcript speaker creates a Person node. Without 4.7's cleanup job the graph fills with `Speaker_3` placeholders. Don't ship transcripts without that job.
- **Trust-rule test coverage** — the `assistant_inferred` cannot supersede `user` rule is easy to break in a refactor. Lifecycle tests must include the trust matrix exhaustively.
- **Manual API behavior** — `/claim/create` accepts user input. It must NOT accept arbitrary `assertionKind` from callers; it always stamps `'user'`. Test for this.

### PR cadence estimate

- Phase 2b: 3 PRs (2b-i, 2b-ii, 2b-iii).
- Phase 3: 3 PRs (3-i, 3-ii, 3-iii).
- Phase 4: 3 PRs (4-i, 4-ii, 4-iii).

Total remaining: ~9 PRs. Plus opportunistic SDK / docs releases.

---

## Original (pre-2026-04-26) Phase Reference

The original Phase 1 / Phase 2 / Phase 3 / Phase 4 task breakdowns are preserved in git history (`docs/2026-04-24-claims-implementation-plan.md` at the merge of `f5d7181`). The current file is the active plan; the structure shifted to:

| Original | Current                                                                                     |
| -------- | ------------------------------------------------------------------------------------------- |
| Phase 1  | Phase 1 (landed)                                                                            |
| Phase 2  | Phase 2a (landed) + Phase 2b (new, registry/scope/provenance/tasks)                         |
| Phase 3  | Phase 3 (expanded with read-model assemblers + MCP tools)                                   |
| Phase 4  | Phase 4 (expanded with transcript ingestion + new cleanup operations + extended eval suite) |

Anyone currently mid-PR against the old phase numbering should land their work as currently scoped; the relabeling does not invalidate in-flight work.
