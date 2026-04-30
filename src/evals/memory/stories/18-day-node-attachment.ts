/**
 * Story 18 — Day-node attachment regression for `createNode`.
 *
 * Pins the bug fixed in commit `0c41e7c`: manually-created nodes used to
 * skip the temporal-graph attachment that ingestion paths uphold via
 * `ensureSourceNode`. After the fix, every non-Temporal node created via
 * `createNode` must:
 *  - have exactly one `OCCURRED_ON` claim with `assertedByKind === "system"`
 *    where `subjectNodeId === newNodeId`,
 *  - the object node must be a `Temporal` node whose `metadata.label` is
 *    today's date in `yyyy-MM-dd` format,
 *  - the claim's `sourceId` must reference a `manual`-typed source.
 *
 * Negative regression: when `createNode` is invoked with `nodeType="Temporal"`
 * the function deliberately skips the day-node attachment to avoid a self-edge
 * / cycle. We assert no `OCCURRED_ON` claim is created for that path.
 *
 * Common aliases: createNode day-node, OCCURRED_ON regression, manual source
 * attach, temporal attach.
 */
import { ensureUser } from "../seed";
import type { EvalFixture } from "../types";
import { format } from "date-fns";
import { and, eq } from "drizzle-orm";
import {
  claims,
  nodeMetadata,
  nodes,
  sources,
} from "~/db/schema";
import { setSkipEmbeddingPersistence } from "~/utils/test-overrides";

export const story18DayNodeAttachment: EvalFixture = {
  name: "18-day-node-attachment",
  description:
    "createNode wires a non-Temporal node to today's day node via OCCURRED_ON sourced from the per-user manual source; Temporal nodes skip the self-attachment.",
  setup: async (ctx) => {
    await ensureUser(ctx);
  },
  steps: [],
  expectations: {
    custom: [
      {
        description:
          "createNode('Concept', 'foo') attaches exactly one OCCURRED_ON claim to today's Temporal node, sourced from a manual system source",
        run: async (ctx) => {
          // The harness already enables the embedding-skip seam globally, but
          // we set it again here defensively in case the order ever changes;
          // restore in the finally block.
          const previous = false;
          setSkipEmbeddingPersistence(true);
          try {
            const { createNode } = await import("~/lib/node");
            const created = await createNode(ctx.userId, "Concept", "foo");

            const today = format(new Date(), "yyyy-MM-dd");

            const occurredRows = await ctx.db
              .select({
                id: claims.id,
                subjectNodeId: claims.subjectNodeId,
                objectNodeId: claims.objectNodeId,
                assertedByKind: claims.assertedByKind,
                sourceId: claims.sourceId,
              })
              .from(claims)
              .where(
                and(
                  eq(claims.userId, ctx.userId),
                  eq(claims.predicate, "OCCURRED_ON"),
                  eq(claims.subjectNodeId, created.id),
                ),
              );
            if (occurredRows.length !== 1) {
              return {
                pass: false,
                message: `expected 1 OCCURRED_ON claim for new node, got ${occurredRows.length}`,
              };
            }
            const [row] = occurredRows;
            if (!row) {
              return { pass: false, message: "OCCURRED_ON row missing" };
            }
            if (row.assertedByKind !== "system") {
              return {
                pass: false,
                message: `OCCURRED_ON.assertedByKind=${row.assertedByKind}, expected system`,
              };
            }
            if (!row.objectNodeId) {
              return {
                pass: false,
                message: "OCCURRED_ON.objectNodeId is null; expected a Temporal node",
              };
            }

            const [dayNode] = await ctx.db
              .select({
                id: nodes.id,
                nodeType: nodes.nodeType,
                label: nodeMetadata.label,
              })
              .from(nodes)
              .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
              .where(eq(nodes.id, row.objectNodeId));
            if (!dayNode) {
              return {
                pass: false,
                message: "OCCURRED_ON object node missing from DB",
              };
            }
            if (dayNode.nodeType !== "Temporal") {
              return {
                pass: false,
                message: `day node nodeType=${dayNode.nodeType}, expected Temporal`,
              };
            }
            if (dayNode.label !== today) {
              return {
                pass: false,
                message: `day node label=${dayNode.label}, expected ${today}`,
              };
            }

            const [source] = await ctx.db
              .select({ id: sources.id, type: sources.type })
              .from(sources)
              .where(eq(sources.id, row.sourceId));
            if (!source) {
              return {
                pass: false,
                message: "OCCURRED_ON source missing",
              };
            }
            if (source.type !== "manual") {
              return {
                pass: false,
                message: `OCCURRED_ON source type=${source.type}, expected manual`,
              };
            }
            return { pass: true };
          } finally {
            setSkipEmbeddingPersistence(previous);
          }
        },
      },
      {
        description:
          "createNode('Temporal', '2026-04-30') does NOT create a self-OCCURRED_ON edge",
        run: async (ctx) => {
          setSkipEmbeddingPersistence(true);
          try {
            const { createNode } = await import("~/lib/node");
            // Use a non-today label so we can scope the assertion to this node
            // without colliding with the auto-created day node from the first
            // assertion.
            const created = await createNode(
              ctx.userId,
              "Temporal",
              "2026-01-01",
            );
            const rows = await ctx.db
              .select({ id: claims.id })
              .from(claims)
              .where(
                and(
                  eq(claims.userId, ctx.userId),
                  eq(claims.predicate, "OCCURRED_ON"),
                  eq(claims.subjectNodeId, created.id),
                ),
              );
            if (rows.length !== 0) {
              return {
                pass: false,
                message: `expected 0 OCCURRED_ON claims for Temporal node, got ${rows.length}`,
              };
            }
            return { pass: true };
          } finally {
            setSkipEmbeddingPersistence(false);
          }
        },
      },
    ],
  },
};
