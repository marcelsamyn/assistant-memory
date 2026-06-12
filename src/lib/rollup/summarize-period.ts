/**
 * Summarize a single rollup period: deterministic input collection →
 * idempotent PART_OF containment claims (before the fingerprint gate, so
 * re-runs repair interrupted sweeps) → fingerprint gate → one structured
 * LLM completion → embedding generation → atomic write of the summary to
 * `nodeMetadata.description` (+ `additionalData.rollup` marker) and the
 * refreshed embedding.
 */
import {
  collectPeriodInput,
  fingerprintOf,
  readRollupMeta,
} from "./collect";
import { periodLevelOf, type PeriodLevel } from "./period";
import { and, eq, inArray } from "drizzle-orm";
import type OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import { z } from "zod";
import type { DrizzleDB } from "~/db";
import { claims, nodeEmbeddings, nodeMetadata } from "~/db/schema";
import { parseStructuredCompletion } from "~/lib/ai";
import { generateEmbeddings } from "~/lib/embeddings";
import { ensurePeriodNode } from "~/lib/temporal";
import type { TypeId } from "~/types/typeid";
import { MODEL_MAX_OUTPUT_TOKENS, modelForTask } from "~/utils/models";
import { shouldSkipEmbeddingPersistence } from "~/utils/test-overrides";

const LEVEL_PROMPT_INTRO: Record<PeriodLevel, string> = {
  day: `You are summarizing one day of a person's life from entries in their personal memory graph (conversations, documents, events).

Write a concise narrative summary of the day. Be concrete and specific: name the people, projects, places, decisions, and outcomes involved. Use past tense. Skip meta-commentary and filler; if entries are sparse, keep the summary proportionally short.`,
  week: `You are summarizing one week of a person's life from their daily summaries.

Write a narrative summary of the week's arc: key events, recurring themes, progress on projects, notable people, decisions, and changes. Synthesize across days rather than listing day-by-day. Use past tense; be concrete and specific. Days marked "(no summarized activity)" simply have no recorded data — don't speculate about them.`,
  month: `You are summarizing one month of a person's life from weekly summaries. Boundary weeks may only partially overlap the month — weigh only the overlapping days.

Write a narrative summary of the month: dominant themes, milestones, project progress, important relationships, and notable shifts. Use past tense; be concrete and specific.`,
  year: `You are summarizing one year of a person's life from monthly summaries.

Write a narrative summary of the year: major arcs, milestones, turning points, recurring themes, and how things changed from beginning to end. Use past tense; be concrete and specific.`,
};

const periodSummarySchema = z.object({
  summary: z
    .string()
    .describe(
      "Narrative summary of the period; concrete, specific, past tense",
    ),
});

export type SummarizePeriodOutcome =
  | "summarized"
  | "skipped-unchanged"
  | "skipped-empty";

export interface SummarizePeriodParams {
  db: DrizzleDB;
  userId: string;
  periodKey: string;
  /** Completion client created once per sweep (task: temporal_summary). */
  client: OpenAI;
  /** Per-user synthetic rollup source backing PART_OF claims. */
  rollupSourceId: TypeId<"source">;
}

export async function summarizePeriod({
  db,
  userId,
  periodKey,
  client,
  rollupSourceId,
}: SummarizePeriodParams): Promise<SummarizePeriodOutcome> {
  const level = periodLevelOf(periodKey);

  const collected = await collectPeriodInput(db, userId, periodKey, level);
  if (!collected) return "skipped-empty";

  const nodeId = await ensurePeriodNode(db, userId, periodKey);

  // Containment edges first (and on every run) so a previously interrupted
  // run is repaired even when the summary itself fingerprint-skips.
  await ensurePartOfClaims(
    db,
    userId,
    collected.childNodeIds,
    nodeId,
    periodKey,
    rollupSourceId,
  );

  const fingerprint = fingerprintOf(collected.inputText);
  const [meta] = await db
    .select({
      description: nodeMetadata.description,
      additionalData: nodeMetadata.additionalData,
    })
    .from(nodeMetadata)
    .where(eq(nodeMetadata.nodeId, nodeId))
    .limit(1);
  if (!meta) {
    throw new Error(`Period node ${periodKey} (${nodeId}) has no metadata row`);
  }
  if (readRollupMeta(meta.additionalData)?.fingerprint === fingerprint) {
    return "skipped-unchanged";
  }

  const completion = await parseStructuredCompletion(
    client,
    {
      messages: [
        {
          role: "user",
          content: `${LEVEL_PROMPT_INTRO[level]}\n\n${collected.inputText}`,
        },
      ],
      model: modelForTask("temporal_summary"),
      max_tokens: MODEL_MAX_OUTPUT_TOKENS,
      response_format: zodResponseFormat(periodSummarySchema, "period_summary"),
    },
    { task: "temporal_summary", userId },
  );
  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) {
    throw new Error(`Failed to parse period summary for ${periodKey}`);
  }

  // Generate the embedding BEFORE any write: committing the fingerprint
  // first would make a retry after an embedding failure fingerprint-skip,
  // leaving the embedding stale forever.
  let embedding: number[] | null = null;
  if (!shouldSkipEmbeddingPersistence()) {
    const embResponse = await generateEmbeddings({
      model: "jina-embeddings-v3",
      task: "retrieval.passage",
      input: [`${periodKey}: ${parsed.summary}`],
      truncate: true,
    });
    embedding = embResponse.data[0]?.embedding ?? null;
    if (!embedding) {
      throw new Error(`Failed to generate embedding for period ${periodKey}`);
    }
  }

  const existingData =
    meta.additionalData &&
    typeof meta.additionalData === "object" &&
    !Array.isArray(meta.additionalData)
      ? (meta.additionalData as Record<string, unknown>)
      : {};
  await db.transaction(async (tx) => {
    await tx
      .update(nodeMetadata)
      .set({
        description: parsed.summary,
        additionalData: {
          ...existingData,
          rollup: { fingerprint, summarizedAt: new Date().toISOString() },
        },
      })
      .where(eq(nodeMetadata.nodeId, nodeId));
    if (embedding) {
      await tx
        .delete(nodeEmbeddings)
        .where(eq(nodeEmbeddings.nodeId, nodeId));
      await tx.insert(nodeEmbeddings).values({
        nodeId,
        embedding,
        modelName: "jina-embeddings-v3",
      });
    }
  });

  return "summarized";
}

/** Child PART_OF parent claims for every existing child node, idempotent. */
async function ensurePartOfClaims(
  db: DrizzleDB,
  userId: string,
  childNodeIds: TypeId<"node">[],
  parentNodeId: TypeId<"node">,
  parentKey: string,
  rollupSourceId: TypeId<"source">,
): Promise<void> {
  if (childNodeIds.length === 0) return;

  const existing = await db
    .select({ subjectNodeId: claims.subjectNodeId })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.objectNodeId, parentNodeId),
        eq(claims.predicate, "PART_OF"),
        eq(claims.status, "active"),
        inArray(claims.subjectNodeId, childNodeIds),
      ),
    );
  const linked = new Set(existing.map((c) => c.subjectNodeId));
  const missing = childNodeIds.filter((id) => !linked.has(id));
  if (missing.length === 0) return;

  const labels = await db
    .select({ nodeId: nodeMetadata.nodeId, label: nodeMetadata.label })
    .from(nodeMetadata)
    .where(inArray(nodeMetadata.nodeId, missing));
  const labelOf = new Map(labels.map((l) => [l.nodeId, l.label]));

  await db.insert(claims).values(
    missing.map((childNodeId) => ({
      userId,
      predicate: "PART_OF" as const,
      subjectNodeId: childNodeId,
      objectNodeId: parentNodeId,
      statement: `${labelOf.get(childNodeId) ?? childNodeId} is part of ${parentKey}`,
      sourceId: rollupSourceId,
      scope: "personal" as const,
      assertedByKind: "system" as const,
      statedAt: new Date(),
      status: "active" as const,
    })),
  );
}
