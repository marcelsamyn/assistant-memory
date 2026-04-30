/**
 * Request/response schemas for the MCP `bootstrap_memory` and `get_entity`
 * tools. The corresponding handlers live in `src/lib/context/`. Kept here
 * (alongside other route schemas) so the MCP server can mount `.shape` for
 * tool registration without pulling Redis/DB-connecting modules.
 *
 * Common aliases: bootstrap memory schema, get_entity schema, bootstrap_memory.
 */
import { z } from "zod";
import { typeIdSchema } from "~/types/typeid";

export const bootstrapMemoryRequestSchema = z.object({
  userId: z.string(),
  forceRefresh: z.boolean().optional(),
});
export type BootstrapMemoryRequest = z.infer<
  typeof bootstrapMemoryRequestSchema
>;

export const getEntityRequestSchema = z.object({
  userId: z.string(),
  nodeId: typeIdSchema("node"),
});
export type GetEntityRequest = z.infer<typeof getEntityRequestSchema>;
