import { defineEventHandler, createError } from "h3";
import { getNodeById } from "~/lib/node";
import {
  getNodeRequestSchema,
  getNodeResponseSchema,
} from "~/lib/schemas/node";

export default defineEventHandler(async (event) => {
  const { userId, nodeId } = getNodeRequestSchema.parse(
    await readBody(event),
  );
  const result = await getNodeById(userId, nodeId);
  if (!result) {
    throw createError({ statusCode: 404, statusMessage: "Node not found" });
  }
  return getNodeResponseSchema.parse(result);
});
