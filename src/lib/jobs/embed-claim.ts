/**
 * Batch-worker job that writes the search embedding for one manually written
 * claim. The embedding API is an external call, so claim writes queue this job
 * instead of waiting for it inside the request.
 *
 * Common aliases: claim embedding job, deferred claim embedding, embed-claim.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DrizzleDB } from "~/db";
import { claimEmbeddings, claims } from "~/db/schema";
import { generateEmbeddings } from "~/lib/embeddings";
import { typeIdSchema } from "~/types/typeid";

export const EMBED_CLAIM_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

export const EmbedClaimJobInputSchema = z.object({
  userId: z.string().min(1),
  claimId: typeIdSchema("claim"),
  /** `claimEmbeddingText` of the claim as it was written. */
  text: z.string().min(1),
});
export type EmbedClaimJobInput = z.infer<typeof EmbedClaimJobInputSchema>;

/** One embedding per claim: a deleted or already-embedded claim is a no-op. */
export async function embedClaim(
  db: DrizzleDB,
  { userId, claimId, text }: EmbedClaimJobInput,
): Promise<void> {
  const [claim] = await db
    .select({ embeddingId: claimEmbeddings.id })
    .from(claims)
    .leftJoin(claimEmbeddings, eq(claimEmbeddings.claimId, claims.id))
    .where(and(eq(claims.id, claimId), eq(claims.userId, userId)))
    .limit(1);
  if (!claim || claim.embeddingId !== null) return;

  const response = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.passage",
    input: [text],
    truncate: true,
  });
  const embedding = response.data[0]?.embedding;
  if (!embedding) return;

  // `claim_id` has no unique constraint, and BullMQ can run a stalled job
  // twice. The lock keeps the second run from adding a duplicate row.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`embed-claim:${claimId}`}))`,
    );
    const [existing] = await tx
      .select({ id: claimEmbeddings.id })
      .from(claimEmbeddings)
      .where(eq(claimEmbeddings.claimId, claimId))
      .limit(1);
    if (existing) return;
    await tx.insert(claimEmbeddings).values({
      claimId,
      embedding,
      modelName: "jina-embeddings-v3",
    });
  });
}
