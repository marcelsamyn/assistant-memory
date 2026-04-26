import { defineEventHandler, createError } from "h3";
import { updateNode } from "~/lib/node";
import { hasNodeDescriptionUpdate } from "~/lib/node-update";
import {
  updateNodeRequestSchema,
  updateNodeResponseSchema,
} from "~/lib/schemas/node";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  if (hasNodeDescriptionUpdate(body)) {
    throw createError({
      statusCode: 405,
      statusMessage:
        "Node descriptions are generated from sourced claims and cannot be edited directly",
    });
  }

  const { userId, nodeId, label, nodeType } =
    updateNodeRequestSchema.parse(body);
  const result = await updateNode(userId, nodeId, {
    ...(label !== undefined && { label }),
    ...(nodeType !== undefined && { nodeType }),
  });
  if (!result) {
    throw createError({ statusCode: 404, statusMessage: "Node not found" });
  }
  return updateNodeResponseSchema.parse({ node: result });
});
