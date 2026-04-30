# SDK Consumer Migration Notes

Running record of SDK / REST / MCP changes that consumers (Petals, future
chat hosts, internal tooling) need to react to. Newest-first. Each entry is
concrete: what to delete, what to add, and what stays the same.

When in doubt, the plan
(`docs/2026-04-24-claims-implementation-plan.md`) has the *why*; this file
has the *what to change*.

---

## PR 3-iii — Card-shaped reads + snake_case MCP tools (this commit window)

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

| Removed (old) | Add (new) | Notes |
|---|---|---|
| `"search memory"` (returned XML string of raw similar nodes/claims/connections) | `search_memory` (snake_case; returns JSON `ContextSearchResponse`) | Default personal scope; never returns reference-derived cards. |
| — | `search_reference` (new) | Reference-scope only. Required when the prompt asks the model to cite curated material rather than the user's own memory. |
| — | `bootstrap_memory` (new) | Call **once** at conversation start. Returns the `ContextBundle` (pinned, atlas, open_commitments, recent_supersessions, preferences sections). Cached 6h per user; pass `forceRefresh: true` to bypass. Hosts that already render their own startup section may skip this and tell the model not to call it. |
| — | `get_entity` (new) | Single-entity card lookup by `nodeId`. Use after the model has an id from `search_memory` / `bootstrap_memory` and needs the full picture. |

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

## Earlier PRs

Earlier consumer-impacting changes are recorded as commit messages on `main`
(`git log --oneline`). Selected highlights, in case a consumer is jumping
forward several phases:

- `1436046` — `(predicate, subjectType)` cardinality axis. No SDK change; consumers reading task ownership see at most one current `OWNED_BY` / `DUE_ON` per Task.
- `3f78288` — Atlas now claim-derived. The Atlas REST surface is unchanged but content quality improves; consumers that cached old Atlas output should evict.
- `28f1fbe` — `getConversationBootstrapContext` exists internally; not yet on the SDK as a method (added via the `bootstrap_memory` MCP tool in `ff9e6f0`).
- `fe0ad01` — `NodeCard` synthesis exists internally; exposed via SDK / MCP in `ff9e6f0`.
- `43119f3` — SDK build/exports fix. If you saw missing exports before this, re-pin to a build at or after this commit.
