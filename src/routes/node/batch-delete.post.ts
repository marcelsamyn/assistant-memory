import { defineEventHandler } from "h3";
import { batchDeleteNodes } from "~/lib/node";
import {
  batchDeleteNodesRequestSchema,
  batchDeleteNodesResponseSchema,
} from "~/lib/schemas/node-batch-delete";

export default defineEventHandler(async (event) => {
  const { userId, nodeIds } = batchDeleteNodesRequestSchema.parse(
    await readBody(event),
  );
  const count = await batchDeleteNodes(userId, nodeIds);
  return batchDeleteNodesResponseSchema.parse({ deleted: true, count });
});
