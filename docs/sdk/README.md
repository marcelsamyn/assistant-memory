# Memory SDK reference

`MemoryClient` is a typed TypeScript client for the Assistant Memory HTTP API. Each method is a thin wrapper around a `POST` endpoint, validates the response with a Zod schema, and throws on non-2xx status.

## Installation and setup

```ts
import { MemoryClient } from "./src/sdk/memory-client.js";

const client = new MemoryClient({
  baseUrl: "https://memory.example.com",
  apiKey: process.env.MEMORY_API_KEY, // added as Bearer token; omit for unauthenticated local dev
});
```

`baseUrl` is required. `apiKey` is optional — when present it is sent as `Authorization: Bearer <key>`.

## Reference domains

| Domain                          | Description                                                                 |
| ------------------------------- | --------------------------------------------------------------------------- |
| [Commitments](./commitments.md) | Create, update, status-advance, assign, list, and inspect Task commitments. |

More domains (ingestion, query, metrics, nodes/claims, scratchpad) will be documented here as the reference set grows.
