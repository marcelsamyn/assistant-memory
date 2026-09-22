import { defineEventHandler } from "h3";
import { batchDeleteNodes } from "~/lib/node";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  batchDeleteNodesRequestSchema,
  batchDeleteNodesResponseSchema,
} from "~/lib/schemas/node-batch-delete";

export default defineEventHandler(async (event) => {
  const accessScope = getRequestAccessScope(event);
  const { userId, partitionKey, nodeIds } = parseRequestBody(
    batchDeleteNodesRequestSchema,
    await readBody(event),
  );
  const count = await batchDeleteNodes(
    userId,
    nodeIds,
    partitionKey,
    accessScope,
  );
  return batchDeleteNodesResponseSchema.parse({ deleted: true, count });
});
