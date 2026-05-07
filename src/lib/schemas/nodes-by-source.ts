/**
 * Schema for `POST /sources/nodes` (`getNodesBySource` SDK method).
 *
 * Bulk, deterministic retrieval of every node derived from one or more
 * sources, with a paged view onto the active claims that touch those
 * nodes. Used by hosts that want to inject a project's full attached
 * source set into a chat without semantic search uncertainty.
 */
import { NodeTypeEnum, ScopeEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { getNodeClaimSchema } from "./node.js";
import { z } from "zod";

const DEFAULT_EXCLUDED_NODE_TYPES = [
  NodeTypeEnum.enum.AssistantDream,
  NodeTypeEnum.enum.Atlas,
  NodeTypeEnum.enum.Temporal,
] as const;

export const nodesBySourceRequestSchema = z.object({
  userId: z.string(),
  sourceIds: z.array(typeIdSchema("source")).min(1).max(100),
  /**
   * Optional node-type allow-list. When omitted, the response excludes
   * dream/atlas/temporal nodes (matching the default in `query/search`)
   * since callers using this for context injection rarely want them.
   */
  nodeTypes: z.array(NodeTypeEnum).optional(),
  /**
   * When `true`, claims attached to the returned nodes are included.
   * Defaults to `true` because the primary caller (project context
   * injection) wants both shapes.
   */
  includeClaims: z.boolean().optional().default(true),
  limit: z.number().int().min(1).max(500).optional().default(200),
  cursor: z.string().optional(),
});
export type NodesBySourceRequest = z.infer<typeof nodesBySourceRequestSchema>;

export const sourceNodeSchema = z.object({
  id: typeIdSchema("node"),
  nodeType: NodeTypeEnum,
  label: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.coerce.date(),
  /** Subset of input `sourceIds` this node was actually linked to. */
  sourceIds: z.array(typeIdSchema("source")),
  scope: ScopeEnum.optional(),
});
export type SourceNode = z.infer<typeof sourceNodeSchema>;

export const nodesBySourceResponseSchema = z.object({
  nodes: z.array(sourceNodeSchema),
  /**
   * Active claims whose subject is one of the returned nodes. Empty when
   * `includeClaims: false`. Same row shape as `getNode`'s claim entries.
   */
  claims: z.array(getNodeClaimSchema),
  nextCursor: z.string().nullable(),
});
export type NodesBySourceResponse = z.infer<typeof nodesBySourceResponseSchema>;

export { DEFAULT_EXCLUDED_NODE_TYPES };
