import { TaskStatusEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

export const presentationSourceSchema = z.object({
  sourceId: typeIdSchema("source"),
  title: z.string().nullable(),
  overheardAt: z.coerce.date().nullable(),
});

export const commitmentPresentationSchema = z.object({
  source: presentationSourceSchema.nullable(),
  excerpt: z.string().nullable(),
  why: z.string().nullable(),
});
export type CommitmentPresentation = z.infer<
  typeof commitmentPresentationSchema
>;

/** Sort key for `listCommitments`. */
export const commitmentSortEnum = z.enum([
  "statusChangedAt",
  "dueOn",
  "dueAt",
  "createdAt",
  "label",
]);
export type CommitmentSort = z.infer<typeof commitmentSortEnum>;

/**
 * Provenance band for `listCommitments`:
 * - `"trusted"` — every status kind EXCEPT `assistant_inferred`.
 * - `"candidate"` — ONLY `assistant_inferred` (unconfirmed tasks).
 * - `"all"` — no provenance constraint.
 */
export const commitmentProvenanceEnum = z.enum(["trusted", "candidate", "all"]);
export type CommitmentProvenance = z.infer<typeof commitmentProvenanceEnum>;

/**
 * Paginated, sortable, searchable, filterable list over the full commitment
 * lifecycle (open + done + abandoned). Drives off the active `HAS_TASK_STATUS`
 * claim, so there is exactly one row per task and keyset pagination is total.
 */
export const listCommitmentsRequestSchema = z
  .object({
    userId: z.string(),
    /** Status filter; omit to include all four statuses. */
    statuses: z.array(TaskStatusEnum).optional(),
    provenance: commitmentProvenanceEnum.default("trusted"),
    /** Only tasks owned by this node. Mutually exclusive with `unowned`. */
    ownedBy: typeIdSchema("node").optional(),
    /** Only tasks with no active `ASSIGNED_TO`. Mutually exclusive with `ownedBy`. */
    unowned: z.boolean().optional(),
    /** `YYYY-MM-DD`, inclusive upper bound on the due date. */
    dueBefore: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "dueBefore must be YYYY-MM-DD")
      .optional(),
    /** `YYYY-MM-DD`, inclusive lower bound on the due date. */
    dueAfter: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "dueAfter must be YYYY-MM-DD")
      .optional(),
    /** ISO instant, inclusive upper bound on `object_instant` (timed tasks only). */
    dueBeforeInstant: z.string().datetime().pipe(z.coerce.date()).optional(),
    /** ISO instant, inclusive lower bound on `object_instant` (timed tasks only). */
    dueAfterInstant: z.string().datetime().pipe(z.coerce.date()).optional(),
    /** `false` → only tasks without a due date; `true` → only tasks with one. */
    hasDueDate: z.boolean().optional(),
    /** Case-insensitive label substring search. */
    search: z.string().min(1).optional(),
    sort: commitmentSortEnum.default("statusChangedAt"),
    order: z.enum(["asc", "desc"]).default("desc"),
    limit: z.number().int().min(1).max(200).default(50),
    /** Opaque keyset cursor returned as `nextCursor` by a prior page. */
    cursor: z.string().optional(),
  })
  .refine((v) => !(v.ownedBy !== undefined && v.unowned === true), {
    message: "ownedBy and unowned are mutually exclusive",
  });

export const commitmentListItemSchema = z.object({
  taskId: typeIdSchema("node"),
  label: z.string().nullable(),
  /** Any of the four statuses (the list is not restricted to open tasks). */
  status: TaskStatusEnum,
  owner: z
    .object({
      nodeId: typeIdSchema("node"),
      label: z.string().nullable(),
    })
    .nullable(),
  dueOn: z.string().nullable(),
  dueTime: z.string().nullable(),
  timeZone: z.string().nullable(),
  dueAt: z.coerce.date().nullable(),
  /** `statedAt` of the active status claim. */
  statusChangedAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  sourceId: typeIdSchema("source"),
  /** Inline evidence for the inbox card. Null when no source resolves. */
  presentation: commitmentPresentationSchema.nullable(),
});

export const listCommitmentsResponseSchema = z.object({
  commitments: z.array(commitmentListItemSchema),
  nextCursor: z.string().nullable(),
});

export type ListCommitmentsRequest = z.infer<
  typeof listCommitmentsRequestSchema
>;
export type CommitmentListItem = z.infer<typeof commitmentListItemSchema>;
export type ListCommitmentsResponse = z.infer<
  typeof listCommitmentsResponseSchema
>;
