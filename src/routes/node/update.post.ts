import { defineEventHandler, createError } from "h3";
import { updateNode } from "~/lib/node";
import {
  updateNodeRequestSchema,
  updateNodeResponseSchema,
} from "~/lib/schemas/node";

export default defineEventHandler(async (event) => {
  const { userId, nodeId, label, description, nodeType } =
    updateNodeRequestSchema.parse(await readBody(event));
  const result = await updateNode(userId, nodeId, { label, description, nodeType });
  if (!result) {
    throw createError({ statusCode: 404, statusMessage: "Node not found" });
  }
  return updateNodeResponseSchema.parse({ node: result });
});
