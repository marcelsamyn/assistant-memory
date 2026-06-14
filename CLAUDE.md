# assistant-memory

Guidance for working in this repository.

## Downstream consumers

When adding an end-user-relevant SDK/MCP ingestion or metrics capability,
consider the hosted consumers that surface it: the Petals product
(`petals.chat`) proxies these endpoints and ships an n8n node
(`n8n-nodes-petals`). End-user-facing additions usually warrant a matching proxy
endpoint and node operation so automation users get them too.
