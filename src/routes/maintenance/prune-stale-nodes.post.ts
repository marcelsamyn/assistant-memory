import { defineEventHandler, readBody } from "h3";
import {
  pruneStaleNodes,
  pruneStaleNodesWorkspace,
} from "~/lib/jobs/prune-stale-nodes";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  pruneStaleNodesRequestSchema,
  pruneStaleNodesResponseSchema,
} from "~/lib/schemas/prune-stale-nodes";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    pruneStaleNodesRequestSchema,
    await readBody(event),
  );
  const db = await useDatabase();
  const accessScope = getRequestAccessScope(event);
  if (accessScope === "workspace" && params.partitionKey === undefined) {
    return pruneStaleNodesResponseSchema.parse(
      await pruneStaleNodesWorkspace(params, db),
    );
  }
  return pruneStaleNodesResponseSchema.parse(await pruneStaleNodes(params, db));
});
