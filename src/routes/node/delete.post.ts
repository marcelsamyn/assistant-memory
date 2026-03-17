import { defineEventHandler, createError } from "h3";
import { deleteNode } from "~/lib/node";
import {
  deleteNodeRequestSchema,
  deleteNodeResponseSchema,
} from "~/lib/schemas/node";

export default defineEventHandler(async (event) => {
  const { userId, nodeId } = deleteNodeRequestSchema.parse(
    await readBody(event),
  );
  const deleted = await deleteNode(userId, nodeId);
  if (!deleted) {
    throw createError({ statusCode: 404, statusMessage: "Node not found" });
  }
  return deleteNodeResponseSchema.parse({ deleted: true });
});
