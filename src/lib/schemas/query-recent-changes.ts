/**
 * Schemas for the "recent changes" feed (`POST /query/recent-changes`).
 *
 * A time-range query that returns the personal, currently-active claims and
 * the nodes added or updated within `[since, until]`, each carrying labels
 * and provenance. Built for "what's new in memory since you last looked"
 * surfaces — the daily digest and a Memory "Today" dashboard — so consumers
 * can render a feed without an N+1 `getNode`/`getSource` fan-out.
 *
 * Unlike `query/day` this takes a `since` cursor (not a single calendar
 * date), spans multiple days, and includes claims-with-labels plus a
 * `changeKind` and per-source grouping data.
 */
import {
  AssertedByKindEnum,
  NodeTypeEnum,
  PredicateEnum,
} from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

/**
 * ISO-8601 datetime, e.g. `2026-05-29T08:00:00Z`. Accepts a UTC `Z` suffix
 * or a numeric offset (`+02:00`); the natural output of `Date#toISOString()`.
 */
const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true, message: "Must be an ISO-8601 datetime string" });

/**
 * Whether an item was first created inside the window (`added`) or existed
 * beforehand and was touched within it (`updated`). For nodes, `updated`
 * means a node created before `since` that gained a new active claim in the
 * window (e.g. an existing project newly linked to a person).
 */
export const changeKindEnum = z.enum(["added", "updated"]);
export type ChangeKind = z.infer<typeof changeKindEnum>;

export const queryRecentChangesRequestSchema = z.object({
  userId: z.string(),
  /** Inclusive lower bound on change time (a claim/node `createdAt` or `updatedAt`). */
  since: isoDateTimeSchema,
  /** Inclusive upper bound; defaults to "now" when omitted. */
  until: isoDateTimeSchema.optional(),
  /** Caps the `claims` and `nodes` lists independently (default 100, max 500). */
  limit: z.number().int().min(1).max(500).default(100),
  /**
   * Restrict the feed to these node types. Applies to the `nodes` list and
   * to `claims` (kept when their subject or object node matches). When
   * omitted, structural `Temporal`/`Atlas`/`AssistantDream` nodes are
   * excluded from `nodes` so a digest isn't flooded with day buckets.
   */
  nodeTypes: z.array(NodeTypeEnum).optional(),
});

export const recentChangeClaimSchema = z.object({
  id: typeIdSchema("claim"),
  predicate: PredicateEnum,
  statement: z.string(),
  /** Label of the claim's subject node (`null` if the node has no metadata). */
  subjectLabel: z.string().nullable(),
  /**
   * Label of the claim's object. For relationship claims this is the object
   * node's label; for attribute claims (no object node) it is the literal
   * `objectValue` (e.g. `"finish draft by June 30"`).
   */
  objectLabel: z.string().nullable(),
  sourceId: typeIdSchema("source"),
  statedAt: z.coerce.date(),
  changeKind: changeKindEnum,
  assertedByKind: AssertedByKindEnum,
});
export type RecentChangeClaim = z.infer<typeof recentChangeClaimSchema>;

export const recentChangeNodeSchema = z.object({
  id: typeIdSchema("node"),
  nodeType: NodeTypeEnum,
  label: z.string().nullable(),
  changeKind: changeKindEnum,
  /** When the node first entered memory (`nodes.createdAt`). */
  firstSeenAt: z.coerce.date(),
});
export type RecentChangeNode = z.infer<typeof recentChangeNodeSchema>;

export const recentChangeSourceSchema = z.object({
  sourceId: typeIdSchema("source"),
  /** Raw `sources.type` (e.g. `conversation`, `document`, `meeting_transcript`). */
  type: z.string(),
  /**
   * Best-effort display title from `sources.metadata` (`title`, falling back
   * to `filename`); `null` when none is available.
   */
  title: z.string().nullable(),
  /** Effective source date: `lastIngestedAt` falling back to `createdAt`. */
  timestamp: z.coerce.date(),
});
export type RecentChangeSource = z.infer<typeof recentChangeSourceSchema>;

export const queryRecentChangesResponseSchema = z.object({
  /** Active personal claims changed in the window, newest change first. */
  claims: z.array(recentChangeClaimSchema),
  /** Nodes added or updated in the window, newest change first. */
  nodes: z.array(recentChangeNodeSchema),
  /** Distinct sources behind the returned claims — for "N facts from <source>" grouping. */
  sources: z.array(recentChangeSourceSchema),
});

export type QueryRecentChangesRequest = z.infer<
  typeof queryRecentChangesRequestSchema
>;
export type QueryRecentChangesResponse = z.infer<
  typeof queryRecentChangesResponseSchema
>;
