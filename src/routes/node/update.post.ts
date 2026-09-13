import { defineEventHandler, createError } from "h3";
import { updateNode } from "~/lib/node";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  updateNodeRequestSchema,
  updateNodeResponseSchema,
} from "~/lib/schemas/node";

export default defineEventHandler(async (event) => {
  const accessScope = getRequestAccessScope(event);
  const { userId, partitionKey, nodeId, label, nodeType, description } =
    updateNodeRequestSchema.parse(await readBody(event));
  const result = await updateNode(
    userId,
    nodeId,
    {
      ...(label !== undefined && { label }),
      ...(nodeType !== undefined && { nodeType }),
      ...(description !== undefined && { description }),
    },
    partitionKey,
    accessScope,
  );
  if (!result) {
    throw createError({ statusCode: 404, statusMessage: "Node not found" });
  }
  return updateNodeResponseSchema.parse({ node: result });
});
