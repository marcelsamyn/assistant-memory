/**
 * REST/SDK schemas for `POST /maintenance/prune-stale-nodes`.
 *
 * A deterministic "garbage collect" sweep for accreted graph cruft. Unlike
 * {@link ./prune-orphan-nodes} — which only removes nodes with *zero* evidence
 * — this scores every entity/task node on a staleness/weakness basis and prunes
 * the disposable tail: nodes that are old, weakly connected, backed only by
 * assistant-inferred claims, or dominated by superseded claims.
 *
 * Scoring is intentionally LLM-free so the sweep is fast, cheap, and repeatable
 * over a large graph, and so a consumer (e.g. a chat host's "clean up my
 * memory" button) can show a stable preview before anything is deleted.
 *
 * The endpoint is preview-then-apply: `dryRun: true` (the default) returns the
 * ranked candidates with per-node `reasons`; a second call with the same
 * thresholds and `dryRun: false` deletes them.
 */
import { z } from "zod";
import { NodeTypeEnum } from "~/types/graph.js";
import { typeIdSchema } from "~/types/typeid.js";

export const pruneStaleNodesRequestSchema = z.object({
  userId: z.string().min(1),
  /**
   * Single tuning knob in `[0, 1]`. Higher prunes more. Maps to the score
   * threshold as `threshold = 1 - aggressiveness` (so `0.5` keeps everything
   * scoring below `0.5`). Ignored when `minScore` is provided.
   */
  aggressiveness: z.number().min(0).max(1).default(0.5),
  /**
   * Explicit score threshold override in `[0, 1]`. When set, a node is a
   * candidate iff its prunability score is `>= minScore`, bypassing the
   * `aggressiveness` mapping. Use this for reproducible scheduled sweeps.
   */
  minScore: z.number().min(0).max(1).optional(),
  /**
   * Recency floor: never prune a node whose most recent activity (its newest
   * claim, or its own creation when it has no claims) is within this many days.
   * Protects freshly-created and mid-ingestion nodes.
   */
  minIdleDays: z.number().int().nonnegative().default(30),
  /**
   * Idle horizon for the staleness component: a node idle for this many days
   * contributes the maximum staleness (1.0) to its score. Lower values make the
   * sweep treat moderately-old nodes as fully stale.
   */
  stalenessHorizonDays: z.number().int().positive().default(365),
  /**
   * Include reference-scope nodes (books, articles, imported documents). Off by
   * default: the reference corpus is usually curated on purpose, so only
   * personal/conversational memory is swept unless this is set.
   */
  includeReference: z.boolean().default(false),
  /** Max nodes to delete per call. Re-call to page through a larger backlog. */
  limit: z.number().int().positive().max(10_000).default(1_000),
  /** Max scored candidates returned in the `candidates` sample. */
  sampleLimit: z.number().int().nonnegative().max(500).default(50),
  /**
   * Dry run by default because this is destructive. Set `dryRun: false` to
   * delete after inspecting the preview.
   */
  dryRun: z.boolean().default(true),
  /**
   * Defaults to entity/task-like node types. Structural and generated node
   * types (`Conversation`, `Document`, `Temporal`, `Atlas`, `AssistantDream`)
   * are deliberately excluded unless a caller explicitly opts in.
   */
  nodeTypes: z.array(NodeTypeEnum).optional(),
});

export type PruneStaleNodesRequest = z.input<
  typeof pruneStaleNodesRequestSchema
>;

export const staleNodeCandidateSchema = z.object({
  id: typeIdSchema("node"),
  nodeType: NodeTypeEnum,
  label: z.string().nullable(),
  createdAt: z.coerce.date(),
  /** Newest signal of activity: max(createdAt, newest claim statedAt). */
  lastActivityAt: z.coerce.date(),
  idleDays: z.number().int().nonnegative(),
  /** Prunability score in `[0, 1]`, rounded to 3 decimals. Higher = weaker. */
  score: z.number().min(0).max(1),
  activeClaimCount: z.number().int().nonnegative(),
  totalClaimCount: z.number().int().nonnegative(),
  /** Human-readable explanation of why this node scored as prunable. */
  reasons: z.array(z.string()),
});

export const pruneStaleNodesResponseSchema = z.object({
  dryRun: z.boolean(),
  /** Effective score threshold actually used (after the aggressiveness map). */
  appliedThreshold: z.number().min(0).max(1),
  minIdleDays: z.number().int().nonnegative(),
  /** Total nodes of the scanned types that were scored. */
  scannedCount: z.number().int().nonnegative(),
  /** Nodes meeting the prune criteria (may exceed `limit` and `deletedCount`). */
  candidateCount: z.number().int().nonnegative(),
  /** Nodes actually deleted this call (0 when `dryRun`). */
  deletedCount: z.number().int().nonnegative(),
  /** True when more candidates remain than this call could delete (`limit`). */
  hasMore: z.boolean(),
  scannedNodeTypes: z.array(NodeTypeEnum),
  /** Highest-scoring candidates, capped at `sampleLimit`. */
  candidates: z.array(staleNodeCandidateSchema),
});

export type StaleNodeCandidate = z.infer<typeof staleNodeCandidateSchema>;
export type PruneStaleNodesResponse = z.infer<
  typeof pruneStaleNodesResponseSchema
>;
