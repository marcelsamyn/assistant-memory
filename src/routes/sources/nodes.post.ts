import { defineEventHandler } from "h3";
import { fetchNodesBySource } from "~/lib/nodes-by-source";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  nodesBySourceRequestSchema,
  nodesBySourceResponseSchema,
} from "~/lib/schemas/nodes-by-source";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const {
    userId,
    partitionKey,
    sourceIds,
    nodeTypes,
    includeClaims,
    limit,
    cursor,
  } = nodesBySourceRequestSchema.parse(await readBody(event));
  const db = await useDatabase();
  const accessScope = getRequestAccessScope(event);
  const result = await fetchNodesBySource({
    db,
    userId,
    ...(partitionKey === undefined ? {} : { partitionKey }),
    sourceIds,
    nodeTypes,
    includeClaims,
    limit,
    cursor,
    accessScope,
  });
  return nodesBySourceResponseSchema.parse(result);
});
