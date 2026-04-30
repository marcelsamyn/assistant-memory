/**
 * Atlas synthesis from claims (registry-driven).
 *
 * Pulls active personal-scope claims with `feedsAtlas = true` (per the
 * predicate policy registry) authored by `user` or `user_confirmed`, ranks
 * candidate subjects by centrality and time-in-effect, asks an LLM to
 * synthesise ~500 tokens of atlas prose, and concatenates the result with
 * `userProfiles.content` (manual pinned override) before persisting.
 *
 * Storage location: the per-user Atlas node's `nodeMetadata.description`
 * (same as the legacy job — readers like `getAtlas` and `cleanup-graph` are
 * unchanged). Idempotency hash lives on the same row's `additionalData`,
 * matching `profile-synthesis`.
 *
 * Common aliases: user atlas, atlas synthesis, atlas-user job.
 */
import { performStructuredAnalysis } from "../ai";
import { ensureAtlasNode } from "../atlas";
import { PREDICATE_POLICIES } from "../claims/predicate-policies";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DrizzleDB } from "~/db";
import { claims, nodeMetadata, userProfiles } from "~/db/schema";
import { logEvent } from "~/lib/observability/log";
import type { AssertedByKind, Predicate } from "~/types/graph";
import type { TypeId } from "~/types/typeid";

/** Trust filter for atlas inputs — matches design doc (`atlas` retrieval section). */
const ATLAS_TRUSTED_KINDS = ["user", "user_confirmed"] as const satisfies readonly AssertedByKind[];

/** Predicates whose active claims feed the atlas, per registry. */
const FEEDS_ATLAS_PREDICATES: readonly Predicate[] = Object.values(
  PREDICATE_POLICIES,
)
  .filter((policy) => policy.feedsAtlas)
  .map((policy) => policy.predicate);

/**
 * Ranking knobs. Subject centrality dominates for high-touch nodes; time decay
 * pushes long-stale claims down without flushing durable preferences. Tunable
 * here intentionally — these constants are the entire ranking surface.
 */
const TOP_N_CLAIMS = 40;
const MAX_CLAIMS_PER_SUBJECT = 5;
/** Days. Claims older than this contribute zero time-in-effect score. */
const TIME_IN_EFFECT_CLAMP_DAYS = 365;
/**
 * Per-day weight for time-in-effect. Total time score capped at
 * `TIME_IN_EFFECT_CLAMP_DAYS * TIME_IN_EFFECT_WEIGHT_PER_DAY` ≈ 3.65 — same
 * order of magnitude as `log(1 + 40)` ≈ 3.71, so a maximally-old claim and a
 * maximally-central subject contribute comparably.
 */
const TIME_IN_EFFECT_WEIGHT_PER_DAY = 0.01;

const AtlasOutputSchema = z
  .object({
    atlas: z
      .string()
      .min(1)
      .describe(
        "Concise User Atlas prose, ~500 tokens, synthesised only from supplied claims.",
      ),
  })
  .describe("AtlasUserOutput");

interface AtlasClaimRow {
  id: TypeId<"claim">;
  predicate: Predicate;
  statement: string;
  objectValue: string | null;
  statedAt: Date;
  subjectNodeId: TypeId<"node">;
  subjectLabel: string | null;
  assertedByKind: AssertedByKind;
}

interface RankedAtlasClaim extends AtlasClaimRow {
  centrality: number;
  ageDays: number;
  score: number;
}

interface AtlasInputs {
  pinned: string;
  rankedClaims: RankedAtlasClaim[];
  asOf: Date;
}

/**
 * Centrality = count of trusted active personal claims touching the subject
 * node, restricted to atlas-feeding predicates. Single GROUP BY, used as a
 * tunable signal in the rank formula below.
 */
async function fetchCentralityCounts(
  db: DrizzleDB,
  userId: string,
): Promise<Map<TypeId<"node">, number>> {
  const rows = await db
    .select({
      subjectNodeId: claims.subjectNodeId,
      count: sql<number>`count(*)::int`,
    })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.scope, "personal"),
        eq(claims.status, "active"),
        inArray(claims.assertedByKind, [...ATLAS_TRUSTED_KINDS]),
        inArray(claims.predicate, [...FEEDS_ATLAS_PREDICATES]),
      ),
    )
    .groupBy(claims.subjectNodeId);

  return new Map(rows.map((row) => [row.subjectNodeId, row.count]));
}

async function fetchAtlasCandidateClaims(
  db: DrizzleDB,
  userId: string,
): Promise<AtlasClaimRow[]> {
  return db
    .select({
      id: claims.id,
      predicate: claims.predicate,
      statement: claims.statement,
      objectValue: claims.objectValue,
      statedAt: claims.statedAt,
      subjectNodeId: claims.subjectNodeId,
      subjectLabel: nodeMetadata.label,
      assertedByKind: claims.assertedByKind,
    })
    .from(claims)
    .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, claims.subjectNodeId))
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.scope, "personal"),
        eq(claims.status, "active"),
        inArray(claims.assertedByKind, [...ATLAS_TRUSTED_KINDS]),
        inArray(claims.predicate, [...FEEDS_ATLAS_PREDICATES]),
      ),
    )
    .orderBy(desc(claims.statedAt));
}

/**
 * Rank by `log(1 + centrality) + clamped(timeInEffectDays) * weight`, then
 * cap at `MAX_CLAIMS_PER_SUBJECT` per subject and `TOP_N_CLAIMS` overall.
 *
 * Centrality is uniform per subject so all of a busy node's claims tie on
 * that component; the per-claim time score breaks ties so the most durable
 * facts win the per-subject cap.
 */
export function rankAtlasClaims(
  candidates: AtlasClaimRow[],
  centralityBySubject: ReadonlyMap<TypeId<"node">, number>,
  asOf: Date,
): RankedAtlasClaim[] {
  const scored: RankedAtlasClaim[] = candidates.map((claim) => {
    const centrality = centralityBySubject.get(claim.subjectNodeId) ?? 0;
    const rawAgeDays =
      (asOf.getTime() - claim.statedAt.getTime()) / (1000 * 60 * 60 * 24);
    const ageDays = Math.max(
      0,
      Math.min(TIME_IN_EFFECT_CLAMP_DAYS, rawAgeDays),
    );
    const score =
      Math.log(1 + centrality) + ageDays * TIME_IN_EFFECT_WEIGHT_PER_DAY;
    return { ...claim, centrality, ageDays, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tiebreaker by claim id keeps ordering stable across runs.
    return a.id.localeCompare(b.id);
  });

  const perSubjectCount = new Map<TypeId<"node">, number>();
  const capped: RankedAtlasClaim[] = [];
  for (const claim of scored) {
    if (capped.length >= TOP_N_CLAIMS) break;
    const used = perSubjectCount.get(claim.subjectNodeId) ?? 0;
    if (used >= MAX_CLAIMS_PER_SUBJECT) continue;
    perSubjectCount.set(claim.subjectNodeId, used + 1);
    capped.push(claim);
  }
  return capped;
}

async function fetchPinnedContent(
  db: DrizzleDB,
  userId: string,
): Promise<string> {
  const [row] = await db
    .select({ content: userProfiles.content })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return row?.content?.trim() ?? "";
}

/** Render the rank-ordered claim set into the prompt input block. */
export function renderAtlasClaimsBlock(
  rankedClaims: readonly RankedAtlasClaim[],
): string {
  if (rankedClaims.length === 0) return "(no trusted personal claims yet)";
  return rankedClaims
    .map((claim) => {
      const subject = claim.subjectLabel ?? "(unlabeled)";
      const value =
        claim.objectValue !== null && claim.objectValue.length > 0
          ? `=${claim.objectValue}`
          : "";
      return `- [${claim.predicate}${value}] subject="${subject}" centrality=${claim.centrality.toString()} age_days=${Math.round(claim.ageDays).toString()} :: ${claim.statement}`;
    })
    .join("\n");
}

/** Build the LLM prompt that asks for ~500 tokens of atlas prose. */
export function buildAtlasPrompt(inputs: AtlasInputs): string {
  const dateLine = inputs.asOf.toISOString().slice(0, 10);
  const claimsBlock = renderAtlasClaimsBlock(inputs.rankedClaims);
  const pinnedBlock = inputs.pinned
    ? inputs.pinned
    : "(no pinned content)";

  return `You are synthesising the User Atlas — a compact, durable portrait of who the user is and what is currently true for them, to be loaded as context for every assistant interaction.

Today is ${dateLine}.

The Atlas has two complementary purposes:
1. Long-term identity: stable values, communication preferences, recurring interests, durable goals.
2. Current state: active goals, ongoing statuses, in-flight commitments.

You are given:
- A manual pinned section the user has authored (treat as ground truth; do not paraphrase or restate it).
- A ranked list of supporting claims drawn from the knowledge graph. Each claim is filtered to personal scope and authored by the user (or explicitly confirmed by them). Higher centrality = the subject node has more trusted claims; higher age_days = the claim has been in effect longer.

Pinned content (do not duplicate into your output — it is already shown alongside your output):
"""
${pinnedBlock}
"""

Supporting claims (rank-ordered, capped at ${TOP_N_CLAIMS.toString()}):
${claimsBlock}

Rules:
1. Use ONLY the supplied claims as evidence. Do not invent facts.
2. Output ~500 tokens of natural prose. No headings, no bullet lists, no markdown, no commentary.
3. Prefer durable, identity-level synthesis over restating individual claims.
4. Aggressively prune anything that duplicates the pinned section.
5. If the supplied evidence is too thin to be useful, return a single short sentence stating only what is genuinely known.
6. Do NOT mention claim ids, source ids, predicates, dates, ages, centrality, asserted_by tags, or this prompt.

Return JSON matching the schema { atlas: string }.`;
}

/**
 * Compose final stored content. Pinned section stays on top so manual
 * overrides are never displaced; derived atlas below. Sections omitted when
 * empty. Format matches what `getAtlas` already returns to consumers — they
 * read a single `description` string and treat it as opaque prose.
 */
export function composeAtlasContent(
  pinned: string,
  derived: string,
): string {
  const trimmedPinned = pinned.trim();
  const trimmedDerived = derived.trim();
  const sections: string[] = [];
  if (trimmedPinned.length > 0) {
    sections.push(`# Pinned\n${trimmedPinned}`);
  }
  if (trimmedDerived.length > 0) {
    sections.push(`# Derived\n${trimmedDerived}`);
  }
  return sections.join("\n\n");
}

const ATLAS_HASH_KEY = "atlasUserHash";

const AtlasAdditionalDataSchema = z
  .object({
    [ATLAS_HASH_KEY]: z.string().optional(),
  })
  .passthrough();

function readPriorAtlasHash(additionalData: unknown): string | undefined {
  const parsed = AtlasAdditionalDataSchema.safeParse(additionalData);
  if (!parsed.success) return undefined;
  return parsed.data[ATLAS_HASH_KEY];
}

function mergeAtlasAdditionalData(
  additionalData: unknown,
  hash: string,
): Record<string, unknown> {
  const parsed = AtlasAdditionalDataSchema.safeParse(additionalData);
  const base = parsed.success ? parsed.data : {};
  return { ...base, [ATLAS_HASH_KEY]: hash };
}

/**
 * Stable fingerprint of everything that would change atlas output. Excludes
 * timestamps (`statedAt`, `asOf`) and claim ids — they churn on re-ingestion
 * of the same fact and would defeat the cache. Includes the predicate +
 * object_value + subject + provenance kind tuple plus pinned content.
 */
function computeAtlasHash(inputs: AtlasInputs): string {
  const claimTuples = inputs.rankedClaims
    .map((claim) => ({
      predicate: claim.predicate,
      objectValue: claim.objectValue,
      subjectNodeId: claim.subjectNodeId,
      subjectLabel: claim.subjectLabel,
      assertedByKind: claim.assertedByKind,
      statement: claim.statement,
    }))
    .sort((a, b) =>
      `${a.predicate}|${a.objectValue ?? ""}|${a.subjectNodeId}|${a.assertedByKind}|${a.statement}`.localeCompare(
        `${b.predicate}|${b.objectValue ?? ""}|${b.subjectNodeId}|${b.assertedByKind}|${b.statement}`,
      ),
    );
  const canonical = {
    pinned: inputs.pinned,
    claims: claimTuples,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export type AtlasJobStatus =
  | "skipped_cache_hit"
  | "skipped_no_inputs"
  | "synthesised";

export interface AtlasJobResult {
  status: AtlasJobStatus;
  hash?: string;
  content?: string;
}

/**
 * Run atlas synthesis for a user. Idempotent via input content hash stored
 * on the Atlas node's metadata.
 */
export async function processAtlasJob(
  db: DrizzleDB,
  userId: string,
): Promise<AtlasJobResult> {
  const asOf = new Date();

  const [centralityBySubject, candidates, pinned] = await Promise.all([
    fetchCentralityCounts(db, userId),
    fetchAtlasCandidateClaims(db, userId),
    fetchPinnedContent(db, userId),
  ]);

  const rankedClaims = rankAtlasClaims(candidates, centralityBySubject, asOf);

  // Nothing to synthesise — but we still want pinned content surfaced if it
  // exists, so write through and exit without an LLM call.
  if (rankedClaims.length === 0 && pinned.length === 0) {
    return { status: "skipped_no_inputs" };
  }

  const inputs: AtlasInputs = { pinned, rankedClaims, asOf };
  const hash = computeAtlasHash(inputs);

  const atlasNodeId = await ensureAtlasNode(db, userId);

  const [metaRow] = await db
    .select({ additionalData: nodeMetadata.additionalData })
    .from(nodeMetadata)
    .where(eq(nodeMetadata.nodeId, atlasNodeId))
    .limit(1);

  const priorHash = readPriorAtlasHash(metaRow?.additionalData);
  if (priorHash === hash) {
    return { status: "skipped_cache_hit", hash };
  }

  let derivedAtlas = "";
  if (rankedClaims.length > 0) {
    const prompt = buildAtlasPrompt(inputs);
    const parsed = await performStructuredAnalysis({
      userId,
      prompt,
      schema: AtlasOutputSchema,
    });
    derivedAtlas = z.string().parse(parsed["atlas"]).trim();
  }

  const content = composeAtlasContent(pinned, derivedAtlas);

  await db
    .update(nodeMetadata)
    .set({
      description: content,
      additionalData: mergeAtlasAdditionalData(
        metaRow?.additionalData,
        hash,
      ),
    })
    .where(eq(nodeMetadata.nodeId, atlasNodeId));

  logEvent("atlas.derived", {
    userId,
    inputClaimCount: rankedClaims.length,
    outputTokenCount: content.length,
    hash,
  });

  return { status: "synthesised", hash, content };
}
