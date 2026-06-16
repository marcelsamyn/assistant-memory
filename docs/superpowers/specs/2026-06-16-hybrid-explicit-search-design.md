# Hybrid Explicit Search: Lexical + Vector Retrieval for Memory

**Date:** 2026-06-16
**Status:** Design — pending plan

## Problem

Production retrieval is **purely semantic**: Jina v3 embeddings over
`node_embeddings` / `claim_embeddings`, HNSW cosine, with a hardcoded `0.4`
similarity floor (`src/lib/context/search-cards.ts`). There is a substring
`LIKE` path in `src/lib/graph.ts` but it is an eval-only test seam, never
wired into production.

Pure embedding similarity is the wrong primary index for **explicit search** —
a human typing into the Petals memory explorer, or an assistant deliberately
looking something up:

- Exact / rare tokens fail to rank: project codenames, acronyms, IDs, people's
  names, exact phrases. Embeddings smear these into nearest neighbours.
- The `0.4` floor silently drops weak-but-only matches. Someone who types
  "Boox" expects *everything* mentioning Boox, ranked — not "top-k above a
  magic cosine threshold".
- No substring / prefix / typo tolerance, so type-ahead and half-remembered
  words don't work.
- No facets. The graph is rich (entity type, time, source, scope) but search
  exposes almost none of it.

Semantic recall is exactly right for the *background* context the system
injects automatically each turn. It is wrong for retrieval a user or assistant
asks for *on purpose*. This design adds a dedicated hybrid (lexical + vector)
explicit-search surface and draws a clear boundary between the two intents.

## Decisions (settled during brainstorming)

1. **Separate explicit-search endpoint.** A new `POST /search`. Background
   context injection keeps using `POST /context/search` (semantic only, cards,
   unchanged). Graph visualization keeps using the legacy `POST /query/search`
   (raw graph, unchanged). The stateable rule: **`/context/*` is what the
   system pulls in automatically; `/search` is what someone asks for on
   purpose.**
2. **Hybrid is a property of explicit retrieval, not background injection.**
   Background context is fed natural-language conversation text where semantic
   similarity is right and keyword matching adds noise. Explicit search is
   where exact names, IDs, quoted phrases, and typo-tolerance matter.
3. **Native Postgres lexical engine.** `tsvector` + GIN for keyword/phrase
   ranking, `pg_trgm` for fuzzy/typo/prefix. No ParadeDB / external search
   engine. `pgvector` is already present; only `pg_trgm` is newly required.
4. **Ranked hits with highlights** as the result shape (not cards, not raw
   graph). An ordered list of hits, each showing *why* it matched.
5. **Reciprocal Rank Fusion (RRF)** to merge the lexical and vector rankings —
   no cross-engine score normalisation.
6. **v1 facets: entity type + time range.** Scope stays single-valued (default
   `personal`, never blended in one response). Source-type facet is deferred.
7. **Reranking off by default** for v1. Keyword intent + RRF is strong, and a
   semantic cross-encoder can fight exact-match queries. A seam is left to
   enable Jina reranking later.

## Conceptual model

Three retrieval intents, separated by endpoint:

| Intent | Endpoint | Engine | Result shape |
| ------ | -------- | ------ | ------------ |
| Background context (auto-injected each turn) | `POST /context/search` | semantic only | cards (`NodeCard[]` + evidence) — unchanged |
| **Explicit search** (human types, or assistant looks up) | **`POST /search`** (new) | **hybrid** (lexical + vector, RRF) | ranked `SearchHit[]` + highlights |
| Graph visualization | `POST /query/search` (legacy) | semantic | raw graph — unchanged |

## Data model & indexes

No table changes. Add generated columns + indexes via a Drizzle migration.

### Lexical full-text (tsvector + GIN)

Generated `tsvector` columns, so backfill is automatic and they stay in sync
with the source text:

- `claims.search_tsv` = `to_tsvector('english', coalesce(statement,'') || ' ' || coalesce(description,''))`,
  `STORED GENERATED`, GIN-indexed.
- `node_metadata.search_tsv` = `to_tsvector('english', coalesce(label,'') || ' ' || coalesce(description,''))`,
  `STORED GENERATED`, GIN-indexed.

Drizzle lacks first-class generated-`tsvector` support; the generated columns
and GIN indexes are declared via `sql` in the migration and represented in
`schema.ts` with `.generatedAlwaysAs(sql\`...\`)` where expressible, otherwise
as a raw migration step with a matching column declaration for typing. (The
plan resolves the exact Drizzle representation against the installed version.)

### Fuzzy / prefix (pg_trgm + GIN)

- `CREATE EXTENSION IF NOT EXISTS pg_trgm;`
- GIN trigram index on `node_metadata.label` (`gin_trgm_ops`).
- GIN trigram index on `claims.statement` (`gin_trgm_ops`).

Trigram covers typo tolerance, substring, and prefix-as-you-type — promoting
the eval-only `LIKE` path into a real indexed feature.

### Vector (unchanged structurally)

Existing HNSW cosine indexes on `node_embeddings` / `claim_embeddings`. The
only behavioural change is **the `0.4` similarity floor is not applied on the
`/search` path** (explicit search ranks rather than thresholds).

## Retrieval core

New shared retrieval functions in `src/lib/graph.ts` (alongside the existing
`findSimilarNodes` / `findSimilarClaims`), each returning ranked id lists so
they compose:

- `findNodesByLexical(db, params)` — `websearch_to_tsquery('english', query)`
  against `node_metadata.search_tsv`, ranked by `ts_rank_cd`, unioned with a
  `pg_trgm` `similarity()` match on `label` for fuzzy/prefix. Applies the same
  SQL filters (`userId`, scope, `notInArray(nodeType, …)`).
- `findClaimsByLexical(db, params)` — same against `claims.search_tsv` /
  `claims.statement`, with the existing claim filters (status, validity,
  asserted-by-kind) plus the new time-range filter.
- `ts_headline('english', text, query)` produces the highlight snippet for each
  hit.

### Fusion (pure, unit-tested)

New `src/lib/search/fusion.ts`:

```
rrf(rankings: RankedId[][], k = 60): FusedId[]
```

Reciprocal Rank Fusion: each id's score is `Σ 1/(k + rank_in_list)` across the
lexical and vector rankings, sorted descending. Pure function over id+rank
lists — no DB, no embeddings, trivially testable. `k` is a named constant.

### Pipeline (`src/lib/search/explicit-search.ts`)

1. Embed the query (`retrieval.query`, existing `embeddings.ts`) **and** run
   lexical retrieval, in parallel.
2. Vector legs: `findSimilarNodes` / `findSimilarClaims` **with no similarity
   floor**, returning ranked ids.
3. Lexical legs: `findNodesByLexical` / `findClaimsByLexical`.
4. Fuse node rankings and claim rankings via `rrf`.
5. Hydrate the fused top-`limit` ids into `SearchHit`s (label/statement,
   highlight, source provenance, `statedAt`, fused score).
6. Optional rerank seam (default off): if enabled, pass hydrated hit texts
   through `src/lib/rerank.ts` before the final cut.

## The `/search` endpoint

`src/routes/search.post.ts`. Request schema (`src/lib/schemas/search.ts`):

```ts
{
  userId: string,
  query: string,                // min length 1
  limit?: number,               // default 20, max 50
  scope?: "personal" | "reference", // default "personal"; never blended
  filters?: {
    entityTypes?: NodeType[],   // include-filter (inverse of excludeNodeTypes)
    statedBetween?: { from?: Date, to?: Date }, // new claim time-range filter
  },
}
```

Response:

```ts
{
  query: string,
  hits: SearchHit[],            // ordered by fused score, descending
}

type SearchHit = {
  kind: "node" | "claim",
  nodeId: TypeId<"node">,       // owning entity (subject for claim hits)
  claimId?: TypeId<"claim">,    // present when kind === "claim"
  text: string,                 // label (node) or statement (claim)
  highlight: string,            // ts_headline snippet
  score: number,                // fused RRF score
  source: { type: SourceType, title?: string, author?: string },
  statedAt?: Date,              // for claim hits
}
```

Scope is a hard boundary as elsewhere: a `personal` request never surfaces
`reference` material and vice versa. The time-range filter is a small addition
to the claim query (today only an `asOf` cutoff exists, no range).

**Time range and node hits.** `statedBetween` filters **claim** hits directly
by `claims.stated_at`. Nodes (entities) have no intrinsic time and are treated
as timeless: in v1 a time range narrows the claim hits but does not drop entity
hits (you still want the "Boox" entity itself to surface for "Boox in May").
Entity-level time gating is deferred.

**Scope is single-valued and exact.** `scope: "personal"` returns only personal
material; `scope: "reference"` returns only reference. This requires an explicit
`scope` filter on the retrieval functions — the existing `includeReference`
boolean means "personal OR both", which would blend scopes and is not used on
this path.

## Surfaces & downstream consumers

- **SDK** (`src/sdk/memory-client.ts`): new `async search(payload): Promise<SearchResponse>`
  → `POST /search`, validated by `searchResponseSchema`.
- **Petals manual explorer** (`~/code/petals`, `/memory/explore`): migrate the
  `searchMemory` server fn from `querySearch` → `search()`, and render ranked
  hits with highlights (replacing the node/connection/edge card view). Done in
  a dedicated Petals worktree.
- **n8n node** (`n8n-nodes-petals`) + **Petals proxy endpoint**: add the
  `search` operation so automation users get it, per the repo's
  downstream-consumers convention (CLAUDE.md).
- **Reranking:** Jina cross-encoder rerank is wired as an off-by-default seam in
  the pipeline; not exposed in the API in v1.

### Assistant search tool (recommended, open for spec review)

The assistant currently has the MCP `search_memory` tool → `/context/search`
(semantic cards) for "tell me about this entity". That stays. **Recommendation:**
add a *second* MCP tool, `search_text` (working name), → `/search`, described
for exact / keyword / "find where I mentioned X" lookups. Two tools with
distinct intents rather than repointing the pinned `search_memory` contract
(whose card shape suits entity recall and whose description is snapshot-pinned
in `mcp-server.test.ts`).

Alternative considered: repoint `search_memory` to `/search`. Rejected for v1 —
it is a breaking shape change (cards → hits) to a load-bearing pinned tool, and
the two genuinely serve different jobs. The new assistant tool can also be
deferred to a fast-follow if we want v1 to be manual-UI-only; flagged for the
review gate.

## Testing strategy

- **Fusion** (`fusion.test.ts`): pure RRF unit tests — ordering, tie-breaking,
  `k` behaviour, empty inputs.
- **Lexical retrieval**: tests on `:5431` (CI does not run vitest — run locally)
  seeding realistic messy data: exact-token match, phrase via
  `websearch_to_tsquery`, typo via trigram, prefix, scope isolation, entity-type
  filter, time-range filter.
- **Endpoint** (`search.post.test.ts`): hits real server, asserts hit ordering,
  highlight presence, scope hard-boundary, error messages reach the client.
- **MCP tool** (if included): snapshot-pin the new tool description like the
  others; assert it calls `/search`.
- **Migration**: verify generated columns backfill on existing rows and the GIN
  indexes are used (EXPLAIN).

## Non-goals (YAGNI)

- No ParadeDB / Elasticsearch / external search engine.
- No source-type facet in v1.
- No blended-scope responses.
- No changes to background context injection or the legacy `/query/search`
  graph shape.
- No reranking in the v1 API surface (seam only).
- No multi-language `tsvector` configs — `'english'` only for v1.

## Migration / rollout order

1. Memory repo: extension + generated columns + indexes migration.
2. Retrieval core (lexical functions, fusion, pipeline) + tests.
3. `/search` endpoint + schema + tests.
4. SDK `search()` + release.
5. Petals worktree: explorer migration + (optional) assistant tool.
6. n8n node + proxy endpoint operation.
