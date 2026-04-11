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
