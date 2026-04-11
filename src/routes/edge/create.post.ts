import { defineEventHandler, createError } from "h3";
import { createEdge } from "~/lib/edge";
import {
  createEdgeRequestSchema,
  createEdgeResponseSchema,
} from "~/lib/schemas/edge";

export default defineEventHandler(async (event) => {
  const { userId, sourceNodeId, targetNodeId, edgeType, description } =
    createEdgeRequestSchema.parse(await readBody(event));
  try {
    const edge = await createEdge(
      userId,
      sourceNodeId,
      targetNodeId,
      edgeType,
      description,
    );
    return createEdgeResponseSchema.parse({ edge });
  } catch (e) {
    if (e instanceof Error && e.message.includes("not found")) {
      throw createError({ statusCode: 404, statusMessage: e.message });
    }
    throw e;
  }
});
