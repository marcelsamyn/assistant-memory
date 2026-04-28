# Claims-First Memory Layer

## Goal

Replace the current node-and-edge graph with a claims-first model in which every factual memory is a sourced, time-aware, lifecycle-tracked assertion. Relationships and attributes share one store. Edges as a concept disappear; what reads like an edge today is either derivable from active claims or is structural metadata that never was a claim in the first place.

The target behaviours this design makes reachable:

- Distinguish when something was said, when it was true, and whether it is still current.
- Trace every factual memory to source evidence and to the speaker/author who originated it.
- Avoid re-creating the same entity because identity resolution can use aliases and attribute profiles, not just labels.
- Keep entity descriptions generic and reusable; episode-specific facts live in claims.
- Distinguish facts about the user from reference material the user has chosen to make available.
- Distinguish open commitments from generic status, so completed work doesn't resurface as pending.
- Give assistants a persistent context layer that is derived from long-lived claims and shipped as ready-to-use sectioned bundles, not raw graph soup.

## Revisions

### 2026-04-26 — Architectural refinement

After a second design pass focused on operational coverage, the design adds five concepts on top of the original 2026-04-24 design. Each is structural, not optional:

1. **Predicate Policy Registry** — every predicate declares its cardinality, lifecycle behavior, atlas eligibility, and default retrieval section. Lifecycle and read-model code consult the registry; new predicates are a row, not a subsystem.
2. **Scope on sources/claims** — `personal | reference`. Default retrieval, Atlas, and identity resolution honor scope. Reference material does not bleed into personal context.
3. **Structured provenance (`assertedBy`)** — discriminated kind plus optional speaker/author node id. Replaces the prompt-only "user-stated vs. assistant-inferred" rule with a typed claim-level field that retrieval, Atlas, lifecycle, and cleanup all read.
4. **Tasks / commitments as a first-class node type with `HAS_TASK_STATUS`** — distinct from generic `HAS_STATUS`. Single-current-value lifecycle. Drives an `open_commitments` read-model section that never lists completed work as pending.
5. **Read Models layer** — the SDK/MCP product is a sectioned `ContextBundle` (atlas, open commitments, reference lens, evidence) with usage hints baked in, not raw claims. Atlas dissolves into one section among several. Raw graph endpoints remain available for visualization and exploration tooling.

What remains valid from the 2026-04-24 baseline (no change):

- Claims as the single substrate; edges removed.
- Migration plan, typeid prefix changes, embedding-text-without-labels.
- Aliases as resolution hints (not claims) with normalized text.
- Profile synthesis pattern for node descriptions.
- Eval harness scaffold and the six regression stories (extended below).

What changed in spirit:

- Atlas is not one artifact. It is one section in a context bundle assembled at conversation bootstrap; `open_commitments`, `reference_lens`, and `recent_supersessions` are sibling sections.
- Lifecycle behavior is no longer per-predicate hardcoded in the engine — it is registry-driven. The engine looks up `cardinality` and `lifecycle` per predicate and acts accordingly.
- Identity resolution is scope-bounded; cross-scope merges are forbidden.
- The user note (2026-04-26) that **the raw graph stays queryable for visualization tooling** is load-bearing: read models are additive, not a replacement for direct claim/node queries.
- Consumer-contract reflection is now an explicit design practice. The 2026-04-26 pass caught a real hole: filtering only claims by `scope` is insufficient because node similarity can still surface reference-derived nodes unless the node/card read path is scope-aware. Repeat this reflection pass whenever a new assistant-facing surface lands.

### Implementation status (2026-04-26)

What has already landed against this design:

- **Phase 1 — schema + provenance backbone** (commits `0f0e04d`, `b598d59`, `a4d23fd`):

  - `claims` table replacing `edges`, with `subject/object`, `objectValue`, `statement`, `sourceId`, `statedAt`, `validFrom`, `validTo`, `status`, `metadata`, object-shape XOR check, indexes per the data model below.
  - `claim_embeddings` rename, label-free embedding text.
  - TypeID prefix migration (`edge_*` → `claim_*`, `eemb_*` → `cemb_*`).
  - Aliases table with `normalized_alias_text` and the `(userId, normalizedAliasText, canonicalNodeId)` unique constraint.
  - `/edge/*` removed, `/claim/*` and `/alias/*` live (`src/routes/claim/*`, `src/routes/alias/*`).
  - Manual source per user (`legacy_migration` and `manual` source types).
  - System-authored claims for Atlas / Dream / `OCCURRED_ON` day linkage.

- **Phase 2a — claims-native extraction** (commit `f5d7181`):
  - Extraction LLM emits `nodes`, `relationshipClaims`, `attributeClaims`, `aliases` (`src/lib/extract-graph.ts`).
  - Source-ref threading: `formatConversationAsXml` carries external message IDs; `insertNewSources` returns `{externalId → internal sourceId}`; extraction consumes the map and rejects unresolvable refs.
  - Source-scoped replacement on reprocessing (`_deleteExistingClaimsForSources`).
  - Lifecycle engine v1 for `HAS_STATUS` supersession (`src/lib/claims/lifecycle.ts`) with statedAt-ordered recomputation per subject.
  - Alias extraction & upsert via `createAlias` / `normalizeAliasText`.

What is still open relative to this design:

- All five 2026-04-26 additions: registry, scope, provenance, tasks, read models. None of these have schema or wiring yet.
- Profile synthesis and identity resolution upgrade (Phase 3 of the plan) are not yet started.
- Cleanup rewrite to claim operations + alias operations + contradiction detection (Phase 4) is not yet started.
- Eval harness has scaffolding only; the six regression stories are not all in place.

## Architectural Spine

The system rests on five substrates, each with a single well-defined responsibility:

1. **Claims** — sourced, time-aware assertions. Storage substrate. One table, one shape.
2. **Predicate Policy Registry** — typed declaration of cardinality, lifecycle, atlas eligibility, retrieval section per predicate. Behavior substrate.
3. **Scope** — source-level `personal | reference` tag, denormalized onto each claim at insert. Trust/separation substrate.
4. **Provenance (`assertedBy`)** — discriminated kind plus optional node id. Trust/authorship substrate.
5. **Read Models** — derived sectioned context bundles assembled from claims, nodes, and aliases for the SDK/MCP surface. Product substrate.

Raw graph access (nodes, claims, neighborhood traversal, manual editing) remains a first-class SDK surface for visualization and exploration. Read-model APIs are additive.

## Core Decision

Claims are the single source of truth for factual memory. The existing `edges` table evolved into `claims` in place. No parallel system, no dual-authoring.

A relationship claim and an edge are both `(subject, predicate, object)` triples. Provenance, stated time, validity, and lifecycle status are metadata about the assertion, not about the relation itself.

## Final-State Data Model

### `claims`

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

  // 2026-04-26 additions:
  scope: varchar("scope", { length: 16 }).notNull().default("personal"),
  assertedByKind: varchar("asserted_by_kind", { length: 24 }).notNull(),
  assertedByNodeId: typeId("node").references(() => nodes.id, {
    onDelete: "set null",
  }),

  supersededByClaimId: typeId("claim").references(() => claims.id, {
    onDelete: "set null",
  }),
  contradictedByClaimId: typeId("claim").references(() => claims.id, {
    onDelete: "set null",
  }),

  statedAt: timestamp("stated_at").notNull(),
  validFrom: timestamp("valid_from"),
  validTo: timestamp("valid_to"),

  status: varchar("status", { length: 30 })
    .$type<ClaimStatus>()
    .notNull()
    .default("active"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

Constraints:

- `CHECK (object_node_id IS NOT NULL XOR object_value IS NOT NULL)` — exactly one object shape (already present).
- `CHECK (scope IN ('personal','reference'))`.
- `CHECK (asserted_by_kind IN ('user','user_confirmed','assistant_inferred','participant','document_author','system'))`.
- `CHECK (asserted_by_kind = 'participant' => asserted_by_node_id IS NOT NULL)` — speaker claims carry a node id; document authors may carry one when modeled.

Indexes (additions to the existing set):

- `(userId, scope, status, statedAt)` — replaces the existing `(userId, status, statedAt)` to make scope filtering free on the hot read path.
- `(userId, scope, assertedByKind, status)` — for "exclude assistant_inferred" defaults.
- `(userId, predicate, status)` — already present; keep.

Field notes:

- `scope` is denormalized from the claim's source at insert time. Sources are immutable on `scope` — set at registration, never updated — so the denormalization is safe.
- `assertedByKind` is required. Default retrieval excludes `assistant_inferred`. Atlas excludes `assistant_inferred` and `reference`-scope claims regardless.
- `assertedByNodeId` is the speaker (for `participant`) or author (for `document_author`). For `participant`, it is the Person node mapped from the speaker label. For `document_author`, it is optional (some books we ingest, we don't bother modeling the author as a node).
- `supersededByClaimId` and `contradictedByClaimId` give explainability: "why is this not pending anymore?" → "because claim X marked it done." They are set by the lifecycle engine and the cleanup pipeline respectively.
- All other fields keep their 2026-04-24 semantics.

### `claim_embeddings`

Unchanged from 2026-04-24. Embedding text excludes node labels.

### `nodes` and `nodeMetadata`

Unchanged in shape. `nodeMetadata.description` ownership belongs to **profile synthesis**; extraction may seed.

A new `Task` value joins `NodeTypeEnum`. See [Tasks & Commitments](#tasks--commitments).

### `aliases`

Unchanged in shape. Used by extraction (alias hints), identity resolution (signal 2), node formatting (display), and transcript ingestion (speaker label resolution).

### `sources`

Adds:

```ts
scope: varchar("scope", { length: 16 }).notNull().default("personal"),
```

Constraint: `CHECK (scope IN ('personal','reference'))`. Source `scope` is set at registration and never updated. New `SourceType` values: `meeting_transcript`, `external_conversation` (multi-party non-meeting). Existing types default to `scope=personal`. Reference ingestion paths set `scope=reference` explicitly at the API boundary.

`userSelfAliases` (per-user config, stored on `userProfiles.metadata` or a small new table) — the labels by which the user appears in transcripts and external conversations (e.g., "Marcel," "Marcel S," "MS"). Used by transcript ingestion to map `participant:user` to `assertedByKind = "user"` (not `participant`).

### `sourceLinks`

Unchanged. Structural node-to-source linkage; distinct from claim-level `sourceId`.

### Removed structures

- `edges`, `edge_embeddings`, `EdgeType` (already removed in Phase 1).
- Structural predicates `MENTIONED_IN`, `CAPTURED_IN`, `INVALIDATED_ON` (already removed; replaced by `sourceLinks` queries and `status`).

### Not introduced

- No generic `HAS_PROPERTY`. Same rationale as 2026-04-24.
- No transition log table. `supersededByClaimId` / `contradictedByClaimId` plus row-level `updatedAt` are sufficient for audit; if we ever need a full event stream we add it then.

## Types

```ts
export const ClaimStatusEnum = z.enum([
  "active",
  "superseded",
  "contradicted",
  "retracted",
]);

export const ScopeEnum = z.enum(["personal", "reference"]);

export const AssertedByKindEnum = z.enum([
  "user", // user stated it directly
  "user_confirmed", // assistant proposed, user explicitly confirmed
  "assistant_inferred", // assistant said it; user did not push back; not promoted
  "participant", // a non-user speaker in a multi-party source; carries nodeId
  "document_author", // an external document; optional nodeId
  "system", // system-authored (Atlas/Dream/day linkage)
]);

export const AttributePredicateEnum = z.enum([
  "HAS_STATUS", // single_current_value, supersedes, feeds atlas
  "HAS_TASK_STATUS", // single_current_value, supersedes, drives open_commitments
  "HAS_PREFERENCE", // multi_value, no auto-supersession, feeds atlas
  "HAS_GOAL", // multi_value, no auto-supersession, feeds atlas
  "MADE_DECISION", // append_only, no auto-supersession
]);

export const TaskStatusEnum = z.enum([
  "pending",
  "in_progress",
  "done",
  "abandoned",
]);

export const RelationshipPredicateEnum = z.enum([
  "PARTICIPATED_IN",
  "OCCURRED_AT",
  "OCCURRED_ON",
  "INVOLVED_ITEM",
  "EXHIBITED_EMOTION",
  "TAGGED_WITH",
  "OWNED_BY",
  "DUE_ON", // 2026-04-26: Task → Temporal node
  "PRECEDES",
  "FOLLOWS",
  "RELATED_TO",
]);

export const PredicateEnum = z.union([
  AttributePredicateEnum,
  RelationshipPredicateEnum,
]);
```

## Predicate Policy Registry

The single declarative table that every lifecycle, atlas, and retrieval consumer reads from.

```ts
type Cardinality = "single_current_value" | "multi_value" | "append_only";
type LifecycleRule = "supersede_previous" | "none";
type RetrievalSection =
  | "atlas"
  | "open_commitments"
  | "preferences"
  | "evidence"
  | "none";

interface PredicatePolicy {
  predicate: Predicate;
  cardinality: Cardinality;
  lifecycle: LifecycleRule;
  feedsAtlas: boolean;
  retrievalSection: RetrievalSection;
  forceRefreshOnSupersede: boolean;
}

const PREDICATE_POLICIES: Record<Predicate, PredicatePolicy> = {
  HAS_STATUS: {
    cardinality: "single_current_value",
    lifecycle: "supersede_previous",
    feedsAtlas: true,
    retrievalSection: "atlas",
    forceRefreshOnSupersede: true,
  },
  HAS_TASK_STATUS: {
    cardinality: "single_current_value",
    lifecycle: "supersede_previous",
    feedsAtlas: false,
    retrievalSection: "open_commitments",
    forceRefreshOnSupersede: true,
  },
  HAS_PREFERENCE: {
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: true,
    retrievalSection: "preferences",
    forceRefreshOnSupersede: false,
  },
  HAS_GOAL: {
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: true,
    retrievalSection: "preferences",
    forceRefreshOnSupersede: false,
  },
  MADE_DECISION: {
    cardinality: "append_only",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  // Relationship predicates — all multi_value / no lifecycle / not in Atlas / surfaced as evidence:
  PARTICIPATED_IN: {
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  OCCURRED_AT: {
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  OCCURRED_ON: {
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  INVOLVED_ITEM: {
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  EXHIBITED_EMOTION: {
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  TAGGED_WITH: {
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  OWNED_BY: {
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  DUE_ON: {
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "open_commitments",
    forceRefreshOnSupersede: false,
  },
  PRECEDES: {
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  FOLLOWS: {
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  RELATED_TO: {
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
};
```

Consumers:

- **Lifecycle engine** reads `cardinality` and `lifecycle`. The current `applyClaimLifecycle` recomputes from-scratch for `HAS_STATUS`; it generalizes to "for each predicate with `cardinality = single_current_value`, recompute supersession per subject." `HAS_TASK_STATUS` joins automatically.
- **Atlas synthesis** filters claims to predicates with `feedsAtlas = true`.
- **Read-model assemblers** group claims by `retrievalSection`.
- **Atlas refresh trigger** reads `forceRefreshOnSupersede` to decide whether a supersession on a given claim invalidates cached read-model artifacts immediately or waits for the next scheduled refresh.

The registry lives in `src/lib/claims/predicate-policies.ts` (single source of truth, exported as a const). Adding a predicate is a PR against this file plus the enum in `src/types/graph.ts`. No subsystem changes are needed for predicates that fit existing cardinality/lifecycle slots.

## Scope (Personal vs Reference)

Two scopes, set at the source level and inherited by claims:

- **`personal`** — claims about the user, their life, work, relationships. Sources: conversation, conversation_message, document (when registered as personal), meeting_transcript, external_conversation, manual, legacy_migration.
- **`reference`** — claims about the world, ideas, frameworks, content from books and articles the user has chosen to make available. Sources: document (when registered as reference).

Behavior:

- **Default retrieval (`searchMemory`)** filters to `scope = personal`. Reference is reachable only via the explicit `searchReference` MCP tool / SDK method.
- **Atlas / read-model bootstrap** excludes `scope = reference` from the personal sections (`atlas`, `open_commitments`, `preferences`). Reference may appear as its own optional `reference_lens` section if and when we build derivation for it; we do not build that in this revision.
- **Identity resolution is scope-bounded.** A candidate node from a `reference` source cannot merge with a `personal` node and vice versa. Prevents the "Marcus the friend ↔ Marcus Aurelius the author" collision.
- **Profile synthesis and dedup sweep are scope-bounded** for the same reason.
- **Cross-scope reference is allowed at the claim level** — a `personal` claim with `subject = user_node, predicate = TAGGED_WITH, objectValue = "stoic"` is fine; what's not allowed is the user's preference being inferred from a reference source. That's the assertion-level rule, enforced by extraction (see below).

Set at API boundary:

- `POST /source/register { type, scope, ... }` requires `scope`. Conversation/document ingestion defaults to `personal` if not supplied; reference ingestion paths must set `reference` explicitly.
- The decision is one-shot: sources are immutable on `scope`.

## Provenance (`assertedBy`)

Every claim carries `assertedByKind` (required) and optionally `assertedByNodeId`.

```ts
type AssertedBy =
  | { kind: "user" }
  | { kind: "user_confirmed" }
  | { kind: "assistant_inferred" }
  | { kind: "participant"; nodeId: TypeId<"node"> } // person who said it (multi-party sources)
  | { kind: "document_author"; nodeId?: TypeId<"node"> }
  | { kind: "system" };
```

Producer rules at extraction:

- **Conversation ingestion** (existing two-role conversation):
  - User-stated text → `kind: "user"`.
  - Assistant-stated text the user did not push back on → **not extracted by default**, per the existing 2026-04-24 rule. If a downstream policy ever opts in to extract assistant inferences, they ship as `kind: "assistant_inferred"` — never as `user`.
  - User explicitly confirms an assistant statement (e.g., "yes, that's right") → `kind: "user_confirmed"` on the resulting claim. The extraction prompt is updated to recognize confirmation patterns and emit `assertionKind: "user_confirmed"` per claim.
- **Multi-party sources** (`meeting_transcript`, `external_conversation`):
  - Speaker mapped to user-self → `kind: "user"`.
  - Other speakers → `kind: "participant"` with `nodeId = speakerNode`.
  - See [Multi-Party Sources & Speaker Mapping](#multi-party-sources--speaker-mapping).
- **Document ingestion**:
  - All extracted claims → `kind: "document_author"`. `nodeId` set if the source registration carries an author node id; otherwise null.
- **System-authored claims** (Atlas `OWNED_BY`, Dream `OWNED_BY`, day linkage `OCCURRED_ON`):
  - `kind: "system"`.

Consumers:

- **Default retrieval** filters out `kind = "assistant_inferred"`.
- **Atlas / read-model bootstrap** filters out `kind ∈ {"assistant_inferred", "document_author"}` and `scope = reference`.
- **Lifecycle engine** refuses to let an `assistant_inferred` claim supersede a `user` or `user_confirmed` claim for the same subject+predicate. Within the registry's `single_current_value` recomputation, that is a sort key amendment: among ties, prefer higher-trust kinds; if `assistant_inferred` is the only candidate against a prior `user`, the prior wins and the new claim is dropped to `superseded` immediately.
- **Cleanup pipeline** receives `assistant_inferred` and `document_author` claims as the first review queue.
- **Identity resolution signal 4 (claim-profile)** weights `user`/`user_confirmed` claims higher than `participant` claims (a friend's statement about themselves is reliable; a friend's statement about another friend is suggestive but not authoritative).

Promotion path:

- A later user statement that confirms a prior `assistant_inferred` claim does not edit the prior claim. It produces a new `user`-asserted claim that supersedes (for `single_current_value` predicates) or coexists with (for `multi_value` predicates) the prior. This keeps history intact.

## Tasks & Commitments

Tasks are the canonical case where a memory layer that doesn't track lifecycle actively misleads the user — completed work resurfaces as pending. Treating them as first-class is what makes the pending-vs-done bug solvable.

### Data shape

- New `NodeType`: `Task`.
- New attribute predicate: `HAS_TASK_STATUS` with `objectValue ∈ TaskStatusEnum`.
- New relationship predicate: `DUE_ON` (Task → Temporal node).
- Reuse existing relationship predicates: `OWNED_BY` (Task → Person, who owns/will-do it), `RELATED_TO` (Task → arbitrary node it references), `OCCURRED_ON` (Task → Temporal node, for the date the task was raised — already used elsewhere).

A pending task ingested from a meeting where Jane assigned Marcel to write the spec by Friday looks like:

```
node: Task("Write the spec")
claims:
  HAS_TASK_STATUS=pending     stated by Jane in transcript          assertedBy: participant:jane
  OWNED_BY → user_self        stated by Jane in transcript          assertedBy: participant:jane
  DUE_ON → Temporal("2026-05-01")
```

When Marcel says "I sent the spec" the next day, ingestion should produce:

```
HAS_TASK_STATUS=done   stated by user in chat   assertedBy: user
```

The lifecycle engine, driven by the registry's `single_current_value + supersede_previous` rule for `HAS_TASK_STATUS`, supersedes the prior `pending` claim and writes `supersededByClaimId` on it.

### Identity resolution for short-lived tasks

The hardest part. Tasks are low-centrality, label-fuzzy, and short-lived — exactly the wrong shape for embedding-based identity resolution. Two mechanisms compensate:

1. **Open-tasks context injection at extraction.** The extraction call receives `currentlyOpenTasks: [{ id, label, ownerLabel, dueOn?, statedAt }]` for the user, and the prompt instructs the model: "if the source mentions completing, abandoning, or progressing one of these existing tasks, emit a `HAS_TASK_STATUS` attribute claim on that task's id rather than creating a new Task node." This is the same mechanical pattern as the source-ref map: hand the model the right ids, tell it to use them.
2. **Alias support.** Task nodes can carry aliases (e.g., "the spec," "spec doc") so future references resolve through the existing alias system.

If the model still fails to link, the dedup/cleanup pass remains the safety net (a duplicate Task node with the same owner and overlapping label is a strong merge candidate).

### Retrieval

- The `getOpenCommitments(userId, { ownedBy?, dueBefore? })` API queries Task nodes whose latest `HAS_TASK_STATUS` is `pending` or `in_progress`. Returns Task cards with owner, due date, source ref, and the relevant claim list.
- `getConversationBootstrapContext` includes `open_commitments` as a section. Its rendering rule: never list `done` or `abandoned` tasks as pending. Done tasks may appear in a sibling `recent_supersessions` section ("you completed X yesterday") for one bootstrap cycle, so the assistant has acknowledgment material without re-asking.
- Atlas refresh: any supersession on `HAS_TASK_STATUS` triggers immediate invalidation of the user's `open_commitments` cache (registry's `forceRefreshOnSupersede = true`).

## Multi-Party Sources & Speaker Mapping

The memory layer is responsible for handling messy transcript data; callers may not be able to provide clean structure.

### Source shape

- New `SourceType`s: `meeting_transcript`, `external_conversation`.
- A parent source for the transcript; per-utterance child sources (same pattern as conversation/message).
- `formatConversationAsXml` (already preserves external IDs) is reused for transcripts; the external ID format becomes `{utteranceIndex}` or whatever the caller hands us, and the speaker label is rendered as an attribute.

### Ingestion pipeline

`ingestTranscript({ content, scope: "personal", optionalHints? })`:

1. **Detect/segment.** If the input is structured (utterances supplied), use it. Otherwise, run a structural-LLM pass that segments raw text into `[{ speakerLabel, text, optionalTimestamp }]` utterances.
2. **Extract speaker labels.** From the segmentation output.
3. **Resolve speakers.**
   - Match each label against `userSelfAliases` for the ingesting user → `assertedByKind = "user"`.
   - Match against the alias system (`normalizedAliasText` → `canonicalNodeId`, scoped to `Person`).
   - Unresolved labels → create placeholder `Person` nodes with `metadata.unresolvedSpeaker = true`. These are queued for cleanup with high priority.
   - Optional `knownParticipants` hints in the API call are a perf shortcut — they pre-populate the speaker map without the alias lookup. Not required.
4. **Insert per-utterance child sources.** Each child source carries the resolved speaker via `metadata.speakerNodeId`.
5. **Run extraction** with the speaker map injected into the prompt. Each emitted claim's `assertionKind` is filled from the speaker mapping (user-self → `user`; mapped person → `participant` with that node's id).
6. **Lifecycle and embeddings** as for any other ingestion.

### Extraction prompt rules for transcripts

- Claims about a speaker, asserted by that same speaker, are direct: subject = speaker, `assertedBy = participant:speaker`.
- Claims about another participant, asserted by speaker A, still have subject = the other participant; `assertedBy = participant:A`. Retrieval / cleanup downweights "X said Y about Z" style claims relative to "X said Y about themselves."
- Embedded reported speech ("Bob said that Carol said …") is **not** modeled with nested claim structures. The raw transcript is queryable; only assertions the extractor is willing to attach to the speaker get emitted.
- Commitments and assignments produce Task nodes with `HAS_TASK_STATUS=pending` and `OWNED_BY → assignee`. If the user is the assignee, the task surfaces in `open_commitments` for the user.

### Identity resolution exposure

Transcripts are where the alias system gets stress-tested. The four-signal resolution (Phase 3 of the plan) plus the speaker-label-as-alias-source flow above is the entire defense; nothing transcript-specific beyond that.

## Migration Plan

Phase 1 of this plan is already on `main`. The 2026-04-26 additions need their own forward-only migration:

```sql
-- Sources scope
ALTER TABLE sources ADD COLUMN scope varchar(16) NOT NULL DEFAULT 'personal';
ALTER TABLE sources ADD CONSTRAINT sources_scope_ck CHECK (scope IN ('personal','reference'));

-- Claims scope (denormalized)
ALTER TABLE claims ADD COLUMN scope varchar(16) NOT NULL DEFAULT 'personal';
UPDATE claims c SET scope = s.scope FROM sources s WHERE c.source_id = s.id AND c.scope <> s.scope;
ALTER TABLE claims ADD CONSTRAINT claims_scope_ck CHECK (scope IN ('personal','reference'));

-- Provenance
ALTER TABLE claims ADD COLUMN asserted_by_kind varchar(24);
ALTER TABLE claims ADD COLUMN asserted_by_node_id text REFERENCES nodes(id) ON DELETE SET NULL;
-- Backfill: every existing claim is treated as user-stated unless it's a system-authored linkage.
UPDATE claims SET asserted_by_kind = 'system'
  WHERE source_id IN (SELECT id FROM sources WHERE type IN ('manual'))
    AND predicate IN ('OWNED_BY','OCCURRED_ON');
UPDATE claims SET asserted_by_kind = 'user' WHERE asserted_by_kind IS NULL;
ALTER TABLE claims ALTER COLUMN asserted_by_kind SET NOT NULL;
ALTER TABLE claims ADD CONSTRAINT claims_asserted_by_kind_ck CHECK (
  asserted_by_kind IN ('user','user_confirmed','assistant_inferred','participant','document_author','system')
);
ALTER TABLE claims ADD CONSTRAINT claims_asserted_by_node_consistency_ck CHECK (
  (asserted_by_kind IN ('participant') AND asserted_by_node_id IS NOT NULL)
  OR asserted_by_kind <> 'participant'
);

-- Transition pointers
ALTER TABLE claims ADD COLUMN superseded_by_claim_id text REFERENCES claims(id) ON DELETE SET NULL;
ALTER TABLE claims ADD COLUMN contradicted_by_claim_id text REFERENCES claims(id) ON DELETE SET NULL;

-- Indexes
CREATE INDEX claims_user_scope_status_stated_at_idx ON claims (user_id, scope, status, stated_at);
CREATE INDEX claims_user_scope_kind_status_idx ON claims (user_id, scope, asserted_by_kind, status);
DROP INDEX IF EXISTS claims_user_id_status_stated_at_idx;
```

Idempotency: each step guarded by `IF NOT EXISTS` / column-existence checks.

The existing 2026-04-24 migration (Phase 1) is unchanged.

## Extraction Pipeline

Existing (already landed Phase 2a) flow:

1. `formatConversationAsXml` preserves external message IDs.
2. `insertNewSources` returns `{ externalId → internal sourceId }`.
3. `extractGraph` consumes the source-ref map; rejects unresolvable refs.
4. LLM emits `nodes`, `relationshipClaims`, `attributeClaims`, `aliases`.
5. `_processAndInsertLlmClaims` inserts; `_processAndInsertLlmAliases` upserts; `applyClaimLifecycle` runs; embeddings generated.

2026-04-26 additions to the extraction call:

### Extra inputs to the extraction prompt

- **Speaker map** (transcript / external_conversation only): `{ "Marcel": user, "Jane": person:<nodeId>, "Speaker 3": placeholder:<nodeId> }`.
- **Currently open tasks** (all conversation paths): `[{ id, label, owner, dueOn?, statedAt }]` for tasks owned by the user (or any active participant for multi-party sources). Cap at N=20, ordered by recency. Tells the model to resolve "I sent the spec" against an existing task id rather than creating a new Task.
- **User self-aliases**: passed implicitly through the speaker map.

### LLM extraction schema (additions)

```ts
const llmRelationshipClaimSchema = z.object({
  subjectId: z.string().min(1),
  predicate: RelationshipPredicateEnum,
  objectId: z.string().min(1),
  statement: z.string().min(1),
  sourceRef: z.string().min(1),
  assertionKind: AssertedByKindEnum, // NEW
  assertedBySpeakerLabel: z.string().optional(), // NEW; resolved post-LLM via speaker map
  statedAt: z.string().datetime().optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
});

const llmAttributeClaimSchema = z.object({
  subjectId: z.string().min(1),
  predicate: AttributePredicateEnum,
  objectValue: z.string().min(1),
  statement: z.string().min(1),
  sourceRef: z.string().min(1),
  assertionKind: AssertedByKindEnum, // NEW
  assertedBySpeakerLabel: z.string().optional(), // NEW
  statedAt: z.string().datetime().optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
});
```

The post-LLM resolver maps `assertedBySpeakerLabel` (a string the LLM copies from the prompt's speaker list) to a `nodeId`. Claims with `kind = "participant"` and an unresolvable label are rejected, not silently attached.

### Insertion flow (revised)

1. Parse LLM output with Zod.
2. Resolve candidate nodes (signal-1 label match for now; signal-2..4 land in Phase 3).
3. Resolve `sourceRef` to `sourceId` (unchanged).
4. Resolve `assertedBySpeakerLabel` via speaker map; reject on failure for `participant`/`document_author` kinds.
5. Stamp `scope` on each claim from the source's scope.
6. Per ingested source, in a transaction:
   - Source-scoped replacement: `DELETE FROM claims WHERE source_id IN (...)` for the sources being reprocessed.
   - Insert claims with `status='active'`, full provenance, scope.
   - Upsert aliases.
   - Run lifecycle engine (registry-driven; see below).
   - Generate claim embeddings.
   - Enqueue profile-synthesis jobs (Phase 3).
   - Enqueue read-model invalidations for affected user (only if any registry-`forceRefreshOnSupersede` predicate fired).

## Lifecycle Engine

Existing engine (`src/lib/claims/lifecycle.ts`) hardcodes `HAS_STATUS`. Generalizes to:

- Read `PREDICATE_POLICIES`. For each predicate where `cardinality = "single_current_value"` and `lifecycle = "supersede_previous"`, recompute supersession per `(userId, subjectNodeId, predicate)` triple.
- The recomputation pass is the existing `recomputeStatusLifecycleForSubject`, parameterized by predicate. Sort by `statedAt` then `createdAt` then `id`. Among ties, prefer `assertedByKind` of `user`/`user_confirmed` over `assistant_inferred`.
- For the latest claim per triple: `status = 'active'`, `validTo = null` (unless explicitly set).
- For prior claims: `status = 'superseded'`, `validTo = nextClaim.statedAt`, **`supersededByClaimId = nextClaim.id`** (new in 2026-04-26).
- Reject promotions that violate trust: an `assistant_inferred` claim cannot supersede a `user` claim. The engine demotes the new claim to `status = 'superseded'` immediately and does not change the prior.

Multi-valued and append-only predicates: no supersession. Explicit `validTo` from extraction still ends an assertion's apply window.

Status transitions write `updatedAt` and the appropriate transition pointer column. No separate transition log.

## Identity Resolution

Unchanged in spirit from 2026-04-24. Refinements:

- **Scope-bounded**: signals 1–4 only consider candidates with the same `scope` as the candidate node (where the candidate's scope is determined by the scope of the source it is being created from).
- **Signal 2 (alias)** now also handles transcript speaker labels, since the speaker-mapping step writes to the alias table when resolving previously-unknown speakers.
- **Signal 4 (claim profile)** weights claims by `assertedByKind` — `user`/`user_confirmed` count more than `participant`; `assistant_inferred` and `document_author` are excluded from the profile for compatibility comparison.

Background re-evaluation pass and conservative thresholds: unchanged.

## Aliases

Unchanged from 2026-04-24. The 2026-04-26 additions reinforce the existing role:

- Transcript speaker mapping writes to aliases when it resolves "Jane" to an existing node.
- Task aliases are now in scope (e.g., "the spec," "spec doc" → `Task` node).
- Identity resolution is scope-bounded, so a single `Person` node cannot accidentally accumulate aliases from a `reference` source.

## Node Descriptions

Unchanged from 2026-04-24.

A small clarification: profile synthesis sees only `personal`-scope claims for `personal`-scope nodes. `reference`-scope nodes have descriptions sourced from the document itself (extraction's seed description); profile synthesis for reference nodes is out of scope for this design — if we ever build it, it operates on reference-scope claims only.

## Read Models & Context Bundles

The product surface for assistants is a sectioned `ContextBundle`. The graph is internal machinery.

Consumer contract:

1. The **chat host** ingests sources after turns via the ingestion APIs. It owns stable `userId`, `conversation.id`, message IDs, document IDs, and timestamps.
2. The **chat host** calls `getConversationBootstrapContext(userId, { asOf? })` once before the first LLM call of a session and renders the returned sections into a developer/system memory block.
3. The **assistant model or host** calls `searchMemory(userId, query, { asOf? })` only when the current turn needs specific personal memory.
4. The **assistant model or host** calls `searchReference(userId, query, { asOf? })` only when the user wants ideas, frameworks, books, articles, or document content from the reference corpus.
5. The **host** renders an `open_commitments` section before the model call, or the **assistant model** calls `getOpenCommitments(userId, filters?)` / `list_open_commitments` inside the normal tool loop, before answering about outstanding, next, pending, follow-up, completed, or abandoned work.
6. The **assistant model or host** calls `getEntityContext(userId, nodeId)` only after it already has a specific entity ID from search, bootstrap, or a user-selected UI item.
7. The **memory UI/debugger** uses raw graph endpoints (`/node/get`, `/node/neighborhood`, `/query/graph`, `/query/timeline`, claim/alias edit APIs). The normal chat loop does not consume unbounded raw graph output.

The LLM should see rendered sections with usage hints and evidence refs, not unbounded claim dumps. The current user message wins over stale memory on conflict. Reference material never becomes a user fact without a personal-scope user assertion. Open commitments come only from the latest lifecycle-aware commitment view, never from old search hits.

Commitments are communicated to a chat assistant in one of two precise ways:

- **Host prefetch**: always include open commitments in the session bootstrap. Refresh them before a model call when the UI surface is task/planning/reminders/project-status/daily-brief, when the user selected a Task/Project/Person node, or when ingestion inserted/superseded a `HAS_TASK_STATUS` claim. Pass `ownedBy` only from a selected/known Person node. Pass `dueBefore` only from an explicit UI/date cutoff.
- **Tool rule**: if no `open_commitments` section was rendered in the current model input, the model instruction says to call `list_open_commitments` before answering requests like "what should I do next?", "what is still open?", "continue with the next part", "remind me what I owe", "summarize pending work", "is X done?", or "plan my day/project/week."

```ts
interface ContextSection {
  kind:
    | "atlas"
    | "open_commitments"
    | "preferences"
    | "recent_supersessions"
    | "evidence"
    | "reference_lens"
    | "pinned";
  content: string; // rendered text the LLM consumes
  usage: string; // hint that goes to the LLM about how to interpret this section
  evidenceRefs?: { claimId: TypeId<"claim">; sourceId: TypeId<"source"> }[];
}

interface ContextBundle {
  sections: ContextSection[];
  asOf: Date;
}
```

### Sections and rules

- **`pinned`** — `userProfiles.content`. Manual override; concatenated first.
- **`atlas`** — synthesized from `feedsAtlas = true` claims with `scope = personal` and `assertedByKind ∈ {user, user_confirmed}`. Rank by subject centrality and time-in-effect. Output budgeted to ~500 tokens.
- **`open_commitments`** — Task nodes with latest `HAS_TASK_STATUS ∈ {pending, in_progress}` owned by the user. Rendered as a compact list with owner, due date, source. Usage hint: "Pending or in-progress only. Do not surface as 'todo' anything not in this list."
- **`recent_supersessions`** — claims that transitioned to `superseded`, `done`, `contradicted`, or `retracted` in the last N hours (default 24). One bootstrap cycle of acknowledgment material. Usage hint: "These are recently completed or invalidated. Do not re-prompt them."
- **`preferences`** — active `HAS_PREFERENCE` and `HAS_GOAL` claims for the user; same trust filters as `atlas`.
- **`reference_lens`** — empty by default in this revision. Reserved slot for future reference distillation if a real workflow emerges.
- **`evidence`** — populated only by the search APIs, not bootstrap.

### APIs

- `getConversationBootstrapContext(userId, { asOf? })` — assembled at session start. Sections: `pinned`, `atlas`, `open_commitments`, `recent_supersessions`, `preferences`. Default `asOf = now`.
- `searchMemory(userId, query, { scope = "personal", asOf?, includePastValid? })` — ranked node cards + supporting claim evidence. Default scope `personal`. Reference scope reachable but normally callers use `searchReference`.
- `searchReference(userId, query, { asOf? })` — explicit reference retrieval. The MCP tool description tells the LLM: "Use for ideas, frameworks, content from books and articles in the user's corpus. Does not contain personal facts about the user."
- `getEntityContext(userId, nodeId)` — node card for a specific entity.
- `getOpenCommitments(userId, { ownedBy?, dueBefore? })` — registry-driven view; used by bootstrap and on-demand.

### Node card shape

The unit returned by search and entity APIs:

```ts
interface NodeCard {
  nodeId: TypeId<"node">;
  type: NodeType;
  label: string;
  aliases: string[];
  scope: "personal" | "reference";
  summary: string; // from profile synthesis (nodeMetadata.description)
  currentFacts: string[]; // active single_current_value attribute claims, rendered
  preferencesGoals?: string[]; // multi_value attribute claims
  openCommitments?: TaskCardLite[];
  recentEvidence: ClaimRef[]; // top-N relevant active claims, statement + sourceId
  reference?: { author?: string; title?: string }; // when scope=reference
}
```

Claims are not returned raw outside of `recentEvidence`. Token efficiency is the read API's responsibility, not the assistant's.

### Raw graph access remains

The MCP/SDK keeps the existing endpoints for visualization and exploration:

- `POST /node/get`, `POST /node/neighborhood`, `POST /query/graph`, `POST /query/timeline`, `POST /query/day`.
- These return claim and node data directly (with the new `scope` and `assertedBy` fields included). Callers building visualization tools depend on them. Read-model APIs are additive, not a replacement.

## Retrieval / Search

`searchMemory` (`src/lib/query/search.ts`) is updated:

- Query input is natural language, not keyword DSL. For host-side prefetch, the default query is the latest user message verbatim, optionally followed by host-known labels in a fixed template (`Active task`, `Selected entity`, `Conversation title`). A separate LLM query-rewrite call is not part of the default path.
- Default claim `WHERE` adds `scope = $scope` (default `personal`) and `assertedByKind <> 'assistant_inferred'`.
- Default node search must also be scope-aware. Since nodes do not directly carry `scope`, the read path must derive node eligibility from linked sources and/or touching claims. A personal memory search cannot return a node that is only supported by reference-scope sources or reference-scope claims.
- `findSimilarClaims` honors the new defaults; an `includeReference` and `includeAssistantInferred` opt-in keeps deep-debug paths possible.
- Rerank pipeline unchanged in shape; inputs include claim results with `sourceId` and `assertedByKind` so the reranker can downweight participant-asserted claims about third parties when configured.
- `findOneHopNodes` adds the same claim-level scope/provenance filter.

`searchReference` is a separate function (and a separate MCP tool) that filters to `scope = reference` and returns reference node cards with `author`/`title` populated.

## Manual Editing APIs

- `POST /claim/create`: accepts subject, predicate, object, statement, optional times. System assigns `manual` source per user. `scope = personal` (manual entries are always personal). `assertedByKind = "user"`. Status defaults `active`; lifecycle runs.
- `POST /claim/update`: status transition (`active → retracted` only).
- `POST /claim/delete`: hard delete; cleanup workflows.
- `POST /alias/create`, `POST /alias/delete`: unchanged.
- `POST /node/get`: returns the node card shape (alias-annotated, summary, claim groupings).
- `POST /node/merge`: rewires claims (subject and object) and aliases; promotes removed label to alias on kept node. Scope-bounded — refuses to merge across scopes (returns 4xx with a clear message).
- `POST /source/register`: requires `scope` (default `personal` if omitted). Used for document and reference ingestion.
- `POST /transcript/ingest`: new entry point for `meeting_transcript` and `external_conversation` ingestion. Accepts raw text or pre-segmented utterances, optional `knownParticipants` hints, optional `userSelfAliases` overrides.

## Dedup / Cleanup

### Dedup sweep

Behavior unchanged in spirit; updates:

- Refuses cross-scope merges (matches identity resolution).
- Considers `assertedByKind` when deduplicating claims after rewiring — claims that differ only in provenance are preserved (a `user`-asserted claim and a `participant`-asserted claim about the same fact are both kept; their union is the evidence base).

### LLM-guided cleanup

Operations:

- `merge_nodes` (scope-bounded).
- `retract_claim` (sets `status = 'retracted'`).
- `contradict_claim` (sets `status = 'contradicted'`, requires citation, fills `contradictedByClaimId`).
- `add_claim` (cleanup's synthetic source; `assertedByKind = 'system'`).
- `add_alias` / `remove_alias`.
- `promote_assertion` (new): converts an `assistant_inferred` claim to `user_confirmed` when the cleanup pass finds explicit corroboration. Implemented as a write to a new claim that supersedes (single-valued) or coexists (multi-valued).

The cleanup prompt is updated to emit `assertionKind` for `add_claim` operations and to use the bootstrap context (Atlas + open commitments + preferences) as structured persistent context.

## Operational Contracts

Every concept lands with the full path filled in. The matrix below is the gate: a concept doesn't ship without all rows.

### `HAS_TASK_STATUS` and the Task node type

| Slot                | Wiring                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Producer            | Extraction LLM emits `attributeClaim` with predicate `HAS_TASK_STATUS` and `objectValue ∈ TaskStatusEnum`; manual `/claim/create` accepts it. Background re-evaluation never auto-emits status changes. |
| Validation          | `attributeClaimSchema` (Zod) constrains predicate + objectValue. Insertion path validates Task node type for the subject.                                                                               |
| Storage             | `claims` row with `subject = Task node`, `predicate = 'HAS_TASK_STATUS'`, `objectValue` enum string, scope=personal, assertedBy from extraction.                                                        |
| Lifecycle           | Registry: `single_current_value + supersede_previous + forceRefreshOnSupersede=true`. Engine recomputes per `(user, taskNode, HAS_TASK_STATUS)`. Sets `supersededByClaimId` on prior.                   |
| Atlas               | Excluded (`feedsAtlas: false`).                                                                                                                                                                         |
| Default retrieval   | Surfaced only via `getOpenCommitments` and the `open_commitments` bootstrap section. Latest status only; `done`/`abandoned` excluded from "open" list.                                                  |
| Reference retrieval | N/A (Tasks are personal-scope).                                                                                                                                                                         |
| Read surface        | `open_commitments` section in `getConversationBootstrapContext`; `getOpenCommitments` API; Task cards in `getEntityContext`.                                                                            |
| Eval                | Regression story: pending → done across sessions; bootstrap on day 2 omits the done task and includes it in `recent_supersessions` for one cycle, then drops.                                           |

### `scope` (sources + claims)

| Slot                | Wiring                                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Producer            | Source registration API requires `scope`; defaults `personal`. Claims inherit on insert (denormalized).                                                                                                                 |
| Validation          | `CHECK` constraints on both tables; Zod enums at API boundaries.                                                                                                                                                        |
| Storage             | `sources.scope`, `claims.scope`.                                                                                                                                                                                        |
| Lifecycle           | None directly; scope is immutable.                                                                                                                                                                                      |
| Atlas               | Filters to `scope = personal` only.                                                                                                                                                                                     |
| Default retrieval   | `searchMemory` defaults to `scope = personal`.                                                                                                                                                                          |
| Reference retrieval | `searchReference` filters to `scope = reference`.                                                                                                                                                                       |
| Read surface        | Bootstrap excludes reference; node cards expose `scope`; reference nodes carry `author`/`title`. Identity resolution and dedup are scope-bounded.                                                                       |
| Eval                | Regression story: ingest a reference document; bootstrap excludes any `HAS_PREFERENCE`-shaped claims from it; `searchReference` returns its content; `searchMemory` does not. Cross-scope merge attempt fails with 4xx. |

### `assertedBy` (kind + nodeId)

| Slot                | Wiring                                                                                                                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Producer            | Extraction emits `assertionKind` per claim. Speaker map resolves `assertedBySpeakerLabel` to `nodeId` for `participant` kind. System-authored claims (Atlas/Dream/day) hardcode `kind: "system"`. Manual `/claim/create` hardcodes `kind: "user"`.                                                 |
| Validation          | Zod enum + post-LLM speaker resolution; `participant` claims with unresolvable labels are rejected. DB CHECK enforces `nodeId` presence for `participant`.                                                                                                                                         |
| Storage             | `claims.asserted_by_kind`, `claims.asserted_by_node_id`.                                                                                                                                                                                                                                           |
| Lifecycle           | Sort tiebreaker: `user`/`user_confirmed` preferred over `assistant_inferred`. `assistant_inferred` cannot supersede `user`/`user_confirmed`.                                                                                                                                                       |
| Atlas               | Excludes `assistant_inferred`, `document_author`.                                                                                                                                                                                                                                                  |
| Default retrieval   | Excludes `assistant_inferred`. Reranker may downweight `participant`-about-third-party.                                                                                                                                                                                                            |
| Reference retrieval | Returns `document_author` claims.                                                                                                                                                                                                                                                                  |
| Read surface        | Node cards expose evidence with `assertedBy` so the LLM (and visualization) can see who said it.                                                                                                                                                                                                   |
| Eval                | Regression stories: assistant fabrication fixture (claim either not extracted or `kind=assistant_inferred` and excluded from bootstrap and default search); user confirmation fixture (claim's `kind` flips on the next supersession); transcript fixture (claims attributed to correct speakers). |

### Multi-party transcripts & speaker mapping

| Slot              | Wiring                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Producer          | `POST /transcript/ingest` (new). Memory layer detects/segments raw text into utterances, extracts speaker labels, resolves via `userSelfAliases` + alias system, creates placeholder Person nodes for unresolved labels. |
| Validation        | At source registration; failed speaker resolutions are non-fatal (placeholder nodes), but flagged for cleanup.                                                                                                           |
| Storage           | Parent transcript source + per-utterance child sources, each with `metadata.speakerNodeId`; alias rows when speakers are first resolved.                                                                                 |
| Lifecycle         | None at the speaker layer; resulting claims follow standard lifecycle.                                                                                                                                                   |
| Atlas             | Indirect — transcript-derived claims about the user feed Atlas the same way conversation claims do.                                                                                                                      |
| Default retrieval | Indirect; speaker info is exposed via claim `assertedBy`.                                                                                                                                                                |
| Read surface      | Node cards for the participants surface; transcripts visible via existing source-link queries; visualization can render the participant graph.                                                                           |
| Eval              | Regression story: meeting transcript with three speakers including the user; claims correctly attributed; Marcel-assigned task becomes a personal `open_commitment`.                                                     |

### Read models / `ContextBundle`

| Slot                | Wiring                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Producer            | New assemblers in `src/lib/context/` per section. Each section's predicates and filters come from the registry.                         |
| Validation          | Zod schemas for the bundle response.                                                                                                    |
| Storage             | Cached per user with invalidation on registry-`forceRefreshOnSupersede` events; stored alongside the existing Atlas node.               |
| Lifecycle           | Insertion flow enqueues invalidation when relevant claims change.                                                                       |
| Atlas               | The `atlas` section IS the renamed Atlas.                                                                                               |
| Default retrieval   | The bundle is returned by `getConversationBootstrapContext` and friends.                                                                |
| Reference retrieval | `searchReference` is a separate API; not part of the bootstrap bundle.                                                                  |
| Read surface        | MCP tools mirror the SDK methods; tool descriptions are part of the design (see [MCP Tool Descriptions](#mcp-tool-descriptions) below). |
| Eval                | Regression story: every section's filters honored; bundle stays under token budget; raw graph endpoints still return claim data.        |

### MCP Tool Descriptions

The text the assistant sees is part of the design (it's the only signal it has about when to use what):

- `bootstrap_memory`: "Returns the user's persistent memory context for this conversation. Treat its sections as authoritative for the user's stable facts, current preferences, open commitments, and recently completed work. Do not re-prompt completed items as pending."
- `search_memory`: "Searches the user's personal memory for facts about themselves, their work, their relationships, and their commitments. Use when you need specific information about the user."
- `search_reference`: "Searches the user's reference corpus — books, articles, and documents they've ingested for ideas and frameworks. Use when reasoning about ideas, frameworks, or content the user wants you to draw on. Does not contain personal facts about the user."
- `get_entity`: "Returns a compact card for a known entity (person, project, task, etc.) including its summary, current facts, and recent supporting evidence."
- `list_open_commitments`: "Returns the user's currently open tasks and commitments. Call before answering about outstanding, next, pending, follow-up, completed, or abandoned work unless this model input already includes an open_commitments section. Always uses the latest status; never returns completed work."

These strings must live in code (`src/lib/mcp/mcp-server.ts`) as each tool lands, under code review, with eval coverage that verifies they're present and unchanged in tool registration. `list_open_commitments` is already implemented; the other snake_case tools are still target surface.

## Eval Harness

Location and structure unchanged from 2026-04-24. Six regression stories from the original design, plus 2026-04-26 additions:

7. **Pending task across sessions** — meeting transcript creates a Task with `HAS_TASK_STATUS=pending` owned by the user; next-day chat says "I sent the spec"; bootstrap on day 3 does NOT list the task as open.
8. **Assistant fabrication** — assistant says "you mentioned you're vegetarian"; user does not confirm; bootstrap on next day does not include `is vegetarian` as a personal fact; default search does not return it.
9. **Reference scope isolation** — ingest a Marcus Aurelius excerpt as `scope=reference`; bootstrap context contains no claims sourced from it; `searchReference` returns it; `searchMemory` does not; identity resolution does not merge "Marcus" the friend with "Marcus Aurelius."
10. **Multi-party transcript** — meeting with Marcel, Jane, Bob; "Jane will send the budget by Friday" produces a Task owned by Jane (not Marcel); claims about Bob asserted by Jane carry `assertedBy: participant:jane`.
11. **Cross-scope merge attempt** — try to merge a personal Person node with a reference Author node; API returns 4xx; no rows changed.

Threshold-calibration sub-harness from 2026-04-24 unchanged.

## Implementation Sequence

The implementation plan companion (`2026-04-24-claims-implementation-plan.md`) carries the phase-by-phase task lists. Updated phasing summary:

- **Phase 1** — schema + provenance backbone. **Landed.**
- **Phase 2a** — claims-native extraction + lifecycle v1 + alias authoring. **Landed.**
- **Phase 2b** — registry + scope + provenance columns + extraction wiring + lifecycle generalization + open-commitments minimum. (New, this revision.)
- **Phase 3** — profile synthesis + identity upgrade + Atlas derivation + read-model assemblers + MCP tools. (Existing Phase 3, expanded.)
- **Phase 4** — transcript ingestion path + cleanup rewrite + full eval harness + threshold calibration. (Existing Phase 4 extended; transcripts move here because they lean on the upgraded identity resolution from Phase 3.)

## Acceptance Checks

From 2026-04-24 (still required):

- A claim cannot be stored without `sourceId`, `subjectNodeId`, `predicate`, `statement`, `statedAt`, `status`.
- A claim has exactly one object shape.
- Reprocessing the same source replaces that source's claims.
- Active search excludes claims whose `validTo` is before query `asOf`.
- Dedup merge rewires claims and aliases; promotes removed label.
- Aliases normalize on insert; resolve in identity resolution.
- All six original regression stories pass.

Added 2026-04-26:

- Every claim carries a non-null `scope` and `assertedByKind`.
- `searchMemory` defaults exclude `scope = reference` and `assertedByKind = assistant_inferred`.
- `getConversationBootstrapContext` returns a `ContextBundle` with `pinned`, `atlas`, `open_commitments`, `recent_supersessions`, `preferences` sections and never lists `done` tasks as open.
- `getOpenCommitments` returns only `pending` and `in_progress` tasks; supersession on `HAS_TASK_STATUS` invalidates the cache before the next bootstrap.
- `searchReference` is a distinct MCP tool with its own description; default `searchMemory` does not return reference results.
- Cross-scope merges return 4xx and change no rows.
- Identity resolution (when Phase 3 lands) does not propose merges across scopes.
- Transcript ingestion (when Phase 4 lands) attributes claims to the correct speaker; user-self utterances become `assertedByKind = "user"`, not `participant`.
- Raw graph endpoints (`/node/get`, `/node/neighborhood`, `/query/graph`, `/query/timeline`, `/query/day`) continue to return claim and node data with the new fields included.
- All five 2026-04-26 regression stories pass.

## Open Questions

From 2026-04-24 (still open):

1. Document source granularity (per-paragraph citation).
2. Contradiction-detection prompt tuning.
3. Profile synthesis cadence.
4. Identity resolution thresholds.

Added 2026-04-26:

5. **`recent_supersessions` decay window.** 24h is a starting guess. Real cadence depends on how long users go between conversations.
6. **`assertionKind` in extraction prompts.** The model may struggle to set `kind` reliably for multi-party transcripts. Likely needs few-shot examples; eval harness drives calibration.
7. **`reference_lens` content.** Currently empty. If/when a real workflow demands always-present reference distillation, this slot is reserved.
8. **Speaker placeholder churn.** Unresolved transcript speakers create placeholder nodes; if cleanup doesn't keep up, the graph fills with `Speaker 3` placeholders. May need a TTL or a low-confidence flag that retrieval suppresses.

## References

- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560)
- [From Local to Global: A Graph RAG Approach to Query-Focused Summarization](https://www.microsoft.com/en-us/research/publication/from-local-to-global-a-graph-rag-approach-to-query-focused-summarization/)
- [HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models](https://arxiv.org/abs/2405.14831)
- [Graphiti overview](https://help.getzep.com/graphiti/getting-started/overview)
- [LangGraph memory concepts](https://docs.langchain.com/oss/javascript/concepts/memory)
- [ENGRAM: Effective, Lightweight Memory Orchestration for Conversational Agents](https://arxiv.org/abs/2511.12960)
