import { defineEventHandler, readBody } from "h3";
import {
  pruneOrphanNodes,
  pruneOrphanNodesWorkspace,
} from "~/lib/jobs/prune-orphan-nodes";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  pruneOrphanNodesRequestSchema,
  pruneOrphanNodesResponseSchema,
} from "~/lib/schemas/prune-orphan-nodes";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    pruneOrphanNodesRequestSchema,
    await readBody(event),
  );
  const db = await useDatabase();
  const accessScope = getRequestAccessScope(event);
  if (accessScope === "workspace" && params.partitionKey === undefined) {
    return pruneOrphanNodesResponseSchema.parse(
      await pruneOrphanNodesWorkspace(params, db),
    );
  }
  return pruneOrphanNodesResponseSchema.parse(
    await pruneOrphanNodes(params, db),
  );
});
