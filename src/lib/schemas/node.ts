import {
  ClaimStatusEnum,
  AssertedByKindEnum,
  NodeTypeEnum,
  PredicateEnum,
  ScopeEnum,
} from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

// --- Get Node ---

/**
 * Optional server-side claim filter for `getNode`. By default the response
 * includes only `active` claims touching the node; callers that want a
 * narrower slice (e.g. only the active `HAS_TASK_STATUS` for a Task) can
 * filter by predicate, and callers that need lifecycle history (superseded,
 * retracted, contradicted) can opt in via `statuses`.
 *
 * - `predicates` — empty array means "no predicate constraint" (same as
 *   omitting the field).
 * - `statuses` — empty array means "no status constraint", which returns
 *   claims of every status, including non-active ones.
 */
export const getNodeClaimFilterSchema = z.object({
  predicates: z.array(PredicateEnum).optional(),
  statuses: z.array(ClaimStatusEnum).optional(),
});

export const getNodeRequestSchema = z.object({
  userId: z.string(),
  nodeId: typeIdSchema("node"),
  claimFilter: getNodeClaimFilterSchema.optional(),
});

export type GetNodeClaimFilter = z.infer<typeof getNodeClaimFilterSchema>;

export const getNodeClaimSchema = z.object({
  id: typeIdSchema("claim"),
  subjectNodeId: typeIdSchema("node"),
  objectNodeId: typeIdSchema("node").nullable(),
  objectValue: z.string().nullable(),
  predicate: PredicateEnum,
  statement: z.string(),
  description: z.string().nullable(),
  subjectLabel: z.string().nullable(),
  objectLabel: z.string().nullable(),
  sourceId: typeIdSchema("source"),
  scope: ScopeEnum,
  assertedByKind: AssertedByKindEnum,
  assertedByNodeId: typeIdSchema("node").nullable(),
  status: ClaimStatusEnum,
  statedAt: z.coerce.date(),
});

export const getNodeResponseSchema = z.object({
  node: z.object({
    id: typeIdSchema("node"),
    nodeType: NodeTypeEnum,
    label: z.string().nullable(),
    description: z.string().nullable(),
    createdAt: z.coerce.date(),
    sourceIds: z.array(z.string()),
    aliases: z.array(
      z.object({
        id: typeIdSchema("alias"),
        aliasText: z.string(),
        createdAt: z.coerce.date(),
      }),
    ),
  }),
  claims: z.array(getNodeClaimSchema),
});

export type GetNodeRequest = z.infer<typeof getNodeRequestSchema>;
export type GetNodeResponse = z.infer<typeof getNodeResponseSchema>;

// --- Get Node Sources ---

export const getNodeSourcesRequestSchema = z.object({
  userId: z.string(),
  nodeId: typeIdSchema("node"),
});

export const nodeSourceSchema = z.object({
  sourceId: z.string(),
  type: z.string(),
  content: z.string().nullable(),
  timestamp: z.coerce.date().nullable(),
});

export const getNodeSourcesResponseSchema = z.object({
  sources: z.array(nodeSourceSchema),
});

export type GetNodeSourcesRequest = z.infer<typeof getNodeSourcesRequestSchema>;
export type GetNodeSourcesResponse = z.infer<
  typeof getNodeSourcesResponseSchema
>;

// --- Update Node ---

export const updateNodeRequestSchema = z.object({
  userId: z.string(),
  nodeId: typeIdSchema("node"),
  label: z.string().optional(),
  nodeType: NodeTypeEnum.optional(),
});

export const updateNodeResponseSchema = z.object({
  node: z.object({
    id: typeIdSchema("node"),
    nodeType: NodeTypeEnum,
    label: z.string().nullable(),
    description: z.string().nullable(),
  }),
});

export type UpdateNodeRequest = z.infer<typeof updateNodeRequestSchema>;
export type UpdateNodeResponse = z.infer<typeof updateNodeResponseSchema>;

// --- Delete Node ---

export const deleteNodeRequestSchema = z.object({
  userId: z.string(),
  nodeId: typeIdSchema("node"),
});

/**
 * Counts of claims affected by a node deletion. `cascadeDeleted` covers claims
 * removed because the node was the subject or object (FK `ON DELETE CASCADE`).
 * `assertedByCleared` covers participant-provenance claims whose
 * `assertedByNodeId` was nulled (FK `ON DELETE SET NULL`); those claims remain
 * active but lose attribution. Callers can use these to audit downstream
 * effects after a destructive operation.
 */
export const deleteNodeAffectedClaimsSchema = z.object({
  cascadeDeleted: z.number().int().nonnegative(),
  assertedByCleared: z.number().int().nonnegative(),
});

export const deleteNodeResponseSchema = z.object({
  deleted: z.literal(true),
  affectedClaims: deleteNodeAffectedClaimsSchema,
});

export type DeleteNodeRequest = z.infer<typeof deleteNodeRequestSchema>;
export type DeleteNodeResponse = z.infer<typeof deleteNodeResponseSchema>;

// --- Create Node ---

/**
 * Bootstrap claim attached to a freshly created node. The new node fills
 * the `subjectNodeId` slot, so callers only specify the predicate, statement,
 * and either an `objectNodeId` or `objectValue`. Used to avoid intermediate
 * states where a node exists without its required status/owner claims (e.g.
 * a Task with no `HAS_TASK_STATUS` would be invisible to open-commitments).
 */
export const createNodeInitialClaimSchema = z
  .object({
    predicate: PredicateEnum,
    statement: z.string().min(1),
    description: z.string().optional(),
    objectNodeId: typeIdSchema("node").optional(),
    objectValue: z.string().min(1).optional(),
    assertedByKind: AssertedByKindEnum.optional(),
    assertedByNodeId: typeIdSchema("node").optional(),
  })
  .refine(
    (value) =>
      (value.objectNodeId === undefined) !== (value.objectValue === undefined),
    {
      message: "Exactly one of objectNodeId or objectValue is required",
    },
  );

export type CreateNodeInitialClaim = z.infer<
  typeof createNodeInitialClaimSchema
>;

export const createNodeRequestSchema = z.object({
  userId: z.string(),
  nodeType: NodeTypeEnum,
  label: z.string().min(1),
  description: z.string().optional(),
  /**
   * Optional list of claims to assert against the new node as its subject.
   * Written sequentially after the node insert; if any claim fails, the
   * node is deleted to avoid leaving a half-bootstrapped record.
   */
  initialClaims: z.array(createNodeInitialClaimSchema).optional(),
});

export const createNodeResponseSchema = z.object({
  node: z.object({
    id: typeIdSchema("node"),
    nodeType: NodeTypeEnum,
    label: z.string(),
    description: z.string().nullable(),
  }),
  /**
   * IDs of claims created from `initialClaims`, in the order they were
   * supplied. Empty when no `initialClaims` were sent.
   */
  initialClaimIds: z.array(typeIdSchema("claim")),
});

export type CreateNodeRequest = z.infer<typeof createNodeRequestSchema>;
export type CreateNodeResponse = z.infer<typeof createNodeResponseSchema>;
