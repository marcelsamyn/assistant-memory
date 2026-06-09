import { defineEventHandler, readBody } from "h3";
import { pruneStaleNodes } from "~/lib/jobs/prune-stale-nodes";
import {
  pruneStaleNodesRequestSchema,
  pruneStaleNodesResponseSchema,
} from "~/lib/schemas/prune-stale-nodes";

export default defineEventHandler(async (event) => {
  const params = pruneStaleNodesRequestSchema.parse(await readBody(event));
  const result = await pruneStaleNodes(params);
  return pruneStaleNodesResponseSchema.parse(result);
});
