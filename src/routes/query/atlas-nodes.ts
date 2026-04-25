import { and, eq, or } from "drizzle-orm";
import { defineEventHandler } from "h3";
import { claims } from "~/db/schema";
import { ensureAssistantAtlasNode } from "~/lib/atlas";
import {
  queryAtlasNodesRequestSchema,
  queryAtlasNodesResponseSchema,
} from "~/lib/schemas/query-atlas-nodes";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, assistantId } = queryAtlasNodesRequestSchema.parse(
    await readBody(event),
  );
  const db = await useDatabase();
  const atlasNodeId = await ensureAssistantAtlasNode(db, userId, assistantId);

  const claimRows = await db
    .select({
      subjectNodeId: claims.subjectNodeId,
      objectNodeId: claims.objectNodeId,
    })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.status, "active"),
        or(
          eq(claims.subjectNodeId, atlasNodeId),
          eq(claims.objectNodeId, atlasNodeId),
        ),
      ),
    );

  const nodeIds = new Set<string>();
  for (const row of claimRows) {
    if (row.subjectNodeId !== atlasNodeId) nodeIds.add(row.subjectNodeId);
    if (row.objectNodeId && row.objectNodeId !== atlasNodeId) {
      nodeIds.add(row.objectNodeId);
    }
  }

  return queryAtlasNodesResponseSchema.parse({
    nodeIds: Array.from(nodeIds),
  });
});
