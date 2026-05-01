import { defineEventHandler, readBody } from "h3";
import { pruneOrphanNodes } from "~/lib/jobs/prune-orphan-nodes";
import {
  pruneOrphanNodesRequestSchema,
  pruneOrphanNodesResponseSchema,
} from "~/lib/schemas/prune-orphan-nodes";

export default defineEventHandler(async (event) => {
  const params = pruneOrphanNodesRequestSchema.parse(await readBody(event));
  const result = await pruneOrphanNodes(params);
  return pruneOrphanNodesResponseSchema.parse(result);
});
