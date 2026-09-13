import { defineEventHandler, createError } from "h3";
import { CrossScopeMergeError, mergeNodes } from "~/lib/node";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  mergeNodesRequestSchema,
  mergeNodesResponseSchema,
} from "~/lib/schemas/node-merge";

export default defineEventHandler(async (event) => {
  const accessScope = getRequestAccessScope(event);
  const { userId, partitionKey, nodeIds, targetLabel, targetDescription } =
    mergeNodesRequestSchema.parse(await readBody(event));
  let result;
  try {
    result = await mergeNodes(
      userId,
      nodeIds,
      {
        ...(targetLabel !== undefined && { targetLabel }),
        ...(targetDescription !== undefined && { targetDescription }),
      },
      partitionKey,
      accessScope,
    );
  } catch (err) {
    if (err instanceof CrossScopeMergeError) {
      throw createError({
        statusCode: 409,
        statusMessage: "Cross-scope merge refused",
        data: { nodeIds: err.nodeIds, scopes: err.scopes },
      });
    }
    throw err;
  }
  if (!result) {
    throw createError({
      statusCode: 404,
      statusMessage: "One or more nodes not found",
    });
  }
  return mergeNodesResponseSchema.parse({ node: result });
});
