/**
 * REST/SDK schemas for `POST /maintenance/prune-orphan-nodes`.
 *
 * This is deterministic maintenance for legacy/entity nodes that have no
 * evidence: no claims, no source links, and no aliases. It first removes
 * blob-backed source rows whose payload no longer exists, then prunes nodes
 * made evidence-free by that repair. It is intentionally separate from LLM
 * cleanup because these are structural invariants, not model judgments.
 */
import { z } from "zod";
import { NodeTypeEnum } from "~/types/graph.js";
import { typeIdSchema } from "~/types/typeid.js";

export const pruneOrphanNodesRequestSchema = z.object({
  userId: z.string().startsWith("user_"),
  olderThanDays: z.number().int().nonnegative().default(7),
  limit: z.number().int().positive().max(10_000).default(1_000),
  sourceScanLimit: z.number().int().positive().max(50_000).default(10_000),
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

export const pruneMissingBlobSourceSchema = z.object({
  id: typeIdSchema("source"),
  type: z.string(),
  externalId: z.string(),
  createdAt: z.coerce.date(),
});

export const pruneOrphanNodesResponseSchema = z.object({
  dryRun: z.boolean(),
  sourceScanCount: z.number().int().nonnegative(),
  sourceScanHasMore: z.boolean(),
  missingBlobSourceCandidateCount: z.number().int().nonnegative(),
  deletedMissingBlobSourceCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  scannedNodeTypes: z.array(NodeTypeEnum),
  missingBlobSources: z.array(pruneMissingBlobSourceSchema),
  candidates: z.array(pruneOrphanNodeSchema),
});

export type PruneOrphanNode = z.infer<typeof pruneOrphanNodeSchema>;
export type PruneMissingBlobSource = z.infer<
  typeof pruneMissingBlobSourceSchema
>;
export type PruneOrphanNodesResponse = z.infer<
  typeof pruneOrphanNodesResponseSchema
>;
