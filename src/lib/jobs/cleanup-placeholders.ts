/**
 * Surface aged placeholder `Person` nodes (created from unresolved transcript
 * speakers) for cleanup-pipeline review. Without this job the graph fills
 * with `Speaker_3` placeholders ("speaker placeholder explosion" trap).
 *
 * The job is purely surfacing — no DB mutations. It feeds candidate
 * placeholder ids into the existing iterative cleanup pipeline (which
 * handles the actual merge/retract/contradict decisions via the LLM
 * operation vocabulary).
 *
 * Common aliases: cleanup placeholders, unresolved speaker sweep,
 * placeholder Person review, speaker placeholder explosion.
 */
import { batchQueue } from "../queues";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { nodes, nodeMetadata } from "~/db/schema";
import { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";
import { env } from "~/utils/env";

export const cleanupPlaceholdersInputSchema = z.object({
  userId: z.string().min(1),
  olderThanDays: z.number().int().positive().default(7),
  limit: z.number().int().positive().max(500).default(50),
});

export type CleanupPlaceholdersInput = z.input<
  typeof cleanupPlaceholdersInputSchema
>;
export type CleanupPlaceholdersInputResolved = z.infer<
  typeof cleanupPlaceholdersInputSchema
>;

export interface PlaceholderCandidate {
  id: TypeId<"node">;
  label: string;
  /**
   * Optional similarity score. The current implementation uses exact
   * canonical-label matching, so the score is always `1` when present. The
   * field is kept on the contract so embedding-similarity hits can be added
   * later without churning consumers.
   */
  score?: number;
}

export interface PlaceholderSurfaceRow {
  id: TypeId<"node">;
  label: string;
  candidates: PlaceholderCandidate[];
}

export interface CleanupPlaceholdersResult {
  placeholders: PlaceholderSurfaceRow[];
}

/**
 * Find placeholder Person nodes older than `olderThanDays` and pair each
 * with same-label, non-placeholder Person nodes that could be merge
 * targets.
 *
 * Read-only: callers decide what to do with the result. Use
 * {@link seedClaimsCleanupForPlaceholders} to feed the surfaced ids into
 * the iterative cleanup job.
 */
export async function cleanupPlaceholders(
  rawInput: CleanupPlaceholdersInput,
): Promise<CleanupPlaceholdersResult> {
  const { userId, olderThanDays, limit } =
    cleanupPlaceholdersInputSchema.parse(rawInput);

  const db = await useDatabase();

  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const placeholderRows = await db
    .select({
      id: nodes.id,
      label: nodeMetadata.label,
      canonicalLabel: nodeMetadata.canonicalLabel,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        eq(nodes.nodeType, "Person"),
        lt(nodes.createdAt, cutoff),
        sql`(${nodeMetadata.additionalData} ->> 'unresolvedSpeaker') = 'true'`,
      ),
    )
    .orderBy(nodes.createdAt)
    .limit(limit);

  if (placeholderRows.length === 0) {
    return { placeholders: [] };
  }

  // Look up same-canonical-label Person nodes that are NOT placeholders, in
  // a single batched query. Placeholder labels are usually low-cardinality
  // ("alex", "speaker_3"); a single `IN` query keeps this O(1) regardless of
  // the result size.
  const distinctCanonicalLabels = Array.from(
    new Set(
      placeholderRows
        .map((row) => row.canonicalLabel)
        .filter((label): label is string => !!label && label.trim() !== ""),
    ),
  );

  const placeholderIds = new Set(placeholderRows.map((row) => row.id));

  const candidateRows = distinctCanonicalLabels.length
    ? await db
        .select({
          id: nodes.id,
          label: nodeMetadata.label,
          canonicalLabel: nodeMetadata.canonicalLabel,
        })
        .from(nodes)
        .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
        .where(
          and(
            eq(nodes.userId, userId),
            eq(nodes.nodeType, "Person"),
            inArray(nodeMetadata.canonicalLabel, distinctCanonicalLabels),
            sql`(${nodeMetadata.additionalData} ->> 'unresolvedSpeaker') IS DISTINCT FROM 'true'`,
          ),
        )
    : [];

  // The non-placeholder filter above already excludes placeholders, but we
  // also defensively guard against a placeholder showing up in its own
  // candidate list via `placeholderIds`.
  const candidatesByCanonical = new Map<string, PlaceholderCandidate[]>();
  for (const row of candidateRows) {
    if (!row.canonicalLabel || placeholderIds.has(row.id)) continue;
    const list = candidatesByCanonical.get(row.canonicalLabel) ?? [];
    list.push({ id: row.id, label: row.label ?? "", score: 1 });
    candidatesByCanonical.set(row.canonicalLabel, list);
  }

  const placeholders: PlaceholderSurfaceRow[] = placeholderRows.map((row) => ({
    id: row.id,
    label: row.label ?? "",
    candidates: row.canonicalLabel
      ? (candidatesByCanonical.get(row.canonicalLabel) ?? [])
      : [],
  }));

  return { placeholders };
}

export interface SeedCleanupResult {
  jobId: string;
  seedIds: TypeId<"node">[];
}

/**
 * Enqueue an iterative cleanup job seeded with the placeholder ids. Returns
 * `null` when there are no placeholders to seed (no job is enqueued).
 *
 * Thin composition over {@link cleanupPlaceholders} + the existing
 * `cleanup-graph` BullMQ job. The cleanup pipeline already supports
 * `seedIds` per `CleanupGraphJobInputSchema`, so we don't introduce any new
 * scheduling primitives.
 */
export async function seedClaimsCleanupForPlaceholders(
  rawInput: CleanupPlaceholdersInput,
  result: CleanupPlaceholdersResult,
): Promise<SeedCleanupResult | null> {
  const { userId, olderThanDays } =
    cleanupPlaceholdersInputSchema.parse(rawInput);
  const seedIds = result.placeholders.map((p) => p.id);
  if (seedIds.length === 0) return null;

  const job = await batchQueue.add("cleanup-graph", {
    userId,
    // `since` bounds the entry-node fetch in the cleanup pipeline. We pass
    // an explicit window matching the placeholder age window so any
    // ambient seeds harvested by the pipeline come from the same era as
    // the placeholders.
    since: new Date(
      Date.now() - olderThanDays * 24 * 60 * 60 * 1000,
    ).toISOString(),
    seedIds,
    llmModelId: env.MODEL_ID_GRAPH_EXTRACTION,
  });

  return { jobId: job.id ?? "", seedIds };
}
