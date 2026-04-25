# Claims-First Memory Layer

## Goal

Replace the current node-and-edge graph with a claims-first model in which every factual memory is a sourced, time-aware, lifecycle-tracked assertion. Relationships and attributes share one store. Edges as a concept disappear; what reads like an edge today is either derivable from active claims or is structural metadata that never was a claim in the first place.

The target behaviours this design makes reachable:

- Distinguish when something was said, when it was true, and whether it is still current.
- Trace every factual memory to source evidence.
- Avoid re-creating the same entity because identity resolution can use aliases and attribute profiles, not just labels.
- Keep entity descriptions generic and reusable; episode-specific facts live in claims.
- Give assistants a persistent context layer (Atlas) that is derived from long-lived claims, not hand-written narrative.

## Core Decision

Claims are the single source of truth for factual memory. The existing `edges` table evolves into `claims` in place. No parallel system during transition, no eventual deprecation, no dual-authoring.

Rationale in one paragraph: a relationship claim and an edge are both `(subject, predicate, object)` triples. Provenance, stated time, validity, and lifecycle status are metadata about the assertion, not about the relation itself. Carrying both tables would be duplication. Carrying only edges leaves time and provenance unrepresentable. Carrying only claims gives the full model with one shape.

## Final-State Data Model

### `claims` (evolved from `edges`)

```ts
claims = pgTable("claims", {
  id: typeId("claim").primaryKey().notNull(),
  userId: text()
    .references(() => users.id)
    .notNull(),

  subjectNodeId: typeId("node")
    .references(() => nodes.id, { onDelete: "cascade" })
    .notNull(),
  predicate: varchar("predicate", { length: 80 }).notNull(),

  objectNodeId: typeId("node").references(() => nodes.id, {
    onDelete: "cascade",
  }),
  objectValue: text(),

  statement: text().notNull(),
  description: text(),
  metadata: jsonb(),

  sourceId: typeId("source")
    .references(() => sources.id, { onDelete: "cascade" })
    .notNull(),

  statedAt: timestamp("stated_at").notNull(),
  validFrom: timestamp("valid_from"),
  validTo: timestamp("valid_to"),

  status: varchar("status", { length: 30 })
    .notNull()
    .$type<ClaimStatus>()
    .default("active"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

Constraints:

- `CHECK (object_node_id IS NOT NULL OR object_value IS NOT NULL)` — at least one object shape.
- `CHECK (NOT (object_node_id IS NOT NULL AND object_value IS NOT NULL))` — exactly one.
- The `UNIQUE(source_node_id, target_node_id, edge_type)` constraint from `edges` is dropped. Multiple claims per triple are expected over time.

Indexes:

- `(userId, status, statedAt)`
- `(userId, subjectNodeId, status)`
- `(userId, objectNodeId, status)` (partial, where `objectNodeId IS NOT NULL`)
- `(sourceId)`

Field notes:

- `statement` is the human-readable sentence used for embeddings and review. Authored by the extraction LLM for new claims; templated for backfilled legacy rows.
- `description` and `metadata` are preserved from the old `edges` schema for compatibility; both remain optional and are not load-bearing.
- `sourceId` is required. A factual memory without evidence is not a claim. Backfilled legacy rows cite a synthetic per-user `legacy_migration` source and carry `metadata.backfilled = true` so retrieval can down-weight them.
- `statedAt` is when the source stated the claim (for messages, the message timestamp; for documents, the document ingestion time; for legacy rows, the original `edges.createdAt`).
- `validFrom` / `validTo` describe when the assertion applies, if known. Often null.
- `status` is system-owned. Extraction models never write status; only the lifecycle engine and cleanup pipeline do.

### `claim_embeddings` (renamed from `edge_embeddings`)

```ts
claimEmbeddings = pgTable("claim_embeddings", {
  id: typeId("claim_embedding").primaryKey().notNull(),
  claimId: typeId("claim")
    .references(() => claims.id, { onDelete: "cascade" })
    .notNull(),
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
  modelName: varchar("model_name", { length: 100 }).notNull(),
  createdAt: timestamp().defaultNow().notNull(),
});
```

Embedding text excludes node labels. Format: `{predicate} {statement} status={status} statedAt={statedAt}`. Decoupling embeddings from node labels removes the requirement to regenerate embeddings whenever a touching node is merged.

### `nodes` and `nodeMetadata`

Unchanged in shape. The `nodeMetadata.description` field remains a column but changes ownership: extraction may write an initial seed description, and profile synthesis owns durable rewrites. See [Node Descriptions](#node-descriptions).

Legacy descriptions are preserved as seed content for profile synthesis and overwritten as active claims accumulate.

### `aliases`

Add `normalizedAliasText`. `aliasText` preserves display casing; `normalizedAliasText` stores `trim().toLowerCase()` for matching. Add `UNIQUE(userId, normalizedAliasText, canonicalNodeId)`. Aliases become a first-class resolution and formatting signal. See [Aliases](#aliases).

### `sourceLinks`

Unchanged. Still maps structural node-to-source relationships (e.g., a `Conversation` node to its `conversation` source). This is distinct from claim-level provenance: `sourceLinks` answers "what node represents this source" and "what sources mention this node structurally"; claim `sourceId` answers "what evidence supports this assertion."

### Removed structures

- `edges` table (renamed and extended into `claims`).
- `edge_embeddings` table (renamed to `claim_embeddings`).
- `EdgeType` enum (absorbed into a unified predicate vocabulary; see below).
- Structural predicate values `MENTIONED_IN`, `CAPTURED_IN`, `INVALIDATED_ON` are removed from the factual-memory vocabulary; `MENTIONED_IN` / `CAPTURED_IN` become queries over `claims.sourceId` and `sourceLinks`; `INVALIDATED_ON` is replaced by `status = 'superseded' | 'contradicted' | 'retracted'`.

### Not introduced

- No generic `HAS_PROPERTY` predicate. Descriptive facts whose value is an entity (`owns a MacBook Pro`) become relationship claims with the value as a node. Low-query descriptive facts without an entity form (`blue eyes`, `left-handed`) may live in the node profile via description synthesis. The trade-off is intentional: descriptions are derived summaries and may duplicate or compress sourced information; cleanup is responsible for reconciling them against active claims when rewriting.

## Types

```ts
export const ClaimStatusEnum = z.enum([
  "active", // accepted evidence; included in current-state queries by default
  "superseded", // replaced by a newer active claim for the same subject+predicate (attribute case)
  "contradicted", // explicitly contradicted by a later user statement
  "retracted", // manually retracted via admin API or cleanup pipeline
]);

export const AttributePredicateEnum = z.enum([
  "HAS_STATUS", // supersedes: yes (overall current state per subject)
  "HAS_PREFERENCE", // supersedes: no
  "HAS_GOAL", // supersedes: no
  "MADE_DECISION", // supersedes: no (decisions accumulate; context carries the scope)
]);

export const RelationshipPredicateEnum = z.enum([
  "PARTICIPATED_IN",
  "OCCURRED_AT",
  "OCCURRED_ON",
  "INVOLVED_ITEM",
  "EXHIBITED_EMOTION",
  "TAGGED_WITH",
  "OWNED_BY",
  "PRECEDES",
  "FOLLOWS",
  "RELATED_TO", // fallback; discouraged, not a default
]);

export const PredicateEnum = z.union([
  AttributePredicateEnum,
  RelationshipPredicateEnum,
]);
```

`active` means accepted evidence, not "currently true forever." Currentness is determined from the combination of `status`, `validFrom`, `validTo`, and query `asOf`.

## Migration Plan

1. `ALTER TABLE edges RENAME TO claims`.
2. `ALTER TABLE claims` column renames:
   - `source_node_id` → `subject_node_id`
   - `target_node_id` → `object_node_id` (also made nullable)
   - `edge_type` → `predicate` (widened from `varchar(50)` to `varchar(80)`)
3. Add columns: `object_value`, `statement`, `source_id`, `stated_at`, `valid_from`, `valid_to`, `status` (default `'active'`), `updated_at` (default `NOW()`).
4. Drop `UNIQUE(source_node_id, target_node_id, edge_type)`.
5. Delete rows with `predicate IN ('MENTIONED_IN', 'CAPTURED_IN', 'INVALIDATED_ON')`. These are structural, not factual; their equivalents come from `sourceLinks` and `status`. The remaining existing predicates map 1:1 into `RelationshipPredicateEnum`.
6. Backfill every remaining row:
   - `statement` = templated sentence: `"{subjectLabel} {predicateAsReadable} {objectLabel or objectValue}{: description if present}"`. Done in a backfill job that joins to `node_metadata`.
   - `source_id` = per-user synthetic source of type `legacy_migration` (created once per user as part of the migration).
   - `stated_at` = `created_at`.
   - `status` = `'active'`.
   - `updated_at` = `created_at`.
   - `metadata` = `coalesce(metadata, '{}'::jsonb) || '{"backfilled": true}'::jsonb`.
7. Apply `NOT NULL` to `statement`, `source_id`, `stated_at`, `status`.
8. Add `CHECK` constraints on object shape.
9. Add new indexes.
10. `ALTER TABLE edge_embeddings RENAME TO claim_embeddings`; `ALTER TABLE claim_embeddings RENAME COLUMN edge_id TO claim_id`.
11. TypeID prefix migration:

- Add `"claim"` and `"claim_embedding"` to `ID_TYPE_NAMES`.
- Add prefixes `claim: "claim"` and `claim_embedding: "cemb"` to `ID_TYPE_PREFIXES`.
- Keep `"edge"` and `"edge_embedding"` available until the migration code and all imports no longer reference them.
- Update schema references from `typeId("edge")` to `typeId("claim")`.
- Update schema references from `typeId("edge_embedding")` to `typeId("claim_embedding")`.
- Rewrite claim row IDs from `edge_*` to `claim_*`.
- Rewrite embedding row IDs from `eemb_*` to `cemb_*`.
- Rewrite `claim_embeddings.claim_id` from `edge_*` to `claim_*`.
- Rewrite known JSON metadata references only where they are structured and test-covered; do not attempt broad string replacement inside arbitrary JSON blobs.
- Old external refs to `edge_*` IDs will not resolve after migration; this is an acknowledged break.

12. Add source types used by system-owned provenance: `"legacy_migration"` and `"manual"`.
13. Drop `EdgeType` enum export; add the unified predicate enums.
14. `ALTER TABLE aliases ADD COLUMN normalized_alias_text text`.
15. Backfill `normalized_alias_text = trim(lower(alias_text))`.
16. Add `UNIQUE(user_id, normalized_alias_text, canonical_node_id)`.

The DDL runs once. Row backfill and source creation can be batched per user to bound lock windows and make failures recoverable.

## Extraction Pipeline

### Source-Ref Threading (pre-work)

These three fixes are preconditions for claim insertion with real provenance.

1. `formatConversationAsXml` preserves the external message ID in the `id` attribute (currently uses sequential index — `src/lib/formatting.ts:22`).
2. `insertNewSources` returns a map of `externalId → internal source TypeId` for the inserted child sources (currently returns only external IDs — `src/lib/ingestion/insert-new-sources.ts:79`).
3. `extractGraph` accepts the source-ref map and passes it into the extraction prompt so the LLM can cite specific messages (currently receives only `content` — `src/lib/extract-graph.ts:62-75`).

### LLM Extraction Schema

```ts
const llmNodeSchema = z.object({
  id: z.string().min(1), // temporary id, resolved after LLM call
  type: NodeTypeEnum,
  label: z.string().min(1),
  description: z.string().min(1).optional(),
});

const relationshipClaimSchema = z.object({
  subjectId: z.string().min(1),
  predicate: RelationshipPredicateEnum,
  objectId: z.string().min(1),
  statement: z.string().min(1),
  sourceRef: z.string().min(1), // external message ID or document ID
  statedAt: z.string().datetime().optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
});

const attributeClaimSchema = z.object({
  subjectId: z.string().min(1),
  predicate: AttributePredicateEnum,
  objectValue: z.string().min(1),
  statement: z.string().min(1),
  sourceRef: z.string().min(1),
  statedAt: z.string().datetime().optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
});

const aliasSchema = z.object({
  subjectId: z.string().min(1), // refers to a node id in this extraction batch
  aliasText: z.string().min(1),
});

const llmExtractionSchema = z.object({
  nodes: z.array(llmNodeSchema),
  relationshipClaims: z.array(relationshipClaimSchema),
  attributeClaims: z.array(attributeClaimSchema),
  aliases: z.array(aliasSchema),
});
```

Notable removals vs. the current schema:

- Node `description` is no longer treated as factual storage. It may be emitted as an initial seed, then rewritten by profile synthesis.
- The LLM no longer emits a separate `edges` array. All assertions come through claims.

### Extraction Rules (prompt content)

- Extract only user-stated or user-confirmed information.
- Assistant-only suggestions are not user claims unless the user confirmed them.
- Prefer a few high-signal claims over exhaustive extraction.
- Capture explicit dates and validity windows when present.
- Relationships between durable entities → `relationshipClaims`.
- Status, preference, goal, and decision facts → `attributeClaims`.
- Node descriptions may be emitted as seed summaries, but factual assertions still belong in claims.
- When the user refers to the same entity by multiple names in the source (e.g., "my wife Jane (Mom)", "MBP" for "MacBook Pro"), emit each additional reference as an `alias` pointing at the canonical node id.
- Every claim must cite a `sourceRef` corresponding to a message ID in the provided conversation (or the document ID for document ingestion).

### Insertion Flow

1. Parse LLM output with Zod.
2. Resolve candidate nodes to canonical nodes using the upgraded identity resolution (see [Identity Resolution](#identity-resolution)).
3. Resolve each `sourceRef` to a real `sourceId` via the source-ref map. Claims with unresolvable source refs are rejected, not silently attached to a fallback.
4. Enter a transaction per ingested source.
5. If reprocessing a source (source-scoped replacement): delete existing claims where `sourceId = <this source>` before inserting new ones. This preserves idempotency without accumulating duplicates.
6. Insert claims with `status = 'active'`.
7. Upsert aliases (normalized text, dedup via the unique constraint). Aliases are not sourced assertions; they are resolution hints.
8. Run the lifecycle engine (below) against newly inserted claims.
9. Generate claim embeddings.
10. Enqueue a profile-synthesis job for any subject node whose active attribute claim set changed beyond a threshold (≥ 1 new attribute claim or any supersession).

## Lifecycle Engine

Runs synchronously after claim insertion. Input: a batch of newly inserted active claims. Output: status transitions on prior claims.

Rules:

**Attribute claims with single-valued predicates** (`HAS_STATUS`): `HAS_STATUS` represents the subject's overall current state, not a typed property bag. For each new active status claim with subject `S`, mark prior active `HAS_STATUS` claims on `S` as `superseded`. The new claim's `validFrom` defaults to its `statedAt` if not set. The superseded claim's `validTo` is set to the new claim's `statedAt`.

Validity fields answer "when did this assertion apply?" The status lifecycle answers "which current-state assertion has been replaced?" They are related but not duplicates: `validTo` can exclude a claim from current queries, while `status = 'superseded'` records that a newer claim replaced it.

**Attribute claims with multi-valued predicates** (`HAS_PREFERENCE`, `HAS_GOAL`, `MADE_DECISION`): no auto-supersession. Coexisting active claims are expected. Explicit contradictions come from cleanup or manual retraction.

**Relationship claims**: no auto-supersession by default (relationships are almost always many-valued). Explicit `validTo` from the extraction LLM ends an assertion. Contradictions come from cleanup.

Status transitions are recorded by updating `status` and `updatedAt`. There is no separate transition log; the row-level `updatedAt` plus the claim's `createdAt` is sufficient to reconstruct the history for audit.

## Identity Resolution

Current implementation is `(nodeType, canonicalLabel)` exact match only (`src/lib/extract-graph.ts:326-431`). The upgrade uses four signals, applied in order of cheapness:

1. **Canonical label match.** Exact match on `(userId, nodeType, canonicalLabel)`. Fast path.
2. **Alias match.** Exact match on `(userId, normalizedAliasText)`, constrained to matching `nodeType`. Catches "Mom → Jane" and "MBP → MacBook Pro" cleanly.
3. **Embedding similarity.** For candidates still unresolved, compare the candidate's label embedding against existing node embeddings of the same type. Above a high threshold (e.g., 0.85), merge; between a middle threshold (e.g., 0.7) and high, hand off to claim-profile check.
4. **Claim-profile compatibility.** When label/alias/embedding is ambiguous, compare the candidate's provisional claims against the existing node's active claim profile. Compatible profiles (overlapping attributes, no contradictions) support merge; contradicting profiles (different `HAS_STATUS`, different `OWNED_BY`) support keeping separate.

All four signals ship together with conservative thresholds. Threshold tuning is an ongoing activity driven by the eval harness.

A background re-evaluation pass runs after each ingestion: for each newly affected node, if the claim profile now passes the similarity + compatibility bar against another existing node, enqueue a proposed merge for the cleanup pipeline to confirm or reject. No automatic merges from the background pass; merges require either the extraction pipeline's direct resolution or cleanup's LLM review.

## Aliases

The `aliases` table becomes the authoritative name-variant store. It is currently unused in code; the alias system is built out fresh as part of this architecture.

### Authoring

1. **Extraction LLM** emits aliases alongside nodes and claims when the source text shows multiple names for the same entity.
2. **Cleanup merge** and **dedup sweep merge**: when a merge folds node `A` into node `B`, `A`'s canonical label becomes an alias on `B`, and `A`'s existing aliases rewire to `B`.
3. **Manual API**: `POST /alias/create` with `{ canonicalNodeId, aliasText }`; `POST /alias/delete` with `{ aliasId }`.

### Storage and normalization

- `aliasText` preserves the user-facing spelling and casing.
- `normalizedAliasText` is computed on insert as `trim().toLowerCase()` and used for matching.
- The unique constraint on `(userId, normalizedAliasText, canonicalNodeId)` prevents duplicate aliases without losing display fidelity.
- Aliases are not claims. They carry no source, no time, no lifecycle. They are resolution hints, written only by trusted paths.
- Aliases cascade on node delete; rewire on node merge (see [Dedup / Cleanup](#dedup--cleanup)).

### Consumption

1. **Identity resolution** signal 2 (see above).
2. **Node formatting for downstream LLMs**: when a node is formatted for retrieval context, aliases are included inline — `Jane Doe (also: Mom, J)`. The formatting helper batches alias lookups across all nodes in a retrieval response.
3. **Atlas** may cite alias sets for high-centrality nodes to keep the persistent context compact.

## Node Descriptions

Node `description` stays a first-class free-form field. Extraction may write a seed description, but durable ownership belongs to the **profile synthesis** job.

### Why keep descriptions

Claims give structure; descriptions give gestalt — role, nuance, cross-references, the bits that don't fit a predicate. A small sub-graph with good descriptions carries much more usable context than the same graph with empty descriptions.

### Profile synthesis

- **Trigger**: enqueued from the extraction insertion flow whenever a node's active attribute claim set changed beyond a threshold. Also runnable on demand for any node.
- **Inputs**: the node's existing description; all active attribute claims on the node; up to N high-centrality relationship claims; the node's aliases.
- **Output**: a short paragraph characterizing the entity as a durable profile, not a recent-events log. The prompt instructs the model to write the _gist_ of who/what this is.
- **Invariant**: every statement in the synthesized description must be supported by the input claims or the prior description. The prompt explicitly forbids inventing facts.

### Initial descriptions

New nodes should get a useful description as soon as possible. If profile synthesis is not available at insertion time, the extraction path may write an initial description from the same source context that created the node. That description is allowed to be imperfect; it is seed material, not the factual substrate.

Once profile synthesis runs, it may rewrite the description from active claims, relationship context, aliases, and the prior description. This may duplicate information already present in claims, and that is acceptable because descriptions are optimized for compact context rather than storage normalization.

Cleanup must treat descriptions as derived summaries. When cleanup rewrites a description, it should check for unsupported, stale, or contradicted statements against active claims and either remove them or preserve them only as clearly historical context.

### Why not only per-message

Per-message authoring is the cause of the "episode-specific" drift the direction doc flagged: a description written during one conversation bakes in that conversation's frame. Periodic synthesis from claims breaks that loop — episodes live in claims with `statedAt`; the description sees only the accumulated profile.

Legacy descriptions are preserved until profile synthesis overwrites them. The migration does not touch existing descriptions.

## Atlas

Atlas today is a single free-text node updated by a manual job and used as "ground truth" in cleanup (`src/lib/atlas.ts`, `src/lib/jobs/atlas-user.ts`). It is disconnected from the graph it is meant to summarize, which is the bug.

Claims-first Atlas: Atlas is the persistent context layer defined in the direction doc's four-layer model. It is derived, not authored.

Derivation: Atlas content is generated from the user's long-lived, high-signal active claims — specifically `HAS_PREFERENCE`, `HAS_GOAL`, and `HAS_STATUS` claims with high subject centrality (measured by number of relationship claims touching the subject) and long time-in-effect. The derivation runs on a schedule and after significant ingestion events. Manual override is supported via an editable "pinned context" field stored on `userProfiles.content`; the Atlas assembly concatenates the pinned context with the derived body.

This gives assistants a reliable permanent-ish context (the user's stated preferences, goals, and stable statuses) that is always available, independent of per-query semantic retrieval.

## Retrieval / Search

`searchMemory` (src/lib/query/search.ts:18-98) is rewritten to query claims instead of edges:

- `findSimilarNodes` unchanged; node formatting now includes aliases (`Label (also: alias1, alias2)`).
- `findSimilarEdges` becomes `findSimilarClaims` with options:

```ts
interface FindSimilarClaimsOptions extends SimilaritySearchBase {
  statuses?: ClaimStatus[]; // default ["active"]
  asOf?: Date; // default now
  subjectNodeIds?: TypeId<"node">[];
  includePastValid?: boolean; // default false
}
```

Defaults filter out claims whose `validTo` is before `asOf`.

- `findOneHopNodes` queries claims for neighbors (subject or object side), filtering by `status = 'active'` and validity.
- Rerank pipeline unchanged; inputs now include claim results with their `sourceId` for evidence lookup.

Search response shape adds `sourceIds` per claim result so callers can fetch evidence via the existing source API. Retrieval de-prioritizes claims with `metadata.backfilled = true` on score ties — backfilled claims are lower-trust by construction.

## Manual Editing APIs

Updated surface:

- `POST /node/create`, `POST /node/update`, `POST /node/delete`, `POST /node/merge`, `POST /node/batch-delete`: unchanged in purpose. Description updates are allowed only through trusted synthesis or admin paths, not routine graph edits.
- `POST /edge/*` endpoints removed.
- `POST /claim/create`: accepts subject, predicate, object (node or value), statement, and optional stated/valid times. System assigns a `manual` source per user. Status defaults to `active` and lifecycle runs.
- `POST /claim/update`: accepts status transitions (`retracted` only from user input; `active` → `retracted` is the only user-settable transition). Other fields are immutable; to change a claim, retract the old one and create a new one.
- `POST /claim/delete`: hard delete. Intended for cleanup workflows, not routine use.
- `POST /alias/create`: `{ canonicalNodeId, aliasText }`. Normalization and unique constraint apply.
- `POST /alias/delete`: `{ aliasId }`.
- `POST /node/get` response shape: returns active claims with the node as subject or object, grouped, plus the node's aliases.
- `POST /node/merge`: rewires claims (subject and object side) and aliases; promotes the removed node's label to an alias on the kept node. See [Dedup / Cleanup](#dedup--cleanup).

## Dedup / Cleanup

### Dedup sweep

`runDedupSweep` (src/lib/jobs/dedup-sweep.ts) behavior on merge, updated:

- `rewireNodeClaims` replaces `rewireNodeEdges`: updates claims where the removed node is subject or object, pointing them at the kept node.
- Duplicate claims after rewiring (same `subjectNodeId`, `predicate`, `objectNodeId` or `objectValue`, `sourceId`) are deduplicated, keeping the earliest `createdAt`.
- `rewireNodeAliases`: updates alias rows where `canonicalNodeId` is the removed node, pointing them at the kept node; adds the removed node's canonical label as an alias on the kept node. Conflicts resolved by the unique constraint (duplicates dropped).
- `rewireSourceLinks` unchanged.
- Claim embeddings do not need regeneration post-merge because the embedding text no longer includes node labels.

### LLM-guided cleanup

`runCleanupGraphJob` (src/lib/jobs/cleanup-graph.ts) proposes operations over claims instead of edges. Operations:

- `merge_nodes`: unchanged semantics; also triggers alias rewiring and label-as-alias promotion.
- `retract_claim`: marks a claim `retracted` (not deleted).
- `contradict_claim`: marks a claim `contradicted` and requires a citation to the contradicting claim.
- `add_claim`: creates a new active claim (with cleanup's synthetic source).
- `add_alias` / `remove_alias`: explicit alias operations when the LLM spots a name variant pair.

The cleanup prompt is updated to use Atlas as structured persistent context (itself derived) rather than free-text narrative. The prompt is also updated for contradiction detection: the cleanup pass is the only place contradictions between coexisting active multi-valued claims are caught, so the prompt calls them out explicitly with examples.

When cleanup rewrites node descriptions, it treats them as derived summaries over claims and aliases. It should remove unsupported current-state language, preserve useful generic identity information, and avoid turning one episode into the whole entity profile.

Cleanup preserves sourced history: old claims are marked, not deleted.

## Eval Harness

The eval harness is part of this architecture, not an add-on. Without it, the six regression stories in the direction doc are untested claims about quality; with it, they are measurable and the feedback loops that calibrate thresholds (identity resolution, profile-synthesis cadence, cleanup prompt quality) have ground truth to close against.

Location: `src/evals/memory/*`.

Fixtures: small hand-authored conversation transcripts plus expected post-ingestion state (active claims, node labels, alias sets, identity resolution outcomes).

Regression stories as test cases:

1. **Project starts, then completes** — a `HAS_STATUS` claim on a project node is superseded by a later one; current-state queries return only the new status.
2. **Project is renamed** — an alias is added; identity resolution merges references to both names.
3. **Same person, nickname and full name** — alias + claim-profile-aware resolution merges despite label mismatch.
4. **Assistant suggestion not confirmed** — no claim created from an assistant-only statement.
5. **User correction supersedes earlier belief** — the correction's claim supersedes the prior.
6. **Old current-state item expires** — a claim with `validTo` in the past is excluded from `asOf = now` queries.

Each test asserts specific claim counts and statuses post-ingestion. Tests use a test database on a non-default port per CLAUDE.md conventions.

## Implementation Sequence

One coherent architecture, delivered in ordered phases. Each phase leaves the system in a working state; none of them is a scope cut.

### Phase 1: Schema migration + source-ref plumbing

- Edges table renamed and extended to claims.
- Embeddings table renamed.
- TypeID prefix rewrite.
- Aliases table gets the unique constraint and normalization backfill.
- `formatConversationAsXml` preserves external message IDs.
- `insertNewSources` returns internal-id map.
- `extractGraph` accepts source-ref map.
- Existing edge-shaped extraction output is adapted into relationship claims with source provenance until the LLM schema changes.
- All current edge consumers are updated to query claims.
- Manual editing APIs updated: `/edge/*` removed, `/claim/*` and `/alias/*` added, `/node/*` response shape updated.

State at end of phase: the system still behaves like it did before, but all factual memory is stored as claims with provenance and status. Lifecycle engine is present, but attribute lifecycle behaviour becomes meaningful once Phase 2 emits attribute claims.

### Phase 2: Claims extraction + lifecycle + alias authoring

- Extraction LLM schema updated: emits `nodes`, `relationshipClaims`, `attributeClaims`, `aliases`.
- Extraction prompt rewritten with claim rules and alias rules.
- Insertion pipeline wires in lifecycle engine, alias upsert, and source-scoped replacement on reprocessing.

State at end of phase: new ingestions produce claim-native data with alias hints. Time dimension works end to end.

### Phase 3: Synthesis + identity upgrade

- Profile synthesis job for node descriptions.
- Atlas derivation job; `userProfiles.content` becomes pinned-context override.
- Identity resolution upgraded with all four signals, including alias match.
- Background re-evaluation pass for identity.

State at end of phase: the compression loop works. Node descriptions stay generic and claim-grounded; Atlas becomes useful persistent context; duplicates shrink.

### Phase 4: Cleanup + eval

- Dedup sweep rewires claims and aliases.
- LLM cleanup job operates over claims with the new operation vocabulary (including alias ops and contradiction detection).
- Eval harness with all six regression stories.

State at end of phase: architecture fully landed, quality measurable, feedback loops closed.

## Acceptance Checks

- A claim cannot be stored without `sourceId`, `subjectNodeId`, `predicate`, `statement`, `statedAt`, and `status`.
- A claim has exactly one object shape (`objectNodeId` XOR `objectValue`).
- Reprocessing the same source replaces that source's claims instead of duplicating them.
- Assistant-only content does not become a user claim unless the user confirmed it.
- Active search excludes claims whose `validTo` is before query `asOf`.
- Dedup merge rewires claims and aliases where the removed node is subject or object, and promotes the removed label to an alias on the kept node.
- Claim search returns source IDs for evidence lookup.
- Backfilled claims are marked `metadata.backfilled = true` and retrieval de-prioritizes them on score ties.
- Aliases normalize to `trim().toLowerCase()` on insert and resolve to canonical nodes in identity resolution.
- Node descriptions after ingestion are either seed descriptions from extraction or synthesized profiles grounded in active claims and the prior description.
- Atlas content reflects long-lived high-signal claims plus user-pinned context.
- All six regression-story tests pass.

## Open Questions

These are real unknowns calling for calibration or future extension — not scope cuts.

1. **Document source granularity.** Conversations have per-message sources; documents currently have only per-document sources. When an extracted claim comes from a specific paragraph, we have nothing finer to cite. Acceptable for now; revisit once retrieval quality shows the need.
2. **Contradiction-detection tuning.** The cleanup LLM is the detector. Iterate on the cleanup prompt as the eval harness surfaces cases it misses.
3. **Profile-synthesis cadence and thresholds.** "≥ 1 new attribute claim or any supersession" is a starting trigger; actual cadence needs calibration against LLM cost and description quality on real graphs.
4. **Identity-resolution thresholds.** The 0.7 / 0.85 embedding thresholds and the "compatible profile" definition need eval-driven tuning. Not a scope question; a calibration loop.

## References

- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560)
- [From Local to Global: A Graph RAG Approach to Query-Focused Summarization](https://www.microsoft.com/en-us/research/publication/from-local-to-global-a-graph-rag-approach-to-query-focused-summarization/)
- [HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models](https://arxiv.org/abs/2405.14831)
- [Graphiti overview](https://help.getzep.com/graphiti/getting-started/overview)
- [LangGraph memory concepts](https://docs.langchain.com/oss/javascript/concepts/memory)
- [ENGRAM: Effective, Lightweight Memory Orchestration for Conversational Agents](https://arxiv.org/abs/2511.12960)
