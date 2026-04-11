# Graph Editing SDK Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add graph creation, editing, merging, and querying endpoints to the Memory SDK so the Petals frontend can directly manipulate the knowledge graph.

**Architecture:** Follows existing pattern — Zod schemas define contracts, lib functions contain business logic with `useDatabase()`, thin route handlers parse/validate, SDK wraps with `_fetch`. All node/edge mutations generate embeddings.

**Tech Stack:** Nitro (h3), Drizzle ORM, Zod, Jina embeddings, TypeID

---

### Task 1: Create Node — Schema + Lib + Route + SDK

**Files:**
- Modify: `src/lib/schemas/node.ts` — add createNode request/response schemas
- Modify: `src/lib/node.ts` — add `createNode` function
- Create: `src/routes/node/create.post.ts`
- Modify: `src/sdk/memory-client.ts` — add `createNode` method

- [ ] **Step 1: Add schemas to `src/lib/schemas/node.ts`**

Add after the existing `DeleteNodeResponse` type at the bottom of the file:

```ts
// --- Create Node ---

export const createNodeRequestSchema = z.object({
  userId: z.string(),
  nodeType: NodeTypeEnum,
  label: z.string().min(1),
  description: z.string().optional(),
});

export const createNodeResponseSchema = z.object({
  node: z.object({
    id: typeIdSchema("node"),
    nodeType: NodeTypeEnum,
    label: z.string(),
    description: z.string().nullable(),
  }),
});

export type CreateNodeRequest = z.infer<typeof createNodeRequestSchema>;
export type CreateNodeResponse = z.infer<typeof createNodeResponseSchema>;
```

- [ ] **Step 2: Add `createNode` function to `src/lib/node.ts`**

Add this import at the top (alongside existing imports):

```ts
import { ensureUser } from "~/lib/ingestion/ensure-user";
import type { NodeType } from "~/types/graph";
```

Add this function after `deleteNode`:

```ts
/** Create a new node with metadata and embedding. */
export async function createNode(
  userId: string,
  nodeType: NodeType,
  label: string,
  description?: string,
): Promise<{ id: TypeId<"node">; nodeType: NodeType; label: string; description: string | null }> {
  const db = await useDatabase();
  await ensureUser(db, userId);

  const [inserted] = await db
    .insert(nodes)
    .values({ userId, nodeType })
    .returning({ id: nodes.id });

  if (!inserted) throw new Error("Failed to create node");

  await db.insert(nodeMetadata).values({
    nodeId: inserted.id,
    label,
    description: description ?? null,
  });

  // Generate embedding
  const embText = `${label}: ${description ?? ""}`;
  const embResponse = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.passage",
    input: [embText],
    truncate: true,
  });
  const embedding = embResponse.data[0]?.embedding;
  if (embedding) {
    await db.insert(nodeEmbeddings).values({
      nodeId: inserted.id,
      embedding,
      modelName: "jina-embeddings-v3",
    });
  }

  return {
    id: inserted.id,
    nodeType,
    label,
    description: description ?? null,
  };
}
```

- [ ] **Step 3: Create route `src/routes/node/create.post.ts`**

```ts
import { defineEventHandler } from "h3";
import { createNode } from "~/lib/node";
import {
  createNodeRequestSchema,
  createNodeResponseSchema,
} from "~/lib/schemas/node";

export default defineEventHandler(async (event) => {
  const { userId, nodeType, label, description } =
    createNodeRequestSchema.parse(await readBody(event));
  const node = await createNode(userId, nodeType, label, description);
  return createNodeResponseSchema.parse({ node });
});
```

- [ ] **Step 4: Add SDK method to `src/sdk/memory-client.ts`**

Add import for `CreateNodeRequest`, `CreateNodeResponse`, `createNodeResponseSchema` to the existing node import block.

Add method to `MemoryClient`:

```ts
async createNode(payload: CreateNodeRequest): Promise<CreateNodeResponse> {
  return this._fetch(
    "POST",
    "/node/create",
    createNodeResponseSchema,
    payload,
  );
}
```

- [ ] **Step 5: Verify build**

Run: `pnpm run build`

---

### Task 2: Edge Schemas + Lib

**Files:**
- Create: `src/lib/schemas/edge.ts` — all edge CRUD schemas
- Create: `src/lib/edge.ts` — createEdge, deleteEdge, updateEdge business logic

- [ ] **Step 1: Create `src/lib/schemas/edge.ts`**

```ts
import { EdgeTypeEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

// --- Create Edge ---

export const createEdgeRequestSchema = z.object({
  userId: z.string(),
  sourceNodeId: typeIdSchema("node"),
  targetNodeId: typeIdSchema("node"),
  edgeType: EdgeTypeEnum,
  description: z.string().optional(),
});

export const edgeResponseSchema = z.object({
  edge: z.object({
    id: typeIdSchema("edge"),
    sourceNodeId: typeIdSchema("node"),
    targetNodeId: typeIdSchema("node"),
    edgeType: EdgeTypeEnum,
    description: z.string().nullable(),
  }),
});

export const createEdgeResponseSchema = edgeResponseSchema;

export type CreateEdgeRequest = z.infer<typeof createEdgeRequestSchema>;
export type CreateEdgeResponse = z.infer<typeof createEdgeResponseSchema>;

// --- Delete Edge ---

export const deleteEdgeRequestSchema = z.object({
  userId: z.string(),
  edgeId: typeIdSchema("edge"),
});

export const deleteEdgeResponseSchema = z.object({
  deleted: z.literal(true),
});

export type DeleteEdgeRequest = z.infer<typeof deleteEdgeRequestSchema>;
export type DeleteEdgeResponse = z.infer<typeof deleteEdgeResponseSchema>;

// --- Update Edge ---

export const updateEdgeRequestSchema = z.object({
  userId: z.string(),
  edgeId: typeIdSchema("edge"),
  edgeType: EdgeTypeEnum.optional(),
  description: z.string().optional(),
  sourceNodeId: typeIdSchema("node").optional(),
  targetNodeId: typeIdSchema("node").optional(),
});

export const updateEdgeResponseSchema = edgeResponseSchema;

export type UpdateEdgeRequest = z.infer<typeof updateEdgeRequestSchema>;
export type UpdateEdgeResponse = z.infer<typeof updateEdgeResponseSchema>;
```

- [ ] **Step 2: Create `src/lib/edge.ts`**

```ts
/** Edge operations: create, delete, update. */

import { and, eq, inArray } from "drizzle-orm";
import { nodes, nodeMetadata, edges, edgeEmbeddings } from "~/db/schema";
import { generateEmbeddings } from "~/lib/embeddings";
import type { EdgeType } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

/** Generate embedding text for an edge from its endpoint labels and description. */
async function edgeEmbeddingText(
  db: Awaited<ReturnType<typeof useDatabase>>,
  sourceNodeId: TypeId<"node">,
  targetNodeId: TypeId<"node">,
  edgeType: EdgeType,
  description: string | null,
): Promise<string> {
  const [srcMeta] = await db
    .select({ label: nodeMetadata.label })
    .from(nodeMetadata)
    .where(eq(nodeMetadata.nodeId, sourceNodeId))
    .limit(1);
  const [tgtMeta] = await db
    .select({ label: nodeMetadata.label })
    .from(nodeMetadata)
    .where(eq(nodeMetadata.nodeId, targetNodeId))
    .limit(1);
  return `${srcMeta?.label ?? ""} ${edgeType} ${tgtMeta?.label ?? ""}: ${description ?? ""}`;
}

/** Validate that node IDs exist and belong to userId. Returns true if all valid. */
async function validateNodeOwnership(
  db: Awaited<ReturnType<typeof useDatabase>>,
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<boolean> {
  const found = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, nodeIds)));
  return found.length === nodeIds.length;
}

/** Create a typed edge between two existing nodes. */
export async function createEdge(
  userId: string,
  sourceNodeId: TypeId<"node">,
  targetNodeId: TypeId<"node">,
  edgeType: EdgeType,
  description?: string,
): Promise<{
  id: TypeId<"edge">;
  sourceNodeId: TypeId<"node">;
  targetNodeId: TypeId<"node">;
  edgeType: EdgeType;
  description: string | null;
}> {
  const db = await useDatabase();

  if (!(await validateNodeOwnership(db, userId, [sourceNodeId, targetNodeId]))) {
    throw new Error("One or both nodes not found");
  }

  const [inserted] = await db
    .insert(edges)
    .values({
      userId,
      sourceNodeId,
      targetNodeId,
      edgeType,
      description: description ?? null,
    })
    .returning({
      id: edges.id,
      sourceNodeId: edges.sourceNodeId,
      targetNodeId: edges.targetNodeId,
      edgeType: edges.edgeType,
      description: edges.description,
    });

  if (!inserted) throw new Error("Failed to create edge");

  // Generate embedding
  const embText = await edgeEmbeddingText(
    db,
    sourceNodeId,
    targetNodeId,
    edgeType,
    description ?? null,
  );
  const embResponse = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.passage",
    input: [embText],
    truncate: true,
  });
  const embedding = embResponse.data[0]?.embedding;
  if (embedding) {
    await db.insert(edgeEmbeddings).values({
      edgeId: inserted.id,
      embedding,
      modelName: "jina-embeddings-v3",
    });
  }

  return inserted;
}

/** Delete an edge by ID. */
export async function deleteEdge(
  userId: string,
  edgeId: TypeId<"edge">,
): Promise<boolean> {
  const db = await useDatabase();
  const result = await db
    .delete(edges)
    .where(and(eq(edges.id, edgeId), eq(edges.userId, userId)))
    .returning({ id: edges.id });
  return result.length > 0;
}

/** Update an edge's type, description, or endpoints. Re-generates embedding. */
export async function updateEdge(
  userId: string,
  edgeId: TypeId<"edge">,
  updates: {
    edgeType?: EdgeType;
    description?: string;
    sourceNodeId?: TypeId<"node">;
    targetNodeId?: TypeId<"node">;
  },
): Promise<{
  id: TypeId<"edge">;
  sourceNodeId: TypeId<"node">;
  targetNodeId: TypeId<"node">;
  edgeType: EdgeType;
  description: string | null;
} | null> {
  const db = await useDatabase();

  // Fetch current edge and verify ownership
  const [current] = await db
    .select({
      id: edges.id,
      sourceNodeId: edges.sourceNodeId,
      targetNodeId: edges.targetNodeId,
      edgeType: edges.edgeType,
      description: edges.description,
    })
    .from(edges)
    .where(and(eq(edges.id, edgeId), eq(edges.userId, userId)))
    .limit(1);

  if (!current) return null;

  // Validate new node IDs if provided
  const newNodeIds: TypeId<"node">[] = [];
  if (updates.sourceNodeId) newNodeIds.push(updates.sourceNodeId);
  if (updates.targetNodeId) newNodeIds.push(updates.targetNodeId);
  if (newNodeIds.length > 0) {
    if (!(await validateNodeOwnership(db, userId, newNodeIds))) {
      throw new Error("One or both target nodes not found");
    }
  }

  const newSourceNodeId = updates.sourceNodeId ?? current.sourceNodeId;
  const newTargetNodeId = updates.targetNodeId ?? current.targetNodeId;
  const newEdgeType = updates.edgeType ?? current.edgeType;
  const newDescription = updates.description !== undefined ? updates.description : current.description;

  // Build update set (only changed fields)
  const updateSet: Record<string, unknown> = {};
  if (updates.edgeType) updateSet.edgeType = updates.edgeType;
  if (updates.description !== undefined) updateSet.description = updates.description;
  if (updates.sourceNodeId) updateSet.sourceNodeId = updates.sourceNodeId;
  if (updates.targetNodeId) updateSet.targetNodeId = updates.targetNodeId;

  if (Object.keys(updateSet).length > 0) {
    await db.update(edges).set(updateSet).where(eq(edges.id, edgeId));
  }

  // Re-generate embedding
  const embText = await edgeEmbeddingText(
    db,
    newSourceNodeId,
    newTargetNodeId,
    newEdgeType,
    newDescription,
  );
  const embResponse = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.passage",
    input: [embText],
    truncate: true,
  });
  const embedding = embResponse.data[0]?.embedding;
  if (embedding) {
    await db.delete(edgeEmbeddings).where(eq(edgeEmbeddings.edgeId, edgeId));
    await db.insert(edgeEmbeddings).values({
      edgeId,
      embedding,
      modelName: "jina-embeddings-v3",
    });
  }

  return {
    id: edgeId,
    sourceNodeId: newSourceNodeId,
    targetNodeId: newTargetNodeId,
    edgeType: newEdgeType,
    description: newDescription,
  };
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm run build`

---

### Task 3: Edge Routes

**Files:**
- Create: `src/routes/edge/create.post.ts`
- Create: `src/routes/edge/delete.post.ts`
- Create: `src/routes/edge/update.post.ts`

- [ ] **Step 1: Create `src/routes/edge/create.post.ts`**

```ts
import { defineEventHandler, createError } from "h3";
import { createEdge } from "~/lib/edge";
import {
  createEdgeRequestSchema,
  createEdgeResponseSchema,
} from "~/lib/schemas/edge";

export default defineEventHandler(async (event) => {
  const { userId, sourceNodeId, targetNodeId, edgeType, description } =
    createEdgeRequestSchema.parse(await readBody(event));
  try {
    const edge = await createEdge(
      userId,
      sourceNodeId,
      targetNodeId,
      edgeType,
      description,
    );
    return createEdgeResponseSchema.parse({ edge });
  } catch (e) {
    if (e instanceof Error && e.message.includes("not found")) {
      throw createError({ statusCode: 404, statusMessage: e.message });
    }
    throw e;
  }
});
```

- [ ] **Step 2: Create `src/routes/edge/delete.post.ts`**

```ts
import { defineEventHandler, createError } from "h3";
import { deleteEdge } from "~/lib/edge";
import {
  deleteEdgeRequestSchema,
  deleteEdgeResponseSchema,
} from "~/lib/schemas/edge";

export default defineEventHandler(async (event) => {
  const { userId, edgeId } = deleteEdgeRequestSchema.parse(
    await readBody(event),
  );
  const deleted = await deleteEdge(userId, edgeId);
  if (!deleted) {
    throw createError({ statusCode: 404, statusMessage: "Edge not found" });
  }
  return deleteEdgeResponseSchema.parse({ deleted: true });
});
```

- [ ] **Step 3: Create `src/routes/edge/update.post.ts`**

```ts
import { defineEventHandler, createError } from "h3";
import { updateEdge } from "~/lib/edge";
import {
  updateEdgeRequestSchema,
  updateEdgeResponseSchema,
} from "~/lib/schemas/edge";

export default defineEventHandler(async (event) => {
  const { userId, edgeId, edgeType, description, sourceNodeId, targetNodeId } =
    updateEdgeRequestSchema.parse(await readBody(event));
  try {
    const result = await updateEdge(userId, edgeId, {
      edgeType,
      description,
      sourceNodeId,
      targetNodeId,
    });
    if (!result) {
      throw createError({ statusCode: 404, statusMessage: "Edge not found" });
    }
    return updateEdgeResponseSchema.parse({ edge: result });
  } catch (e) {
    if (e instanceof Error && e.message.includes("not found")) {
      throw createError({ statusCode: 404, statusMessage: e.message });
    }
    throw e;
  }
});
```

- [ ] **Step 4: Verify build**

Run: `pnpm run build`

---

### Task 4: Edge SDK Methods + Re-exports

**Files:**
- Modify: `src/sdk/memory-client.ts` — add edge methods
- Modify: `src/sdk/index.ts` — re-export edge schemas

- [ ] **Step 1: Add edge imports and methods to `src/sdk/memory-client.ts`**

Add import block:

```ts
import {
  CreateEdgeRequest,
  CreateEdgeResponse,
  createEdgeResponseSchema,
  DeleteEdgeRequest,
  DeleteEdgeResponse,
  deleteEdgeResponseSchema,
  UpdateEdgeRequest,
  UpdateEdgeResponse,
  updateEdgeResponseSchema,
} from "../lib/schemas/edge.js";
```

Add methods to `MemoryClient`:

```ts
async createEdge(payload: CreateEdgeRequest): Promise<CreateEdgeResponse> {
  return this._fetch(
    "POST",
    "/edge/create",
    createEdgeResponseSchema,
    payload,
  );
}

async deleteEdge(payload: DeleteEdgeRequest): Promise<DeleteEdgeResponse> {
  return this._fetch(
    "POST",
    "/edge/delete",
    deleteEdgeResponseSchema,
    payload,
  );
}

async updateEdge(payload: UpdateEdgeRequest): Promise<UpdateEdgeResponse> {
  return this._fetch(
    "POST",
    "/edge/update",
    updateEdgeResponseSchema,
    payload,
  );
}
```

- [ ] **Step 2: Add re-export to `src/sdk/index.ts`**

Add line:

```ts
export * from "../lib/schemas/edge.js";
```

- [ ] **Step 3: Verify build**

Run: `pnpm run build`

---

### Task 5: Merge Nodes — Schema + Lib + Route + SDK

**Files:**
- Create: `src/lib/schemas/node-merge.ts`
- Modify: `src/lib/node.ts` — add `mergeNodes` function
- Create: `src/routes/node/merge.post.ts`
- Modify: `src/sdk/memory-client.ts` — add `mergeNodes` method
- Modify: `src/sdk/index.ts` — re-export

- [ ] **Step 1: Create `src/lib/schemas/node-merge.ts`**

```ts
import { NodeTypeEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

export const mergeNodesRequestSchema = z.object({
  userId: z.string(),
  nodeIds: z.array(typeIdSchema("node")).min(2),
  targetLabel: z.string().optional(),
  targetDescription: z.string().optional(),
});

export const mergeNodesResponseSchema = z.object({
  node: z.object({
    id: typeIdSchema("node"),
    nodeType: NodeTypeEnum,
    label: z.string(),
    description: z.string().nullable(),
  }),
});

export type MergeNodesRequest = z.infer<typeof mergeNodesRequestSchema>;
export type MergeNodesResponse = z.infer<typeof mergeNodesResponseSchema>;
```

- [ ] **Step 2: Add `mergeNodes` function to `src/lib/node.ts`**

Add `sql` to the drizzle-orm import:

```ts
import { and, eq, or, inArray, aliasedTable, sql } from "drizzle-orm";
```

Add `sourceLinks` to the schema import (already imported).

Add function:

```ts
/** Merge multiple nodes into one. First node is the survivor. */
export async function mergeNodes(
  userId: string,
  nodeIds: TypeId<"node">[],
  overrides?: { targetLabel?: string; targetDescription?: string },
): Promise<{ id: TypeId<"node">; nodeType: string; label: string; description: string | null } | null> {
  const db = await useDatabase();

  // Validate all nodes belong to userId
  const foundNodes = await db
    .select({
      id: nodes.id,
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, nodeIds)));

  if (foundNodes.length !== nodeIds.length) return null;

  const survivorId = nodeIds[0]!;
  const consumedIds = nodeIds.slice(1);
  const survivorRow = foundNodes.find((n) => n.id === survivorId)!;

  const finalLabel = overrides?.targetLabel ?? survivorRow.label ?? "";
  const finalDescription = overrides?.targetDescription !== undefined
    ? overrides.targetDescription
    : survivorRow.description;

  // Re-point edges from consumed nodes to survivor, dropping duplicates
  for (const consumedId of consumedIds) {
    // Update edges where consumed is source
    await db.execute(sql`
      UPDATE edges
      SET source_node_id = ${survivorId}
      WHERE source_node_id = ${consumedId}
        AND user_id = ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM edges e2
          WHERE e2.source_node_id = ${survivorId}
            AND e2.target_node_id = edges.target_node_id
            AND e2.edge_type = edges.edge_type
        )
    `);

    // Update edges where consumed is target
    await db.execute(sql`
      UPDATE edges
      SET target_node_id = ${survivorId}
      WHERE target_node_id = ${consumedId}
        AND user_id = ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM edges e2
          WHERE e2.source_node_id = edges.source_node_id
            AND e2.target_node_id = ${survivorId}
            AND e2.edge_type = edges.edge_type
        )
    `);

    // Delete remaining duplicate edges that couldn't be re-pointed
    await db
      .delete(edges)
      .where(
        and(
          eq(edges.userId, userId),
          or(
            eq(edges.sourceNodeId, consumedId),
            eq(edges.targetNodeId, consumedId),
          ),
        ),
      );

    // Consolidate source_links (skip duplicates)
    await db.execute(sql`
      UPDATE source_links
      SET node_id = ${survivorId}
      WHERE node_id = ${consumedId}
        AND NOT EXISTS (
          SELECT 1 FROM source_links sl2
          WHERE sl2.node_id = ${survivorId}
            AND sl2.source_id = source_links.source_id
        )
    `);

    // Delete remaining duplicate source_links
    await db
      .delete(sourceLinks)
      .where(eq(sourceLinks.nodeId, consumedId));
  }

  // Delete consumed nodes (cascade handles metadata, embeddings)
  await db
    .delete(nodes)
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, consumedIds)));

  // Update survivor metadata
  await db
    .update(nodeMetadata)
    .set({ label: finalLabel, description: finalDescription })
    .where(
      eq(
        nodeMetadata.nodeId,
        survivorId,
      ),
    );

  // Re-generate survivor embedding
  const embText = `${finalLabel}: ${finalDescription ?? ""}`;
  const embResponse = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.passage",
    input: [embText],
    truncate: true,
  });
  const embedding = embResponse.data[0]?.embedding;
  if (embedding) {
    await db.delete(nodeEmbeddings).where(eq(nodeEmbeddings.nodeId, survivorId));
    await db.insert(nodeEmbeddings).values({
      nodeId: survivorId,
      embedding,
      modelName: "jina-embeddings-v3",
    });
  }

  // Also delete self-referencing edges that may have been created
  await db.execute(sql`
    DELETE FROM edges
    WHERE source_node_id = ${survivorId}
      AND target_node_id = ${survivorId}
  `);

  return {
    id: survivorId,
    nodeType: survivorRow.nodeType,
    label: finalLabel,
    description: finalDescription ?? null,
  };
}
```

- [ ] **Step 3: Create route `src/routes/node/merge.post.ts`**

```ts
import { defineEventHandler, createError } from "h3";
import { mergeNodes } from "~/lib/node";
import {
  mergeNodesRequestSchema,
  mergeNodesResponseSchema,
} from "~/lib/schemas/node-merge";

export default defineEventHandler(async (event) => {
  const { userId, nodeIds, targetLabel, targetDescription } =
    mergeNodesRequestSchema.parse(await readBody(event));
  const result = await mergeNodes(userId, nodeIds, {
    targetLabel,
    targetDescription,
  });
  if (!result) {
    throw createError({
      statusCode: 404,
      statusMessage: "One or more nodes not found",
    });
  }
  return mergeNodesResponseSchema.parse({ node: result });
});
```

- [ ] **Step 4: Add SDK method and re-export**

Add to `src/sdk/memory-client.ts` imports:

```ts
import {
  MergeNodesRequest,
  MergeNodesResponse,
  mergeNodesResponseSchema,
} from "../lib/schemas/node-merge.js";
```

Add method:

```ts
async mergeNodes(payload: MergeNodesRequest): Promise<MergeNodesResponse> {
  return this._fetch(
    "POST",
    "/node/merge",
    mergeNodesResponseSchema,
    payload,
  );
}
```

Add to `src/sdk/index.ts`:

```ts
export * from "../lib/schemas/node-merge.js";
```

- [ ] **Step 5: Verify build**

Run: `pnpm run build`

---

### Task 6: P1 — Update Node with nodeType + Get Atlas Node IDs

**Files:**
- Modify: `src/lib/schemas/node.ts` — add `nodeType` to update schema
- Modify: `src/lib/node.ts` — update `updateNode` to handle nodeType
- Modify: `src/routes/node/update.post.ts` — pass nodeType
- Create: `src/lib/schemas/query-atlas-nodes.ts`
- Create: `src/routes/query/atlas-nodes.ts`
- Modify: `src/sdk/memory-client.ts` — add `getAtlasNodeIds` method
- Modify: `src/sdk/index.ts` — re-export

- [ ] **Step 1: Add `nodeType` to update schema in `src/lib/schemas/node.ts`**

Change `updateNodeRequestSchema` to:

```ts
export const updateNodeRequestSchema = z.object({
  userId: z.string(),
  nodeId: typeIdSchema("node"),
  label: z.string().optional(),
  description: z.string().optional(),
  nodeType: NodeTypeEnum.optional(),
});
```

- [ ] **Step 2: Update `updateNode` in `src/lib/node.ts`**

Change the function signature to accept `nodeType`:

```ts
export async function updateNode(
  userId: string,
  nodeId: TypeId<"node">,
  updates: { label?: string; description?: string; nodeType?: NodeType },
): Promise<{ id: TypeId<"node">; nodeType: string; label: string | null; description: string | null } | null> {
```

Add after the ownership check, before the metadata update:

```ts
  // Update node type if provided
  if (updates.nodeType) {
    await db
      .update(nodes)
      .set({ nodeType: updates.nodeType })
      .where(eq(nodes.id, nodeId));
  }

  const effectiveNodeType = updates.nodeType ?? row.nodeType;
```

And change the return to use `effectiveNodeType`:

```ts
  return {
    id: row.id,
    nodeType: effectiveNodeType,
    label: newLabel ?? null,
    description: newDescription ?? null,
  };
```

- [ ] **Step 3: Update route `src/routes/node/update.post.ts`**

Change the destructuring to include `nodeType` and pass it:

```ts
export default defineEventHandler(async (event) => {
  const { userId, nodeId, label, description, nodeType } =
    updateNodeRequestSchema.parse(await readBody(event));
  const result = await updateNode(userId, nodeId, { label, description, nodeType });
  if (!result) {
    throw createError({ statusCode: 404, statusMessage: "Node not found" });
  }
  return updateNodeResponseSchema.parse({ node: result });
});
```

- [ ] **Step 4: Create `src/lib/schemas/query-atlas-nodes.ts`**

```ts
import { z } from "zod";

export const queryAtlasNodesRequestSchema = z.object({
  userId: z.string(),
  assistantId: z.string(),
});

export const queryAtlasNodesResponseSchema = z.object({
  nodeIds: z.array(z.string()),
});

export type QueryAtlasNodesRequest = z.infer<typeof queryAtlasNodesRequestSchema>;
export type QueryAtlasNodesResponse = z.infer<typeof queryAtlasNodesResponseSchema>;
```

- [ ] **Step 5: Create route `src/routes/query/atlas-nodes.ts`**

```ts
import { defineEventHandler } from "h3";
import { ensureAssistantAtlasNode } from "~/lib/atlas";
import {
  queryAtlasNodesRequestSchema,
  queryAtlasNodesResponseSchema,
} from "~/lib/schemas/query-atlas-nodes";
import { and, eq, or } from "drizzle-orm";
import { edges } from "~/db/schema";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, assistantId } = queryAtlasNodesRequestSchema.parse(
    await readBody(event),
  );
  const db = await useDatabase();
  const atlasNodeId = await ensureAssistantAtlasNode(db, userId, assistantId);

  // Find all nodes connected to the atlas node
  const edgeRows = await db
    .select({
      sourceNodeId: edges.sourceNodeId,
      targetNodeId: edges.targetNodeId,
    })
    .from(edges)
    .where(
      and(
        eq(edges.userId, userId),
        or(
          eq(edges.sourceNodeId, atlasNodeId),
          eq(edges.targetNodeId, atlasNodeId),
        ),
      ),
    );

  const nodeIds = new Set<string>();
  for (const row of edgeRows) {
    if (row.sourceNodeId !== atlasNodeId) nodeIds.add(row.sourceNodeId);
    if (row.targetNodeId !== atlasNodeId) nodeIds.add(row.targetNodeId);
  }

  return queryAtlasNodesResponseSchema.parse({
    nodeIds: Array.from(nodeIds),
  });
});
```

- [ ] **Step 6: Add SDK method and re-exports**

Add to `src/sdk/memory-client.ts` imports:

```ts
import {
  QueryAtlasNodesRequest,
  QueryAtlasNodesResponse,
  queryAtlasNodesResponseSchema,
} from "../lib/schemas/query-atlas-nodes.js";
```

Add method:

```ts
async getAtlasNodeIds(
  payload: QueryAtlasNodesRequest,
): Promise<QueryAtlasNodesResponse> {
  return this._fetch(
    "POST",
    "/query/atlas-nodes",
    queryAtlasNodesResponseSchema,
    payload,
  );
}
```

Add to `src/sdk/index.ts`:

```ts
export * from "../lib/schemas/query-atlas-nodes.js";
```

- [ ] **Step 7: Verify build**

Run: `pnpm run build`

---

### Task 7: P1 — Batch Delete Nodes

**Files:**
- Create: `src/lib/schemas/node-batch-delete.ts`
- Modify: `src/lib/node.ts` — add `batchDeleteNodes`
- Create: `src/routes/node/batch-delete.post.ts`
- Modify: `src/sdk/memory-client.ts`
- Modify: `src/sdk/index.ts`

- [ ] **Step 1: Create `src/lib/schemas/node-batch-delete.ts`**

```ts
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

export const batchDeleteNodesRequestSchema = z.object({
  userId: z.string(),
  nodeIds: z.array(typeIdSchema("node")).min(1),
});

export const batchDeleteNodesResponseSchema = z.object({
  deleted: z.literal(true),
  count: z.number().int().nonnegative(),
});

export type BatchDeleteNodesRequest = z.infer<typeof batchDeleteNodesRequestSchema>;
export type BatchDeleteNodesResponse = z.infer<typeof batchDeleteNodesResponseSchema>;
```

- [ ] **Step 2: Add `batchDeleteNodes` to `src/lib/node.ts`**

```ts
/** Batch delete nodes in a single query. */
export async function batchDeleteNodes(
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<number> {
  const db = await useDatabase();
  const result = await db
    .delete(nodes)
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, nodeIds)))
    .returning({ id: nodes.id });
  return result.length;
}
```

- [ ] **Step 3: Create route `src/routes/node/batch-delete.post.ts`**

```ts
import { defineEventHandler } from "h3";
import { batchDeleteNodes } from "~/lib/node";
import {
  batchDeleteNodesRequestSchema,
  batchDeleteNodesResponseSchema,
} from "~/lib/schemas/node-batch-delete";

export default defineEventHandler(async (event) => {
  const { userId, nodeIds } = batchDeleteNodesRequestSchema.parse(
    await readBody(event),
  );
  const count = await batchDeleteNodes(userId, nodeIds);
  return batchDeleteNodesResponseSchema.parse({ deleted: true, count });
});
```

- [ ] **Step 4: Add SDK method and re-export**

Add to `src/sdk/memory-client.ts` imports:

```ts
import {
  BatchDeleteNodesRequest,
  BatchDeleteNodesResponse,
  batchDeleteNodesResponseSchema,
} from "../lib/schemas/node-batch-delete.js";
```

Add method:

```ts
async batchDeleteNodes(
  payload: BatchDeleteNodesRequest,
): Promise<BatchDeleteNodesResponse> {
  return this._fetch(
    "POST",
    "/node/batch-delete",
    batchDeleteNodesResponseSchema,
    payload,
  );
}
```

Add to `src/sdk/index.ts`:

```ts
export * from "../lib/schemas/node-batch-delete.js";
```

- [ ] **Step 5: Verify build**

Run: `pnpm run build`

---

### Task 8: P2 — Query Graph nodeTypes Filter

**Files:**
- Modify: `src/lib/schemas/query-graph.ts` — add `nodeTypes` field
- Modify: `src/lib/query/graph.ts` — apply filter

- [ ] **Step 1: Add `nodeTypes` to schema in `src/lib/schemas/query-graph.ts`**

Change `queryGraphRequestSchema` to:

```ts
export const queryGraphRequestSchema = z.object({
  userId: z.string(),
  query: z.string().optional(),
  maxNodes: z.number().int().positive().default(100),
  nodeTypes: z.array(NodeTypeEnum).optional(),
});
```

- [ ] **Step 2: Apply filter in `src/lib/query/graph.ts`**

Add `inArray` to the drizzle-orm import (already imported).

In `queryKnowledgeGraph`, in the no-query branch, change the query to:

```ts
  if (!query) {
    let whereCondition = and(
      eq(nodes.userId, userId),
      isNotNull(nodeMetadata.label),
    );
    if (params.nodeTypes && params.nodeTypes.length > 0) {
      whereCondition = and(
        whereCondition,
        inArray(nodes.nodeType, params.nodeTypes),
      );
    }

    const nodeRows = await db
      .select({
        id: nodes.id,
        nodeType: nodes.nodeType,
        label: nodeMetadata.label,
        description: nodeMetadata.description,
      })
      .from(nodes)
      .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(whereCondition);
```

In the query-based branch, pass `nodeTypes` as `excludeNodeTypes` inverted — actually simpler: filter the seeds. Add after the seeds are fetched:

After `const seeds = ...`, add a filter only if `nodeTypes` is specified:

```ts
  // Apply nodeTypes filter to seed results if specified
  const filteredSeeds = params.nodeTypes?.length
    ? seeds.filter((s) => params.nodeTypes!.includes(s.type))
    : seeds;
```

Then use `filteredSeeds` instead of `seeds` for the rest of the function.

- [ ] **Step 3: Verify build**

Run: `pnpm run build`

---

### Task 9: P2 — Node Neighborhood

**Files:**
- Create: `src/lib/schemas/node-neighborhood.ts`
- Modify: `src/lib/node.ts` — add `getNodeNeighborhood`
- Create: `src/routes/node/neighborhood.post.ts`
- Modify: `src/sdk/memory-client.ts`
- Modify: `src/sdk/index.ts`

- [ ] **Step 1: Create `src/lib/schemas/node-neighborhood.ts`**

```ts
import { typeIdSchema } from "../../types/typeid.js";
import { queryGraphNodeSchema, queryGraphEdgeSchema } from "./query-graph.js";
import { z } from "zod";

export const nodeNeighborhoodRequestSchema = z.object({
  userId: z.string(),
  nodeId: typeIdSchema("node"),
  depth: z.union([z.literal(1), z.literal(2)]).default(1),
});

export const nodeNeighborhoodResponseSchema = z.object({
  nodes: z.array(queryGraphNodeSchema),
  edges: z.array(queryGraphEdgeSchema),
});

export type NodeNeighborhoodRequest = z.infer<typeof nodeNeighborhoodRequestSchema>;
export type NodeNeighborhoodResponse = z.infer<typeof nodeNeighborhoodResponseSchema>;
```

- [ ] **Step 2: Add `getNodeNeighborhood` to `src/lib/node.ts`**

Add import:

```ts
import { findOneHopNodes, fetchSourceIdsForNodes, fetchEdgesBetweenNodeIds } from "~/lib/graph";
```

Note: `fetchEdgesBetweenNodeIds` is exported from `~/lib/graph` but also duplicated in `~/lib/query/graph`. Use the one from `~/lib/graph`.

Add function:

```ts
/** Get ego-graph neighborhood around a focal node. */
export async function getNodeNeighborhood(
  userId: string,
  nodeId: TypeId<"node">,
  depth: 1 | 2 = 1,
): Promise<{
  nodes: { id: TypeId<"node">; nodeType: string; label: string; description: string | null; sourceIds: string[] }[];
  edges: { source: TypeId<"node">; target: TypeId<"node">; edgeType: string; description: string | null }[];
} | null> {
  const db = await useDatabase();

  // Fetch focal node
  const [focal] = await db
    .select({
      id: nodes.id,
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .limit(1);

  if (!focal) return null;

  const allNodeIds = new Set<TypeId<"node">>([nodeId]);
  const nodeMap = new Map<TypeId<"node">, { id: TypeId<"node">; nodeType: string; label: string; description: string | null }>();
  nodeMap.set(nodeId, {
    id: focal.id,
    nodeType: focal.nodeType,
    label: focal.label ?? "",
    description: focal.description,
  });

  // Depth 1
  let currentIds = [nodeId];
  const hop1 = await findOneHopNodes(db, userId, currentIds);
  for (const n of hop1) {
    if (!allNodeIds.has(n.id)) {
      allNodeIds.add(n.id);
      nodeMap.set(n.id, {
        id: n.id,
        nodeType: n.type,
        label: n.label ?? "",
        description: n.description,
      });
    }
  }

  // Depth 2
  if (depth === 2) {
    const hop1Ids = hop1.map((n) => n.id).filter((id) => id !== nodeId);
    if (hop1Ids.length > 0) {
      const hop2 = await findOneHopNodes(db, userId, hop1Ids);
      for (const n of hop2) {
        if (!allNodeIds.has(n.id)) {
          allNodeIds.add(n.id);
          nodeMap.set(n.id, {
            id: n.id,
            nodeType: n.type,
            label: n.label ?? "",
            description: n.description,
          });
        }
      }
    }
  }

  const nodeIds = Array.from(allNodeIds);
  const [edgeRows, sourceIdMap] = await Promise.all([
    fetchEdgesBetweenNodeIds(db, userId, nodeIds),
    fetchSourceIdsForNodes(db, nodeIds),
  ]);

  return {
    nodes: Array.from(nodeMap.values()).map((n) => ({
      ...n,
      sourceIds: sourceIdMap.get(n.id) ?? [],
    })),
    edges: edgeRows,
  };
}
```

- [ ] **Step 3: Create route `src/routes/node/neighborhood.post.ts`**

```ts
import { defineEventHandler, createError } from "h3";
import { getNodeNeighborhood } from "~/lib/node";
import {
  nodeNeighborhoodRequestSchema,
  nodeNeighborhoodResponseSchema,
} from "~/lib/schemas/node-neighborhood";

export default defineEventHandler(async (event) => {
  const { userId, nodeId, depth } = nodeNeighborhoodRequestSchema.parse(
    await readBody(event),
  );
  const result = await getNodeNeighborhood(userId, nodeId, depth);
  if (!result) {
    throw createError({ statusCode: 404, statusMessage: "Node not found" });
  }
  return nodeNeighborhoodResponseSchema.parse(result);
});
```

- [ ] **Step 4: Add SDK method and re-export**

Add to `src/sdk/memory-client.ts` imports:

```ts
import {
  NodeNeighborhoodRequest,
  NodeNeighborhoodResponse,
  nodeNeighborhoodResponseSchema,
} from "../lib/schemas/node-neighborhood.js";
```

Add method:

```ts
async getNodeNeighborhood(
  payload: NodeNeighborhoodRequest,
): Promise<NodeNeighborhoodResponse> {
  return this._fetch(
    "POST",
    "/node/neighborhood",
    nodeNeighborhoodResponseSchema,
    payload,
  );
}
```

Add to `src/sdk/index.ts`:

```ts
export * from "../lib/schemas/node-neighborhood.js";
```

- [ ] **Step 5: Verify build**

Run: `pnpm run build`

---

### Task 10: Final Build + Type Check

- [ ] **Step 1: Full build verification**

Run: `pnpm run build`

- [ ] **Step 2: Type check**

Run: `pnpm run type-check` (if script exists, otherwise `pnpm tsc --noEmit`)

- [ ] **Step 3: Run existing tests**

Run: `pnpm run test`

- [ ] **Step 4: Commit all changes**

```bash
git add -A
git commit -m "✨ feat: add graph editing SDK endpoints (create/delete/update node+edge, merge, batch delete, neighborhood, atlas nodes, nodeTypes filter)"
```
