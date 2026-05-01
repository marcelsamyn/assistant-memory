/**
 * REST/SDK schemas for `POST /maintenance/prune-orphan-nodes`.
 *
 * This is deterministic maintenance for legacy/entity nodes that have no
 * evidence: no claims, no source links, and no aliases. It is intentionally
 * separate from LLM cleanup because orphan pruning is a structural invariant,
 * not a model judgment.
 */
import { z } from "zod";
import { NodeTypeEnum } from "~/types/graph";
import { typeIdSchema } from "~/types/typeid";

export const pruneOrphanNodesRequestSchema = z.object({
  userId: z.string().startsWith("user_"),
  olderThanDays: z.number().int().nonnegative().default(7),
  limit: z.number().int().positive().max(10_000).default(1_000),
  sampleLimit: z.number().int().nonnegative().max(500).default(50),
  /**
   * Dry run by default because this is destructive. Set `dryRun: false` for
   * scheduled maintenance after inspecting counts in production.
   */
  dryRun: z.boolean().default(true),
  /**
   * Defaults to entity/task-like node types. Structural and generated node
   * types (`Conversation`, `Document`, `Temporal`, `Atlas`, `AssistantDream`)
   * are deliberately excluded unless a caller explicitly opts in.
   */
  nodeTypes: z.array(NodeTypeEnum).optional(),
});

export type PruneOrphanNodesRequest = z.input<
  typeof pruneOrphanNodesRequestSchema
>;

export const pruneOrphanNodeSchema = z.object({
  id: typeIdSchema("node"),
  nodeType: NodeTypeEnum,
  label: z.string().nullable(),
  createdAt: z.coerce.date(),
});

export const pruneOrphanNodesResponseSchema = z.object({
  dryRun: z.boolean(),
  candidateCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  scannedNodeTypes: z.array(NodeTypeEnum),
  candidates: z.array(pruneOrphanNodeSchema),
});

export type PruneOrphanNode = z.infer<typeof pruneOrphanNodeSchema>;
export type PruneOrphanNodesResponse = z.infer<
  typeof pruneOrphanNodesResponseSchema
>;
