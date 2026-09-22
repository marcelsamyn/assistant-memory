import { defineEventHandler, createError } from "h3";
import { getNodeById } from "~/lib/node";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  getNodeRequestSchema,
  getNodeResponseSchema,
} from "~/lib/schemas/node";

export default defineEventHandler(async (event) => {
  const accessScope = getRequestAccessScope(event);
  const { userId, partitionKey, nodeId, claimFilter } = parseRequestBody(
    getNodeRequestSchema,
    await readBody(event),
  );
  const result = await getNodeById(
    userId,
    nodeId,
    claimFilter,
    partitionKey,
    accessScope,
  );
  if (!result) {
    throw createError({ statusCode: 404, statusMessage: "Node not found" });
  }
  return getNodeResponseSchema.parse(result);
});
