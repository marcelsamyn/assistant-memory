import { defineEventHandler, createError } from "h3";
import { summarizeNode } from "~/lib/node";
import {
  summarizeNodeRequestSchema,
  summarizeNodeResponseSchema,
} from "~/lib/schemas/node";

export default defineEventHandler(async (event) => {
  const { userId, nodeId } = summarizeNodeRequestSchema.parse(
    await readBody(event),
  );
  const result = await summarizeNode({ userId, nodeId });
  if (!result) {
    throw createError({ statusCode: 404, statusMessage: "Node not found" });
  }
  return summarizeNodeResponseSchema.parse(result);
});
