# Memory SDK reference

`MemoryClient` is a typed TypeScript client for the Assistant Memory HTTP API. Each method is a thin wrapper around a `POST` endpoint, validates the response with a Zod schema, and throws on non-2xx status.

## Installation and setup

```ts
import { MemoryClient } from "@marcelsamyn/memory/sdk";

const client = new MemoryClient({
  baseUrl: "https://memory.example.com",
  apiKey: process.env.MEMORY_API_KEY, // added as Bearer token; omit for unauthenticated local dev
});

// Keep the default client strict. Derive this client only for ordinary
// operations that must read the user's active workspace partitions.
const workspaceClient = client.withWorkspaceAccess();
```

`baseUrl` is required. `apiKey` is optional — when present it is sent as `Authorization: Bearer <key>`.

`MemoryClient` uses strict partition access by default. The workspace client
sends `x-memory-access-scope: workspace`; it does not use a magic partition
key. An explicit `partitionKey` still limits a workspace client to that
partition. New root content uses `memory:personal` after migration, child
sources inherit their parent's partition, and existing-object mutations
resolve the object's partition before applying strict mutation checks.

Use a strict client for preparation, partition-specific evidence, cleanup, and
maintenance. AI graph cleanup is disabled for partitioned data, and the admin
user-self-identity backfill remains strict-only pending a partition-scoped
implementation.

The SDK, HTTP API, and MCP tools are clients of the same Memory service. Source context and processing receipts are general ingestion capabilities; they do not require Radar or Petals. See [consumer migration notes](../sdk-consumer-migration.md) before upgrading an existing client.

## Reference domains

| Domain                          | Description                                                                 |
| ------------------------------- | --------------------------------------------------------------------------- |
| [Ingestion](./ingestion.md)     | Add contextual documents and files, then follow exact revision processing.  |
| [Commitments](./commitments.md) | Create, update, status-advance, assign, list, and inspect Task commitments. |

More domains (query, metrics, nodes/claims, scratchpad) will be documented here as the reference set grows.
