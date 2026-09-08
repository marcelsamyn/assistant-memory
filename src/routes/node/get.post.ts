import { defineEventHandler, createError } from "h3";
import { getNodeById } from "~/lib/node";
import {
  getNodeRequestSchema,
  getNodeResponseSchema,
} from "~/lib/schemas/node";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, nodeId, claimFilter } =
    getNodeRequestSchema.parse(await readBody(event));
  const result = await getNodeById(userId, nodeId, claimFilter, partitionKey);
  if (!result) {
    throw createError({ statusCode: 404, statusMessage: "Node not found" });
  }
  return getNodeResponseSchema.parse(result);
});
