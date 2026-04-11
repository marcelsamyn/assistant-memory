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
