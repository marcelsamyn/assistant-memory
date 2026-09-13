import { defineEventHandler } from "h3";
import { getNodeSources } from "~/lib/node";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  getNodeSourcesRequestSchema,
  getNodeSourcesResponseSchema,
} from "~/lib/schemas/node";

export default defineEventHandler(async (event) => {
  const accessScope = getRequestAccessScope(event);
  const { userId, partitionKey, nodeId } = getNodeSourcesRequestSchema.parse(
    await readBody(event),
  );
  const result = await getNodeSources(
    userId,
    nodeId,
    partitionKey,
    accessScope,
  );
  return getNodeSourcesResponseSchema.parse(result);
});
