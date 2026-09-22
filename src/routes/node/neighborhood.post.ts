import { defineEventHandler, createError } from "h3";
import { getNodeNeighborhood } from "~/lib/node";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  nodeNeighborhoodRequestSchema,
  nodeNeighborhoodResponseSchema,
} from "~/lib/schemas/node-neighborhood";

export default defineEventHandler(async (event) => {
  const accessScope = getRequestAccessScope(event);
  const { userId, partitionKey, nodeId, depth } = parseRequestBody(
    nodeNeighborhoodRequestSchema,
    await readBody(event),
  );
  const result = await getNodeNeighborhood(
    userId,
    nodeId,
    depth,
    partitionKey,
    accessScope,
  );
  if (!result) {
    throw createError({ statusCode: 404, statusMessage: "Node not found" });
  }
  return nodeNeighborhoodResponseSchema.parse(result);
});
