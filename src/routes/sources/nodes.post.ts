import { defineEventHandler } from "h3";
import { fetchNodesBySource } from "~/lib/nodes-by-source";
import {
  nodesBySourceRequestSchema,
  nodesBySourceResponseSchema,
} from "~/lib/schemas/nodes-by-source";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, sourceIds, nodeTypes, includeClaims, limit, cursor } =
    nodesBySourceRequestSchema.parse(await readBody(event));
  const db = await useDatabase();
  const result = await fetchNodesBySource({
    db,
    userId,
    sourceIds,
    nodeTypes,
    includeClaims,
    limit,
    cursor,
  });
  return nodesBySourceResponseSchema.parse(result);
});
