# SDK Consumer Migration Notes

Running record of SDK / REST / MCP changes that consumers (Petals, future
chat hosts, internal tooling) need to react to. Newest-first. Each entry is
concrete: what to delete, what to add, and what stays the same.

When in doubt, the plan
(`docs/2026-04-24-claims-implementation-plan.md`) has the _why_; this file
has the _what to change_.

---

## SDK addition — commitment due-date lifecycle, write-time enums, atomic node bootstrap

Driven by Petals integration feedback. Five changes; all additive, no breaking changes to existing endpoints.

### 1. New endpoint: `POST /commitments/due` — set / clear a Task's due date

- **NEW SDK method:** `MemoryClient.setCommitmentDue(payload)` → `SetCommitmentDueResponse`. Symmetric with the `dueOn` field on `getOpenCommitments` (read).
- Request: `{ userId, taskId, dueOn: "YYYY-MM-DD" | null, note?, assertedByKind? }`.
  - `dueOn: "YYYY-MM-DD"` resolves/creates the canonical Temporal node server-side, asserts a new `DUE_ON` claim, and lets the predicate-policy override (`Task` subject) supersede the prior date automatically.
  - `dueOn: null` retracts every active `DUE_ON` claim on the task. No new claim is asserted.
  - `note` is optional and lands in the new claim's `description` (parity with how Petals' commitment tools propagate notes).
- Response: `{ taskId, dueOn, claimId, retractedClaimIds }`. `claimId` is the new active `DUE_ON` claim (or `null` on the clear path); `retractedClaimIds` only populates on the explicit clear path.
- Wrong type / cross-user calls throw a typed `TaskNotFoundError` and the route returns `404` with `data: { name, taskId }`.
- **NEW exports:** `SetCommitmentDueRequest`, `SetCommitmentDueResponse`, `setCommitmentDueRequestSchema`, `setCommitmentDueResponseSchema`.

### 2. Canonical task-status enum exposed; write-time validation enforced

- **NEW exports** (re-exported from `~/types/graph` so SDK callers don't reach into `types/`): `TaskStatusEnum`, `AssertedByKindEnum`, `ClaimStatusEnum`, `NodeTypeEnum`, `PredicateEnum`, `AttributePredicateEnum`, `RelationshipPredicateEnum`, `ScopeEnum`, plus their inferred types.
- `TaskStatusEnum` is the canonical vocabulary: `"pending" | "in_progress" | "done" | "abandoned"`. Note: this **differs** from the `["pending", "in_progress", "completed", "cancelled"]` set Petals' integration drafted — please align Petals' tool schemas to the SDK enum (the open-commitments read view filters to `pending | in_progress`; `done` and `abandoned` are the terminal vocabulary, not `completed`/`cancelled`).
- `POST /claim/create` now validates `objectValue` against `TaskStatusEnum` when `predicate === "HAS_TASK_STATUS"` and rejects anything else with `400`. Error shape: `data: { name: "InvalidObjectValueError", predicate, objectValue, allowedValues }`. The error class is exported as `InvalidObjectValueError` so callers can pattern-match instead of string-matching.
- `HAS_STATUS` is intentionally not yet validated — its vocabulary is broader and not pinned. Same approach can be added there later if needed.

### 3. `createClaim` accepts explicit `assertedByKind` / `assertedByNodeId`

- `POST /claim/create` now accepts optional `assertedByKind` and `assertedByNodeId` on the request body. Defaults preserve the historical contract (`assertedByKind: "user"`, `assertedByNodeId: null`).
- Use `"user_confirmed"` when the user explicitly affirmed the assertion (e.g. "yes, remember that I prefer X"); `"assistant_inferred"` when the assistant proactively asserts without direct confirmation (e.g. closing a commitment from inferred signal). Cleanup / dedup / dream passes use `assertedByKind` to decide what to consolidate vs. preserve, so feeding it accurately makes those passes smarter.
- `assertedByNodeId` is only meaningful for participant-provenance claims (transcripts, document authorship). For typical user/assistant claims, leave it unset.
- The previous comment in `lib/claim.ts` claimed the manual API "must NOT accept arbitrary `assertedByKind` from callers" — that constraint is lifted; trusted SDK callers (with their own auth) opt in.

### 4. `getNode` accepts a server-side claim filter

- `POST /node/get` now accepts an optional `claimFilter: { predicates?, statuses? }`. Default behaviour (no filter) is unchanged — only `active` claims are returned.
  - `predicates: [...]` narrows the response to claims with those predicates (subject _or_ object side, same as today).
  - `statuses: [...]` overrides the implicit `active` default. Pass `["active", "superseded"]` to see lifecycle history; pass `[]` (empty array) to drop the status filter entirely.
- Concrete win for Petals' `setCommitmentStatus`: replace `getNode(taskId)` + client-side filtering with `getNode({ taskId, claimFilter: { predicates: ["HAS_TASK_STATUS"] } })`.
- **NEW exports:** `getNodeClaimFilterSchema`, `GetNodeClaimFilter`.

### 5. `createNode` accepts `initialClaims` for atomic bootstrap

- `POST /node/create` now accepts an optional `initialClaims: Array<{ predicate, statement, objectNodeId? | objectValue?, description?, assertedByKind?, assertedByNodeId? }>`.
- Claims are written sequentially after the node insert. If any claim fails (validation, FK, lifecycle), the node is deleted (FK `ON DELETE CASCADE` removes already-created claims) and the original error re-throws — no half-bootstrapped record survives.
- Response now also returns `initialClaimIds: TypeId<"claim">[]` in the order claims were supplied. Empty array when no `initialClaims` were sent, so existing callers see `node` exactly as before plus an empty array.
- Concrete win for Petals' `createCommitment`: collapse the three-call sequence (`createNode(Task)` → `createClaim(HAS_TASK_STATUS)` → `createClaim(OWNED_BY)`) into one `createNode` call where the Task is never observable without its required status claim. Validation errors (e.g. an invalid `HAS_TASK_STATUS` value) surface as `400 InvalidObjectValueError` and the node is rolled back automatically.
- **NEW exports:** `createNodeInitialClaimSchema`, `CreateNodeInitialClaim`.

### Notes on items NOT shipped from the feedback

- **Standalone `resolveTemporalNode` helper** (alternate proposal in feedback #1): not added. `setCommitmentDue` is the right level of abstraction for due dates; if `OCCURRED_ON` / `OCCURRED_AT` need a similar lift later, we'll revisit. Petals should not call `createNode({ nodeType: "Temporal", ... })` directly — Temporal nodes are deduped server-side by `YYYY-MM-DD` label, but that invariant is not part of the public contract. Use `setCommitmentDue` for due dates; for arbitrary date references, file a follow-up.
- **`HAS_STATUS` write-time vocabulary**: deliberately not pinned yet (no canonical enum exists for it the way `TaskStatusEnum` does for `HAS_TASK_STATUS`). If Petals needs this, propose an enum and we'll add it the same way.
- **Generic `batchCreateClaims` endpoint**: skipped in favour of `initialClaims` on `createNode`, which covers the concrete bootstrap case. If a non-bootstrap batching need surfaces (e.g. `setCommitmentDue`-style retract+assert wrappers for other predicates), we'll add a dedicated endpoint with a typed shape rather than a generic batch.

---

## SDK addition — commitments and deterministic dedup

- **NEW SDK method:** `MemoryClient.getOpenCommitments(payload)` → `OpenCommitmentsResponse`. Wraps `POST /commitments/open`. Use this for lifecycle-aware pending/in-progress work; do not infer open work from semantic search.
- **NEW SDK method:** `MemoryClient.dedupSweep(payload)` → `DedupSweepResponse`. Wraps `POST /cleanup/dedup-sweep`. `MemoryClient.cleanup(...)` already runs this internally before LLM cleanup, so call `dedupSweep` directly only for cheap/admin-only exact-label hygiene.
- **NEW exports:** `OpenCommitmentsRequest`, `OpenCommitmentsResponse`, `openCommitmentsRequestSchema`, `openCommitmentsResponseSchema`, plus the existing dedup sweep types from `cleanup`.

---

## SDK addition — orphan node pruning

- **NEW REST:** `POST /maintenance/prune-orphan-nodes` — deterministic maintenance for broken blob-backed sources and evidence-free legacy/entity nodes. It first removes source rows whose blob payload no longer exists, then prunes nodes made evidence-free by that repair. A node candidate has no claims as subject/object/speaker, no source links, and no aliases. Request: `{ userId, olderThanDays?, limit?, sourceScanLimit?, sampleLimit?, dryRun?, nodeTypes? }`. `dryRun` defaults to `true`; response includes `hasMore` for node batches and `sourceScanHasMore` when the source scan hit its cap.
- **NEW SDK method:** `MemoryClient.pruneOrphanNodes(payload)` → `PruneOrphanNodesResponse`.
- **NEW exports:** `PruneOrphanNodesRequest`, `PruneOrphanNodesResponse`, `pruneOrphanNodesRequestSchema`, `pruneOrphanNodesResponseSchema`.
- Default scanned node types are entity/task-like only: `Person`, `Location`, `Event`, `Object`, `Emotion`, `Concept`, `Media`, `Feedback`, `Idea`, `Task`. Generated/structural node types (`Conversation`, `Document`, `Temporal`, `Atlas`, `AssistantDream`) are excluded unless explicitly passed in `nodeTypes`.
- `MemoryClient.cleanup(...)` now runs orphan pruning first by default with `{ dryRun: false, olderThanDays: 7, limit: 10000, sampleLimit: 0 }`. Pass `pruneOrphanNodes: false` only for diagnostics or if an operator is running the standalone endpoint separately.

---

## SDK addition — `bootstrapMemory`

- **NEW REST:** `POST /context/bootstrap` — same `ContextBundle` shape as MCP `bootstrap_memory`. Request: `{ userId, forceRefresh? }`. Response: `{ sections, assembledAt }`. Cached 6h per user; pass `forceRefresh: true` to bypass.
- **NEW SDK method:** `MemoryClient.bootstrapMemory(payload)` → `ContextBundle`. Bumps the SDK surface — pin to a version that includes it.
- The MCP `bootstrap_memory` tool is unchanged; this just exposes the same data via REST/SDK for hosts that prefer to render the startup bundle server-side rather than letting the model call the MCP tool.

---

## PR 4-iii — Eval harness, observability, placeholder cleanup

**Commits:** `7f5055d`, `36008eb`, `b86ede0`.

### REST

- **NEW:** `POST /maintenance/cleanup-placeholders` — surfaces placeholder `Person` nodes (`nodeMetadata.additionalData.unresolvedSpeaker = true`) older than `olderThanDays` for cleanup-pipeline review. Request: `{ userId, olderThanDays?, limit?, triggerCleanup? }`. Response: `{ placeholderCount, candidatesFound, placeholders, seededCleanupJob, jobId? }`. Surfacing is read-only by default; pass `triggerCleanup: true` to also enqueue an iterative `cleanup-graph` job with the surfaced ids as `seedIds`.

### SDK (`@marcelsamyn/memory`)

- **NEW method:** `MemoryClient.cleanupPlaceholders(payload)` → surfacing payload.
- **NEW exports:** `CleanupPlaceholdersRequest`, `CleanupPlaceholdersResponse`, `cleanupPlaceholdersRequestSchema`, `cleanupPlaceholdersResponseSchema`.

### Server-side observability

No consumer impact, but worth knowing if hosts tail logs from this service:

- Eight structured events now emit as one JSON line per occurrence: `claim.inserted`, `claim.superseded`, `claim.contradicted`, `claim.retracted`, `identity.resolved` (with `decision` + `signal` + `scopeBounded`), `atlas.derived`, `profile.synthesized`, `bootstrap_context.assembled`, `transcript.ingested`. All include `userId` plus event-specific fields. If you ship logs to a downstream sink (Datadog, OpenTelemetry, etc.), you can now consume these directly without parsing free-text log lines.

### Internal: regression harness

A `src/evals/memory/` test harness pins eleven memory stories deterministically. CLI runners: `pnpm run eval:memory` (full suite, JSON + Markdown artifact in `eval-output/`) and `pnpm run eval:identity-thresholds` (calibration sweep). Vitest gate: `RUN_EVALS=1 pnpm run test`. Internal-only — not relevant to host integration but a useful signal that the claims contract is stable across PRs.

### Migration checklist for Petals

No host code changes required for PR 4-iii. If you want to proactively triage placeholder Persons created by transcript ingestion (recommended once you ship transcripts to real users), wire a periodic call to `cleanupPlaceholders({ userId, triggerCleanup: true })` — daily or weekly is fine.

---

## PR 4-ii — Transcript ingestion + userSelfAliases

**Commits:** `b4ac6e1`, `7a13dfe`.

### REST

- **NEW:** `POST /user/self-aliases` — set the labels by which the user appears in transcripts. Request: `{ userId, aliases: string[] }`. Response: `{ aliases: string[] }`. Replaces the full list each call (no granular add/remove). Persisted on `user_profiles.metadata.userSelfAliases`.
- **NEW:** `POST /transcript/ingest` — ingest a multi-party transcript with per-utterance speaker provenance. Request:

  ```ts
  {
    userId: string;
    transcriptId: string;          // stable external id (re-ingest is no-op)
    occurredAt: string;             // ISO date
    scope?: "personal" | "reference"; // default "personal"
    knownParticipants?: { label: string; nodeId: TypeId<"node"> }[];
    userSelfAliasesOverride?: string[]; // overrides stored aliases for this call only
    content:
      | { kind: "raw"; text: string }
      | { kind: "segmented"; utterances: { speakerLabel: string; content: string; timestamp?: string }[] };
  }
  ```

  Response: `{ message, jobId, transcriptSourceId, utteranceCount, resolvedSpeakers, unresolvedSpeakers }`. Job is async — caller must wait for the worker before searching against the new claims.

  Speaker resolution priority: `userSelfAliasesOverride` (or stored `userSelfAliases`) → `knownParticipants` → existing alias system → placeholder `Person` node with `additionalData.unresolvedSpeaker = true`. Placeholder Persons currently accumulate; sweep job lands in PR 4-iii.

### SDK (`@marcelsamyn/memory`)

- **NEW methods:**
  - `MemoryClient.setUserSelfAliases(payload)` → `{ aliases }`.
  - `MemoryClient.ingestTranscript(payload)` → ingestion ack.
- **NEW exports:** `SetUserSelfAliasesRequest`, `SetUserSelfAliasesResponse`, `IngestTranscriptRequest`, `IngestTranscriptResponse`, `userProfileMetadataSchema`.

### Schema additions (additive, no migration impact for consumers)

- `claims.assertedByKind = "participant"` is now reachable in real data (previously rejected by extraction). When you read raw claims, `participant`-kind rows always have `assertedByNodeId` populated — that node is the speaker.
- `sources.metadata` for transcript child rows now carries `speakerLabel: string` and `speakerNodeId: TypeId<"node">`. Optional fields; old conversation/document sources unchanged.
- New source `type` value `"meeting_transcript"` (parent rows of transcripts). Children remain `type: "conversation_message"` and link via `parentSource`.
- `nodeMetadata.additionalData` may carry `unresolvedSpeaker: true` (placeholder Persons created from unresolvable transcript labels) or `isUserSelf: true` (the user's own Person node, bootstrapped lazily on first transcript ingest). Treat these as informational hints.

### MCP — no changes

No MCP tool surface changes in this PR. Transcript ingestion is host-driven (the host decides when a chunk of transcript is "ready"); the assistant doesn't call the ingest API itself.

### Migration checklist for Petals

1. Bump SDK to a build at or after commit `7a13dfe`.
2. If you support meeting/transcript imports in the host UI, wire the new `ingestTranscript` SDK method. Pre-segmented input is the easier path if you already have utterance objects (e.g., from Otter / Granola / Zoom transcripts).
3. Surface a "your aliases" setting in the host so users can register the labels they appear under in transcripts. Persist via `setUserSelfAliases`. The plan recommends defaulting to `[user.displayName, user.email.split('@')[0]]` and letting the user edit.
4. If you render raw claim data anywhere (debug panels, graph viz), be aware `assertedByKind` may now be `"participant"` for transcript-derived claims; render `assertedByNodeId` as the speaker.
5. No backfill required — existing conversation/document sources and claims are untouched.

---

## PR 4-i — Cleanup pipeline rewrite

- `dedupSweep` REST response gains `crossScopeCollisionsSkipped: number` (additive, non-breaking).
- Cleanup pipeline now emits the operation vocabulary `{ operations: [...] }` (`merge_nodes`, `delete_node`, `retract_claim`, `contradict_claim`, `add_claim`, `add_alias`, `remove_alias`, `promote_assertion`, `create_node`). The legacy `{ merges, deletes, additions, newNodes }` proposal shape is gone. Internal-only — no public REST/MCP surface ships cleanup directly today, but if a host invokes it, this is the new payload.
- `mergeNodes` SDK method now throws on cross-scope merge attempts. Catch as `CrossScopeMergeError` if your SDK build re-exports it; otherwise match on `error.name === "CrossScopeMergeError"` or the message prefix `"Cross-scope merge refused:"`.
- `OneHopNode` (returned by `/query/search` `connections` and `/query/graph`) gains additive fields `claimId`, `scope`, `assertedByKind`. Existing callers ignoring unknown fields are unaffected.

---

## PR 3-iii — Card-shaped reads + snake_case MCP tools

**Commits:** `ed2fcf8`, `ff9e6f0`, `af6a15a`.

### REST

- **NEW:** `POST /context/search` returns `{ query, cards: NodeCard[], evidence: ClaimEvidence[] }`. Request: `{ userId, query, limit?, scope?: "personal" | "reference", excludeNodeTypes? }`. Default scope is `personal`. Reference results never blend with personal results in a single response.
- **UNCHANGED:** `POST /query/search` keeps its raw `{ similarNodes, similarClaims, connections }` shape. Use it only for visualization / debugging. Assistant-facing reads should migrate to `/context/search`.
- **UNCHANGED endpoints, NEW optional fields:** `POST /ingest/document` accepts `document.author` and `document.title` (both optional, both `string.min(1)`). They flow into `sources.metadata` and surface on `NodeCard.reference` for reference-scope nodes. Personal-scope ingests may still pass them; they're stored but currently unused for personal cards.

### SDK (`@marcelsamyn/memory`)

- **NEW method:** `MemoryClient.contextSearch(payload)` → `Promise<ContextSearchResponse>`. Bumps the SDK surface — pin to a version that includes it before depending on `cards`/`evidence` in consumer code.
- **NEW exports:** `ContextSearchRequest`, `ContextSearchResponse`, `NodeCard`, `NodeCardCurrentFact`, `NodeCardPreferenceGoal`, `NodeCardRecentEvidence`, `NodeCardReference`, `ContextBundle`, `ContextSection`, `ClaimEvidence`, `BootstrapMemoryRequest`, `GetEntityRequest`, `cardSearchToolInputSchema`. All from the package root.
- **NO breaking renames** in this PR. `querySearch` still works for the raw shape.

### MCP tool surface — **breaking**

The legacy space-named tool is gone. Consumers that registered prompts or hard-coded tool names need to update.

| Removed (old)                                                                   | Add (new)                                                          | Notes                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"search memory"` (returned XML string of raw similar nodes/claims/connections) | `search_memory` (snake_case; returns JSON `ContextSearchResponse`) | Default personal scope; never returns reference-derived cards.                                                                                                                                                                                                                                                |
| —                                                                               | `search_reference` (new)                                           | Reference-scope only. Required when the prompt asks the model to cite curated material rather than the user's own memory.                                                                                                                                                                                     |
| —                                                                               | `bootstrap_memory` (new)                                           | Call **once** at conversation start. Returns the `ContextBundle` (pinned, atlas, open_commitments, recent_supersessions, preferences sections). Cached 6h per user; pass `forceRefresh: true` to bypass. Hosts that already render their own startup section may skip this and tell the model not to call it. |
| —                                                                               | `get_entity` (new)                                                 | Single-entity card lookup by `nodeId`. Use after the model has an id from `search_memory` / `bootstrap_memory` and needs the full picture.                                                                                                                                                                    |

`save memory`, `list_open_commitments`, `retrieve memories relevant for today`, `read scratchpad` / `write scratchpad` / `edit scratchpad`, and the `get node` / `update node` / `delete node` tools are **unchanged**.

#### Tool-description text is part of the contract

`bootstrap_memory`, `search_memory`, `search_reference`, `get_entity`, and `list_open_commitments` descriptions are pinned via inline snapshots in `src/lib/mcp/tool-descriptions.test.ts`. The exact strings drive when the model decides to call each tool — if a host fine-tunes routing prompts or system messages, mirror this language so the assistant's behavior stays predictable.

#### Response shapes (MCP)

Old `"search memory"` returned an XML string in `content[0].text`. New tools return JSON-stringified payloads:

- `bootstrap_memory` → `JSON.stringify(ContextBundle)` (sections + assembledAt). Empty sections are omitted.
- `search_memory` / `search_reference` → `JSON.stringify(ContextSearchResponse)` (`{ query, cards, evidence }`).
- `get_entity` → `JSON.stringify(NodeCard)`, or text `"Entity not found"` with `isError: true` if missing.

Hosts that did string-match on the old XML output need to switch to JSON parsing.

### Migration checklist for Petals

1. Bump the `@marcelsamyn/memory` SDK to a build that includes commit `ff9e6f0`.
2. Replace any calls to `MemoryClient.querySearch(...)` used for assistant context with `MemoryClient.contextSearch(...)`. Keep `querySearch` for the visualization layer (graph view, debug panels).
3. If the assistant config registers MCP tools statically, replace `"search memory"` with `search_memory`, and add `bootstrap_memory`, `search_reference`, `get_entity` if you want them available.
4. Update the system prompt / routing rules:
   - Call `bootstrap_memory` once on first user turn (or render its sections server-side and skip the tool).
   - Use `search_memory` for personal recall — never `search_reference` for that.
   - Use `search_reference` only for curated material; render it as "the user has saved …", never as personal facts.
   - Use `get_entity` to fetch a full card when the model already has a node id.
5. If you ingest reference documents (books, papers, manuals) and want them attributed in cards, start sending `document.author` / `document.title` on `POST /ingest/document`. Backfill is unnecessary — old reference docs simply won't have a `reference` field on their cards.

---

## Phase 3-i / 3-ii — Profile synthesis + identity upgrade + Atlas rewrite

**Commits:** `42fcc2b`, `c4eb446`, `3f78288`, `1436046`, `28f1fbe`, `fe0ad01`, `43119f3`.

Mostly internal quality improvements; consumer surface mostly stable.

- `3f78288` — **Atlas is now claim-derived.** REST shape (`POST /query/atlas`) unchanged but content quality changed materially. Consumers caching Atlas output should evict on deploy.
- `1436046` — `(predicate, subjectType)` cardinality axis. No SDK change; consumers reading Task ownership now see at most one current `OWNED_BY` / `DUE_ON` per Task at any time.
- `c4eb446` — Identity resolution rewritten with four-signal trace (canonical label / alias / embedding / claim profile) and is scope-bounded — cross-scope merges no longer happen. Visible only in extraction outcomes; no API change.
- `42fcc2b` — Profile synthesis job rewrites node descriptions from active claims. `nodeMetadata.description` content quality changes; shape is unchanged.
- `28f1fbe`, `fe0ad01` — Internal `ContextBundle` and `NodeCard` synthesis layers. Exposed externally in PR 3-iii.
- `43119f3` — SDK build/exports fix. Pin to a build at or after this commit; earlier builds had missing type re-exports.

---

## Phase 2b — Registry + scope + provenance + tasks foundation

**Commits:** `397724c`, `f65d982`, `34b78ea`, `7df0102`, `e29f49f`, `245f1ce`, `c709e68`, `6f6a58e`, `8c69e9d`, `c8fd55e`, `30f50d1`.

This phase introduced the columns and read paths that PRs 3-iii / 4-\* build on. Several **default-behavior changes** that existing consumers may notice:

### REST

- **NEW:** `POST /commitments/open` — returns the user's currently open Tasks with `HAS_TASK_STATUS in ('pending', 'in_progress')`. Request: `{ userId, ownedBy?, dueBefore? }`. Response: `[{ taskId, label, owner, dueOn, statedAt, sourceId }]`. Use this instead of inferring open work from search hits — the read model is lifecycle-aware.
- **CHANGED (additive but behavior-shifting):** `POST /query/search` default response now **excludes** claims with `assertedByKind = "assistant_inferred"` and **excludes** reference-scope nodes/claims unless explicitly opted in. Existing callers that relied on broader defaults will see fewer results. To restore prior behavior, pass `includeAssistantInferred: true` and/or `includeReference: true`. This is the recommended default — assistant-fabricated content was always low-confidence — but worth knowing if you are doing diff-based regression on search output.
- **CHANGED:** `POST /ingest/document` accepts `scope: "personal" | "reference"`. Default is `personal`; reference-scope ingestion is required for curated material (books, papers) to keep it isolated from personal context.
- **NEW raw-claim columns** visible on `/node/get`, `/node/neighborhood`, `/query/graph`, `/query/timeline`, `/query/search`: `scope`, `assertedByKind`, `assertedByNodeId`, `supersededByClaimId`, `contradictedByClaimId`, `validFrom`, `validTo`. Additive; old callers ignoring unknown fields are unaffected.

### MCP

- **NEW tool:** `list_open_commitments` (description pinned in `tool-descriptions.test.ts`). Use it before answering about "open / pending / in-progress / next / outstanding / completed / abandoned" work. The model is instructed to skip the call if a host already rendered an `open_commitments` section.

### Schema additions

- `claims.scope` (`personal` | `reference`). Defaults to `personal`. All existing rows backfilled.
- `claims.assertedByKind` (`user` | `user_confirmed` | `participant` | `document_author` | `assistant_inferred` | `system`). Backfilled.
- `claims.assertedByNodeId` (nullable, FK to `nodes`). Required when `assertedByKind = 'participant'` (CHECK constraint). Used in PR 4-ii.
- `claims.supersededByClaimId`, `claims.contradictedByClaimId` (nullable, FK to `claims`). Set by lifecycle/cleanup paths.
- New predicates: `HAS_TASK_STATUS` (attribute, single-current-value with supersede), `DUE_ON` (relationship, single-current-value on Task subjects).
- New node type: `Task`.
- `aliases.normalized_alias_text` column with `(userId, normalized_alias_text, canonical_node_id)` unique constraint. Migration is forward-only; existing alias rows backfilled.

### Migration checklist for Petals

1. If any host code reads search/claim output and depends on seeing `assistant_inferred` content, pass `includeAssistantInferred: true` explicitly. Otherwise, no change needed — the new defaults are stricter and safer.
2. If you ingest reference material (books, papers, curated docs), pass `scope: "reference"` on `POST /ingest/document` so it doesn't pollute personal recall.
3. If you render task/commitment UI, prefer `POST /commitments/open` over scraping search results. The endpoint returns lifecycle-aware data.
4. If you render raw claim data anywhere, the new columns above are additive — display them or ignore them; nothing breaks.

---

## Phase 1 — Claims table + typeid rewrite + /claim/\* and /alias/\* routes

**Commits:** `0f0e04d`, `b598d59`, `a4d23fd`, `f5d7181`.

Foundational schema cutover from the old `edges`/`nodes` model to a `claims`/`nodes`/`aliases` model. If you are integrating with a build at or after PR 3-iii (which is the current SDK floor), you already have these. Recorded here for completeness:

- **REMOVED:** `POST /edge/create`, `POST /edge/update`, `POST /edge/delete`, `POST /edge/get`. Calls return 404.
- **NEW:** `POST /claim/create`, `POST /claim/update`, `POST /claim/delete` and `POST /alias/create`, `POST /alias/delete`. Manual write APIs for claims/aliases. The `/claim/create` route hard-codes `assertedByKind = 'user'` and `scope = 'personal'` — manual API callers cannot inject other provenance kinds.
- **Schema:** all entity ids are now `typeid`-prefixed strings (`nod_*`, `clm_*`, `src_*`, `als_*`, etc.). Old numeric ids are gone. Migration `0009` performs the rename + backfill in a single transactional step per user.
- **Extraction:** Phase 2a (`f5d7181`) made the LLM emit `relationshipClaims`, `attributeClaims`, and `aliases` directly. Source-ref threading is via formatted XML; source-scoped replacement makes re-ingestion idempotent. Internal change; the public `/ingest/conversation` and `/ingest/document` request shapes are unchanged.

---
