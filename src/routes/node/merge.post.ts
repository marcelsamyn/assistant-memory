import { defineEventHandler, createError } from "h3";
import { mergeNodes } from "~/lib/node";
import {
  mergeNodesRequestSchema,
  mergeNodesResponseSchema,
} from "~/lib/schemas/node-merge";

export default defineEventHandler(async (event) => {
  const { userId, nodeIds, targetLabel, targetDescription } =
    mergeNodesRequestSchema.parse(await readBody(event));
  const result = await mergeNodes(userId, nodeIds, {
    ...(targetLabel !== undefined && { targetLabel }),
    ...(targetDescription !== undefined && { targetDescription }),
  });
  if (!result) {
    throw createError({
      statusCode: 404,
      statusMessage: "One or more nodes not found",
    });
  }
  return mergeNodesResponseSchema.parse({ node: result });
});
