# Memory Layer Direction

## Purpose

Assistant Memory is a memory layer for language models. It ingests conversations and custom knowledge, extracts durable facts, and exposes a knowledge graph that assistants can query.

The graph should not be an unfiltered copy of whatever an extraction model noticed. The system needs clear boundaries between evidence, sourced claims, canonical entities, derived summaries, and the context returned to an assistant.

## Problems To Solve

- Temporal state: distinguish when something was said, when it was true, whether it is still current, and what replaced it.
- Provenance: every factual memory should be traceable to source evidence, and assistant-only suggestions should not become user facts unless confirmed.
- Entity identity: new facts should attach to existing entities when possible, while false merges remain worse than temporary duplicates.
- Compression: repeated use should make entity descriptions more generic and reusable; episode-specific facts should stay in claims and sources.
- Retrieval: memory context should prefer current, sourced facts and include historical facts only when they are useful to the task.

## Memory Layers

1. Evidence sources: immutable source material, such as a conversation message, document, document chunk, or imported record.
2. Claims: sourced, time-aware assertions extracted from evidence.
3. Canonical graph: stable entities and current relationships queried from active claims.
4. Query context: the small, task-shaped packet handed to the assistant.

Claims are the factual source of truth. What previously looked like graph edges becomes claim-shaped memory; the canonical graph is the current view over active claims.

## Existing Surface

The project already has typed nodes and edges, source storage, embeddings, ingestion for conversations and documents, an Atlas, cleanup/dedup jobs, manual graph-editing APIs, and search that combines semantic retrieval with graph expansion.

The main gap is that extracted facts move too directly into the graph. Edges have `createdAt`, but factual memory does not yet have a first-class record for statement time, validity, lifecycle status, and evidence.

## Architecture Move

Move to claims-first memory:

- Evolve `edges` into `claims`; do not maintain parallel factual stores.
- Rename `edge_embeddings` to `claim_embeddings`.
- Require each factual memory to point at source evidence.
- Insert claims after candidate entities resolve to canonical nodes.
- Search claims directly and use active relationship claims for graph-neighbor views.
- Reprocess one source by replacing that source's claims instead of appending duplicates.
- Update dedup/merge code so claims are rewired when canonical nodes merge.
- Derive node descriptions and Atlas context from claims plus curated/pinned context.

This makes memory answers auditable and gives later compression passes a clean substrate.

## Derived Layers

Derived layers are allowed to be rich, as long as claims remain the factual substrate:

- Entity descriptions are textual summaries written and rewritten by LLM synthesis. They may contain compressed phrasing and nuance, but cleanup must reconcile them against active claims when rewriting.
- Atlas is persistent context derived from long-lived claims plus user-pinned context.
- Query context combines Atlas, relevant entities, active claims, source evidence, and historical claims when useful.
- Identity resolution uses labels, aliases, embeddings, and claim-profile compatibility.

## Regression Stories

Use a small eval set tied to the original failure modes:

- A project starts, then completes.
- A project is renamed.
- The same person is referred to by nickname and full name.
- An assistant suggestion is not confirmed by the user.
- A user correction supersedes an earlier belief.
- An old current-state item expires.

## References

- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560)
- [From Local to Global: A Graph RAG Approach to Query-Focused Summarization](https://www.microsoft.com/en-us/research/publication/from-local-to-global-a-graph-rag-approach-to-query-focused-summarization/)
- [HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models](https://arxiv.org/abs/2405.14831)
- [Graphiti overview](https://help.getzep.com/graphiti/getting-started/overview)
- [LangGraph memory concepts](https://docs.langchain.com/oss/javascript/concepts/memory)
- [ENGRAM: Effective, Lightweight Memory Orchestration for Conversational Agents](https://arxiv.org/abs/2511.12960)
