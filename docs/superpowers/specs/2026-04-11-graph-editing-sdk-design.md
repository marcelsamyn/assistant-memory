# Graph Editing SDK Endpoints

**Date:** 2026-04-11
**Status:** Approved

## Context

The Petals frontend has a Memory workspace with graph visualization and editing tools. Several UI operations are built but blocked on SDK support. The frontend currently hacks node creation via `ingestMemoryDocument` with formatted text, which is unreliable since extraction guesses the wrong type.

## Architecture

All endpoints follow the existing pattern:

1. **Schema** in `src/lib/schemas/` — Zod request/response schemas + exported types
2. **Business logic** in `src/lib/` — pure functions taking userId + params, using `useDatabase()`
3. **Route handler** in `src/routes/` — thin glue: parse body, call lib, validate response
4. **SDK method** in `src/sdk/memory-client.ts` — typed wrapper calling `_fetch`
5. **Re-export** from `src/sdk/index.ts`

No new abstractions. `_fetch` + Zod validation handles everything.

## P0 — Must Have

### 1. Create Node — `POST /node/create`

Create a memory node directly with a known type and label.

**Request:**

```ts
{
  userId: string
  nodeType: NodeTypeEnum    // any value from the enum
  label: string             // non-empty
  description?: string
}
```

**Response:**

```ts
{
  node: { id: TypeId<"node">, nodeType: NodeType, label: string, description: string | null }
}
```

**Behavior:**

- Creates `nodes` row + `nodeMetadata` row
- Generates embedding from `"${label}: ${description ?? ''}"`
- Returns created node so frontend can select it immediately

### 2. Create Edge — `POST /edge/create`

Create a typed edge between two existing nodes.

**Request:**

```ts
{
  userId: string
  sourceNodeId: TypeId<"node">
  targetNodeId: TypeId<"node">
  edgeType: EdgeTypeEnum
  description?: string
}
```

**Response:**

```ts
{
  edge: { id: TypeId<"edge">, sourceNodeId, targetNodeId, edgeType, description: string | null }
}
```

**Behavior:**

- Validates both nodes exist and belong to userId; 404 if not
- Creates `edges` row
- Generates edge embedding from `"${sourceLabel} ${edgeType} ${targetLabel}: ${description ?? ''}"`
- Returns created edge with its ID

### 3. Delete Edge — `POST /edge/delete`

Delete a single edge by ID.

**Request:**

```ts
{
  userId: string;
  edgeId: TypeId<"edge">;
}
```

**Response:**

```ts
{
  deleted: true;
}
```

**Behavior:**

- Validates edge belongs to userId
- Deletes edge (cascade handles edge_embeddings)
- Returns 404 if not found

### 4. Update Edge — `POST /edge/update`

Update an edge's type, description, or endpoints.

**Request:**

```ts
{
  userId: string
  edgeId: TypeId<"edge">
  edgeType?: EdgeTypeEnum
  description?: string
  sourceNodeId?: TypeId<"node">
  targetNodeId?: TypeId<"node">
}
```

**Response:**

```ts
{
  edge: { id: TypeId<"edge">, sourceNodeId, targetNodeId, edgeType, description: string | null }
}
```

**Behavior:**

- Validates edge ownership; 404 if not found
- If new node IDs provided, validates they exist and belong to userId; 404 if not
- Updates edge row
- Re-generates edge embedding if anything changed
- Returns updated edge

### 5. Merge Nodes — `POST /node/merge`

Merge multiple nodes into one.

**Request:**

```ts
{
  userId: string
  nodeIds: TypeId<"node">[]   // minimum 2
  targetLabel?: string
  targetDescription?: string
}
```

**Response:**

```ts
{
  node: { id: TypeId<"node">, nodeType: NodeType, label: string, description: string | null }
}
```

**Behavior:**

- Validates all nodes belong to userId
- First node in array is the survivor
- Accepts optional label/description override; otherwise keeps survivor's existing values
- Re-points all edges from consumed nodes to survivor
  - If re-pointing would violate the unique constraint `(sourceNodeId, targetNodeId, edgeType)`, drops the duplicate
- Consolidates `source_links` from consumed nodes to survivor (skip duplicates)
- Deletes consumed nodes (cascade handles metadata, embeddings, remaining source_links)
- Re-generates survivor's embedding
- Returns the merged survivor node

## P1 — Should Have

### 6. Get Atlas Node IDs — `POST /query/atlas-nodes`

Return node IDs associated with a given assistant's atlas.

**Request:**

```ts
{
  userId: string;
  assistantId: string;
}
```

**Response:**

```ts
{ nodeIds: string[] }
```

**Behavior:**

- Finds the assistant's Atlas node (via `ensureAssistantAtlasNode` or equivalent)
- Returns IDs of all nodes connected to it via edges

### 7. Update Node — accept `nodeType`

Add `nodeType: NodeTypeEnum.optional()` to `updateNodeRequestSchema`.

**Behavior:**

- When provided, updates `nodes.nodeType` in addition to metadata fields
- No other changes to the update flow

### 8. Batch Delete Nodes — `POST /node/batch-delete`

Atomic batch delete.

**Request:**

```ts
{
  userId: string;
  nodeIds: TypeId < "node" > [];
}
```

**Response:**

```ts
{ deleted: true, count: number }
```

**Behavior:**

- Wraps all deletes in a single transaction
- Returns count of actually deleted nodes

## P2 — Nice to Have

### 9. Query Graph — `nodeTypes` filter

Add optional `nodeTypes: z.array(NodeTypeEnum).optional()` to `queryGraphRequestSchema`.

**Behavior:**

- When provided, adds `WHERE nodes.nodeType IN (...)` to the graph query
- Server-side filtering replaces client-side filtering of the 200-node cap

### 10. Node Neighborhood — `POST /node/neighborhood`

Return the ego-graph around a focal node.

**Request:**

```ts
{
  userId: string
  nodeId: TypeId<"node">
  depth?: 1 | 2   // default 1
}
```

**Response:**

```ts
{ nodes: QueryGraphNode[], edges: QueryGraphEdge[] }
```

Same shape as `QueryGraphResponse` so the frontend needs no new type mappings.

**Behavior:**

- Depth 1: focal node + all one-hop neighbors + edges between them
- Depth 2: extends one more hop from the depth-1 set
- Includes the focal node itself in the response

## New Files

**Create:**

- `src/lib/schemas/edge.ts`
- `src/lib/schemas/node-merge.ts`
- `src/lib/schemas/node-batch-delete.ts`
- `src/lib/schemas/query-atlas-nodes.ts`
- `src/lib/schemas/node-neighborhood.ts`
- `src/lib/edge.ts`
- `src/routes/edge/create.post.ts`
- `src/routes/edge/delete.post.ts`
- `src/routes/edge/update.post.ts`
- `src/routes/node/create.post.ts`
- `src/routes/node/merge.post.ts`
- `src/routes/node/batch-delete.post.ts`
- `src/routes/node/neighborhood.post.ts`
- `src/routes/query/atlas-nodes.ts`

**Modify:**

- `src/lib/schemas/node.ts` — add create schema, add nodeType to update schema
- `src/lib/schemas/query-graph.ts` — add nodeTypes filter
- `src/lib/node.ts` — add createNode, mergeNodes, batchDeleteNodes, getNodeNeighborhood, update updateNode
- `src/lib/query/graph.ts` — apply nodeTypes filter
- `src/sdk/memory-client.ts` — add all new methods
- `src/sdk/index.ts` — re-export new schema modules

## Design Decisions

- **Any NodeTypeEnum value allowed for createNode** — no artificial subset restriction. The frontend controls what it shows in the UI.
- **Merge duplicate handling** — when re-pointing edges would violate the unique constraint, drop the duplicate (keep one). Simplest approach, preserves constraint.
- **Survivor selection** — first node in the array. Predictable, frontend controls ordering.
- **Response shapes** — reuse existing response shapes (updateNodeResponse for node mutations, QueryGraphResponse for neighborhood) to minimize frontend type mappings.
