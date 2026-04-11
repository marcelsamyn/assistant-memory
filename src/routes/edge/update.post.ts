import { defineEventHandler, createError } from "h3";
import { updateEdge } from "~/lib/edge";
import {
  updateEdgeRequestSchema,
  updateEdgeResponseSchema,
} from "~/lib/schemas/edge";

export default defineEventHandler(async (event) => {
  const { userId, edgeId, edgeType, description, sourceNodeId, targetNodeId } =
    updateEdgeRequestSchema.parse(await readBody(event));
  try {
    const result = await updateEdge(userId, edgeId, {
      ...(edgeType !== undefined && { edgeType }),
      ...(description !== undefined && { description }),
      ...(sourceNodeId !== undefined && { sourceNodeId }),
      ...(targetNodeId !== undefined && { targetNodeId }),
    });
    if (!result) {
      throw createError({ statusCode: 404, statusMessage: "Edge not found" });
    }
    return updateEdgeResponseSchema.parse({ edge: result });
  } catch (e) {
    if (e instanceof Error && e.message.includes("not found")) {
      throw createError({ statusCode: 404, statusMessage: e.message });
    }
    throw e;
  }
});
