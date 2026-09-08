import { defineEventHandler } from "h3";
import { getNodeSources } from "~/lib/node";
import {
  getNodeSourcesRequestSchema,
  getNodeSourcesResponseSchema,
} from "~/lib/schemas/node";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, nodeId } = getNodeSourcesRequestSchema.parse(
    await readBody(event),
  );
  const result = await getNodeSources(userId, nodeId, partitionKey);
  return getNodeSourcesResponseSchema.parse(result);
});
