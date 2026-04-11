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
