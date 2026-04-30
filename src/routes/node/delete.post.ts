import { defineEventHandler, createError } from "h3";
import { deleteNode } from "~/lib/node";
import {
  deleteNodeRequestSchema,
  deleteNodeResponseSchema,
} from "~/lib/schemas/node";

/**
 * Delete a node and report the downstream impact on claims.
 *
 * Postgres FKs handle dependent rows; the response surfaces the counts so
 * callers can audit:
 *
 * - `affectedClaims.cascadeDeleted`: claims removed because the node was the
 *   subject or object (`ON DELETE CASCADE`). These claims are gone.
 * - `affectedClaims.assertedByCleared`: active claims whose
 *   `assertedByNodeId` was nulled (`ON DELETE SET NULL`). The claims survive
 *   without participant attribution.
 *
 * A claim's `statement` is free-form narrative and may textually mention the
 * deleted node by label or id — that is content drift, not a broken FK.
 */
export default defineEventHandler(async (event) => {
  const { userId, nodeId } = deleteNodeRequestSchema.parse(
    await readBody(event),
  );
  const { deleted, affectedClaims } = await deleteNode(userId, nodeId);
  if (!deleted) {
    throw createError({ statusCode: 404, statusMessage: "Node not found" });
  }
  return deleteNodeResponseSchema.parse({ deleted: true, affectedClaims });
});
