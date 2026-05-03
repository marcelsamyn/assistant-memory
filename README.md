# Assistant Memory

_Give all your AI assistants **combined, long-term** memory while keeping full control of your data._

Assistant Memory is a lightweight memory service built around the **Model Context Protocol (MCP)**. It speaks MCP over HTTP today (stdio support is on the way) and also exposes classic REST endpoints. Store conversations and documents and let any MCP-enabled assistant recall them when needed.

## Model Context Protocol

The integrated MCP server provides tools for saving memories, performing searches and retrieving day summaries. Because it follows the MCP standard, any compliant client can plug in and exchange messages seamlessly.

## Chat assistant integration contract

Use Assistant Memory as a sidecar to the chat runtime. The chat host, not the LLM, owns the main orchestration loop: it sends source material to memory, fetches bounded context before model calls, and decides which memory tools are available to the assistant.

### Actors

- **Chat host**: the application server that owns `userId`, `conversation.id`, message IDs, model calls, and prompt assembly.
- **Assistant model**: the LLM that sees rendered memory context or calls MCP tools. It should not talk directly to the database.
- **Assistant Memory service**: the HTTP/MCP service that stores sources, extracts claims, applies lifecycle, and serves search/read APIs.
- **Worker queue**: background jobs that process ingestion. Ingestion is accepted synchronously but memory extraction is asynchronous.
- **Memory UI/debugger**: optional tooling that can use raw graph endpoints for inspection and repair. This is separate from the normal chat loop.

### Current REST loop

This is the integration that works with the current code.

1. **When a new chat session opens, the chat host fetches bootstrap context.**

   Call `POST /query/atlas` before the first LLM call:

   ```json
   {
     "userId": "user_123",
     "assistantId": "assistant_abc"
   }
   ```

   The response is `{ "atlas": string }`. Put that string in a developer/system context block, not in the user message. If the session is day-sensitive, also call `POST /query/day`:

   ```json
   {
     "userId": "user_123",
     "date": "2026-04-26",
     "includeFormattedResult": true
   }
   ```

2. **Before an LLM call, the chat host searches only if the turn needs memory.**

   Call `POST /query/search`. Do not run a separate LLM just to invent search keywords. The default query is the current user message text. If the host already has structured UI context, append it in a fixed template:

   ```json
   {
     "userId": "user_123",
     "query": "Current user message: Continue with the next part of the memory refactor.\nActive task: claims-first memory implementation plan\nSelected entity: Assistant Memory",
     "limit": 8,
     "excludeNodeTypes": ["AssistantDream", "Temporal"],
     "conversationId": "chat_456"
   }
   ```

   Use `formattedResult` as a clearly labeled memory evidence block. Do not dump `searchResults` directly into the prompt unless the caller has its own renderer. Prefer one targeted search over many broad searches.

   Search query construction rules:

   - Use the latest user message verbatim as the required query input.
   - Append only host-known context: active task title, selected project/entity labels, conversation title, or route/page context.
   - Do not ask another LLM to summarize, keyword-expand, or infer the topic before every search. That adds latency and another failure mode.
   - Do not include the full transcript. If the latest message is anaphoric ("yes, do that"), append at most the host-known active task/title or the immediately preceding user-visible topic.
   - If the assistant is using MCP tools instead of host-side prefetch, the assistant can call `search memory` during its normal tool-use loop with a natural-language query. That is not a separate pre-call query-rewrite step; it is a tool call made because the model decided it needs memory.

3. **Expose open commitments through a deterministic host policy or a model tool rule.**

   The host cannot know the assistant's future sentence plan. It must use one of these two explicit integration modes:

   - **Host-prefetch mode**: the chat host calls `POST /commitments/open` and renders an `open_commitments` memory section before the model call. Do this unconditionally on session bootstrap. Do it again before a model call when the current UI route/surface is a task, planning, reminders, project-status, or daily-brief surface; when the user selected a Task/Project/Person node; or after an ingestion job that inserted or superseded a `HAS_TASK_STATUS` claim.
   - **Tool-use mode**: the host exposes MCP `list_open_commitments` and includes the model instruction below. In this mode the assistant model decides during normal tool use, not via a separate pre-call classifier.

   Model instruction for tool-use mode:

   ```text
   Use `list_open_commitments` before you answer with any statement about the user's open, pending, in-progress, completed, abandoned, outstanding, next, or follow-up work, unless the current model input already contains a `<section kind="open_commitments">` rendered for this same model call.

   Call it for user requests such as:
   - "what should I do next?"
   - "what is still open?"
   - "continue with the next part"
   - "remind me what I owe"
   - "summarize pending work"
   - "is X done?"
   - "plan my day/project/week"

   If the user names a known assignee/person and you have their node id, pass `ownedBy`.
   If the user gives a date cutoff, pass `dueBefore` as YYYY-MM-DD.
   Do not infer pending work from semantic search results.
   ```

   The REST call is:

   ```json
   {
     "userId": "user_123",
     "ownedBy": "node_01kq54zhdwe4a94mj9nrrnne4h",
     "dueBefore": "2026-04-30"
   }
   ```

   `ownedBy` is an optional Person node ID. `dueBefore` is an optional inclusive `YYYY-MM-DD` cutoff; when present, undated tasks are excluded. The response is:

   ```json
   {
     "commitments": [
       {
         "taskId": "node_01kq5509kfe4a94mj5k20j5z6y",
         "label": "Send the spec",
         "status": "pending",
         "owner": {
           "nodeId": "node_01kq54zhdwe4a94mj9nrrnne4h",
           "label": "Marcel"
         },
         "dueOn": "2026-04-27",
         "statedAt": "2026-04-01T10:00:00.000Z",
         "sourceId": "src_01kq54zhdye4a94mjmw0wev9jx"
       }
     ]
   }
   ```

   Prompt rendering in host-prefetch mode:

   ```xml
   <section kind="open_commitments" as_of="2026-04-26T13:15:00.000Z" usage="Use this as the only source of pending work. Do not infer pending work from semantic search.">
     <commitment task_id="node_01kq5509kfe4a94mj5k20j5z6y" status="pending" owner="Marcel" due_on="2026-04-27" source_id="src_01kq54zhdye4a94mjmw0wev9jx">Send the spec</commitment>
   </section>
   ```

   Treat this endpoint, not semantic search, as the source of truth for pending work. It reads the newest active `HAS_TASK_STATUS` claim for each Task and only returns `pending` or `in_progress`; completed and abandoned tasks stay out even if older search hits mention them as pending.

4. **After each persisted turn, the chat host queues ingestion.**

   Call `POST /ingest/conversation` after a user message is saved and again after the assistant response is saved, or once per complete turn pair:

   ```json
   {
     "userId": "user_123",
     "conversation": {
       "id": "chat_456",
       "messages": [
         {
           "id": "msg_001",
           "role": "user",
           "content": "Let's continue the claims refactor.",
           "timestamp": "2026-04-26T13:00:00.000Z"
         },
         {
           "id": "msg_002",
           "role": "assistant",
           "content": "I'll inspect the plan and continue with the next slice.",
           "timestamp": "2026-04-26T13:00:12.000Z"
         }
       ]
     }
   }
   ```

   Message IDs must be stable and immutable. The ingestion path deduplicates by source external ID; changing the content for the same message ID will not reliably rewrite memory.

5. **When ingesting documents, the caller must choose the scope at the boundary.**

   Use `POST /ingest/document`:

   ```json
   {
     "userId": "user_123",
     "updateExisting": false,
     "document": {
       "id": "doc_stoicism_notes",
       "content": "Document text...",
       "scope": "reference",
       "timestamp": "2026-04-26T13:10:00.000Z"
     }
   }
   ```

   Use `scope: "personal"` for user-specific notes and `scope: "reference"` for books, articles, external knowledge, and general source material. Do not rely on the extractor to infer scope from content.

6. **Raw graph endpoints are for tools, not ordinary chat context.**

   Use `POST /node/get`, `POST /node/neighborhood`, `POST /node/sources`, `/claim/*`, `/alias/*`, and `/node/merge` from a memory UI, debugger, or explicit edit flow. Do not expose destructive or repair tools to an autonomous assistant without a confirmation layer.

### Current MCP loop

MCP connects over `GET /sse` and `POST /messages`. Most current tool names are human-readable strings; the first claims-first read-model tool is already snake_case:

- `save memory`: document ingestion using the `POST /ingest/document` schema.
- `search memory`: calls the same search path as `POST /query/search`.
- `retrieve memories relevant for today`: calls the same path as `POST /query/day`.
- `list_open_commitments`: calls `POST /commitments/open` semantics and returns currently open tasks only. The model should call it before answering about outstanding, next, pending, follow-up, completed, or abandoned work unless an `open_commitments` section was rendered for this same model call.
- `get node` and `get node sources`: raw inspection tools.
- `read scratchpad`, `write scratchpad`, `edit scratchpad`: scratchpad operations.
- `update node`, `delete node`: raw edit tools; these should be gated by the host.

For a tool-using assistant, make `search memory` available on demand for personal lookup and `list_open_commitments` available with the instruction above. The host should still proactively inject bootstrap context at session start because the current MCP server does not yet expose a true bootstrap tool.

### Target read-model loop

The claims-first refactor is moving toward this assistant-facing MCP/SDK surface. These names describe the intended contract; some are not implemented yet.

1. **Session start**: the chat host calls `bootstrap_memory({ userId, asOf? })` before the first LLM call. The result is a `ContextBundle` with sections such as `pinned`, `atlas`, `preferences`, `open_commitments`, and `recent_supersessions`. Each section includes a usage hint and optional evidence refs.
2. **Personal lookup**: the assistant or host calls `search_memory({ userId, query, limit?, asOf? })` only when the current turn needs specific user memory. It returns personal node cards plus evidence, not raw graph rows.
3. **Reference lookup**: the assistant or host calls `search_reference({ userId, query, limit?, asOf? })` only for books, articles, documents, frameworks, and ideas from the user's reference corpus. Its results must not be treated as personal facts about the user.
4. **Planning and follow-up**: the host either renders an `open_commitments` section before the model call or the assistant calls `list_open_commitments({ userId, ownedBy?, dueBefore? })` inside the normal tool loop before answering about outstanding, next, pending, follow-up, completed, or abandoned work. This read model is implemented; later phases wire it into bootstrap bundles.
5. **Known entity lookup**: the assistant or host calls `get_entity({ userId, nodeId })` after search returns an entity or the assistant already has a node ID. This returns a compact card with summary, current facts, commitments, aliases, and evidence.

### Prompt contract

Memory should be rendered as context with provenance, not as user text:

```xml
<assistant_memory as_of="2026-04-26T13:15:00.000Z">
  <section kind="atlas" usage="Stable personal context. Prefer current user statements if they conflict.">
    ...
  </section>
  <section kind="open_commitments" usage="Pending or in-progress only. Do not reintroduce completed work as pending.">
    ...
  </section>
  <section kind="evidence" usage="Relevant sourced memories for this turn. Use cautiously and mention uncertainty on conflict.">
    ...
  </section>
</assistant_memory>
```

The assistant should follow these rules:

- Treat the current user message as fresher than memory when they conflict.
- Never convert reference material into a claim about the user.
- Never treat assistant-only speculation as a user fact.
- Treat `open_commitments` as the only source of pending tasks once that section exists.
- Use evidence refs for inspection, citations, and repair flows; do not expose raw claim IDs in normal prose unless the product asks for them.

### Reflection checks

The integration only works if these are true:

- **Search query construction is deterministic**: host-side prefetch uses the current user message plus host-known labels. It does not require an extra LLM call to rewrite queries.
- **Stable source IDs**: conversation and document IDs are stable. Otherwise ingestion is not idempotent.
- **Async freshness is understood**: a just-queued ingestion job may not be visible to the next search. The host should not assume read-after-write unless it waits for the job pipeline.
- **Reference isolation is complete**: default personal memory must exclude reference claims and reference-derived node cards. The current graph search path scope-bounds claims, one-hop traversal, and node similarity; the target card-shaped `search_memory` must preserve that behavior.
- **Lifecycle drives commitments**: open tasks must come from latest `HAS_TASK_STATUS`, not from old search hits. Otherwise completed work will resurface as pending.
- **Tool descriptions are part of behavior**: MCP descriptions must tell the model when to use `search_memory` vs. `search_reference` vs. `list_open_commitments`, and those descriptions need snapshot tests.
- **Raw edit tools are gated**: node/claim merge, update, and delete operations need a user-confirmed workflow, not free autonomous model access.

## HTTP API

- `POST /ingest/conversation` and `POST /ingest/document` – send new information to be stored.
- `POST /query/search` – vector search to retrieve relevant nodes.
- `POST /commitments/open` – lifecycle-aware list of pending and in-progress tasks.
- `POST /query/day` – get a quick summary of a particular day.
- `GET /sse` and `POST /messages` – MCP over HTTP using Server‑Sent Events.

## Metrics

Assistant Memory also stores numeric time-series readings separately from claims. Use this for values such as body weight, running distance, pace, heart rate, sleep duration, readiness scores, and steps.

Write paths:

- `POST /metrics/observations` records one explicit reading and can create or reuse a metric definition.
- `POST /metrics/observations/bulk` records many readings by existing metric slug. Bulk imports never create definitions; unknown slugs are returned as per-row errors.
- Conversation and document ingestion can extract metrics implicitly and attach event-linked readings to Event nodes.

Single write example:

```json
{
  "userId": "user_123",
  "metric": {
    "slug": "body_weight",
    "label": "Body weight",
    "description": "Morning bathroom scale weight",
    "unit": "kg",
    "aggregationHint": "avg"
  },
  "value": 78.2,
  "occurredAt": "2026-05-03T07:30:00Z",
  "note": "post-run"
}
```

Read paths:

- `POST /metrics/list` returns definitions with units, review state, and lightweight stats.
- `POST /metrics/series` returns raw or bucketed points for one or more metric definitions.
- `POST /metrics/summary` returns latest value, 7d/30d/90d stats, and a coarse trend.

New definitions are deduplicated by exact slug first, then definition embedding similarity. Near-duplicate definitions are created with `needsReview: true` and surfaced as normal open Task commitments.

## Why use it?

- Keep sensitive data on your own servers.
- Turn large transcripts and documents into a searchable graph.
- Drop in as a microservice alongside your existing assistant.

---

Spin it up with `docker-compose up` and start talking. Your assistant will finally remember everything.
