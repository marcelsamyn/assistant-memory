/**
 * Profile synthesis job: rewrite a durable, fact-first description for a node
 * from its supporting claims. Inputs are filtered to the trustworthy
 * provenance kinds (user / user_confirmed / system) and personal scope only.
 *
 * Idempotent via an input content hash stored on `nodeMetadata.additionalData`.
 *
 * Common aliases: profile synthesis, durable profile, node description rewrite.
 */
import { performStructuredAnalysis } from "../ai";
import { listAliasesForNodeIds } from "../alias";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DrizzleDB } from "~/db";
import {
  claims,
  nodeMetadata,
  nodes,
  sourceLinks,
  sources,
} from "~/db/schema";
import {
  AttributePredicateEnum,
  type AssertedByKind,
  type Predicate,
} from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

export interface ProfileSynthesisJobInput {
  userId: string;
  nodeId: TypeId<"node">;
}

export const ProfileSynthesisJobInputSchema = z.object({
  userId: z.string().min(1),
  nodeId: z.string().min(1),
});

const TRUSTED_PROFILE_KINDS = ["user", "user_confirmed", "system"] as const satisfies readonly AssertedByKind[];

const ATTRIBUTE_PREDICATES: ReadonlySet<Predicate> = new Set(
  AttributePredicateEnum.options,
);

const ATTRIBUTE_PREDICATE_LIST: readonly Predicate[] = [
  ...AttributePredicateEnum.options,
];

/** Cap on how many relationship claims we feed the synthesis prompt. */
const RELATIONSHIP_CLAIM_LIMIT = 30;

/** Cap on the rendered description so we don't grow node metadata unboundedly. */
const MAX_DESCRIPTION_CHARS = 1200;

const ProfileSynthesisOutputSchema = z
  .object({
    description: z
      .string()
      .min(1)
      .max(MAX_DESCRIPTION_CHARS)
      .describe(
        "Durable, fact-first profile description for this node. No invented facts.",
      ),
  })
  .describe("ProfileSynthesisOutput");

interface AttributeClaimRow {
  id: TypeId<"claim">;
  predicate: Predicate;
  objectValue: string | null;
  statement: string;
  status: string;
  statedAt: Date;
  assertedByKind: AssertedByKind;
}

interface RelationshipClaimRow {
  id: TypeId<"claim">;
  predicate: Predicate;
  statement: string;
  status: string;
  statedAt: Date;
  assertedByKind: AssertedByKind;
  objectLabel: string | null;
}

interface NodeProfileInputs {
  label: string | null;
  nodeType: string;
  priorDescription: string | null;
  aliases: string[];
  attributeClaims: AttributeClaimRow[];
  relationshipClaims: RelationshipClaimRow[];
}

/** Build the prompt that asks the LLM to rewrite the node description. */
export function buildProfileSynthesisPrompt(
  inputs: NodeProfileInputs,
): string {
  const aliasesLine =
    inputs.aliases.length === 0
      ? "(none)"
      : inputs.aliases.map((alias) => `"${alias}"`).join(", ");

  const attributeLines =
    inputs.attributeClaims.length === 0
      ? "(none)"
      : inputs.attributeClaims
          .map((claim) => {
            const value = claim.objectValue ?? "";
            return `- [${claim.predicate}=${value}] ${claim.statement} (asserted_by=${claim.assertedByKind})`;
          })
          .join("\n");

  const relationshipLines =
    inputs.relationshipClaims.length === 0
      ? "(none)"
      : inputs.relationshipClaims
          .map((claim) => {
            const target = claim.objectLabel ?? "?";
            return `- [${claim.predicate} -> ${target}] ${claim.statement} (asserted_by=${claim.assertedByKind})`;
          })
          .join("\n");

  return `You are rewriting the durable description of a single node in a personal knowledge graph.

The description is read-only context: a compact, factual summary of who/what this node is, drawn ONLY from supplied evidence. It must not invent facts, and it must not narrate recent events or the source of the evidence.

Node:
- type: ${inputs.nodeType}
- label: ${inputs.label ?? "(unlabeled)"}
- aliases: ${aliasesLine}

Prior description (may be empty or stale; rewrite, do not append):
${inputs.priorDescription ? inputs.priorDescription : "(none)"}

Supporting attribute claims (single source of truth for current facts about this node):
${attributeLines}

Supporting relationship claims (top ${RELATIONSHIP_CLAIM_LIMIT.toString()} by recency):
${relationshipLines}

Rules:
1. Use ONLY the supplied claims and aliases as evidence. Do not invent any facts not grounded in them.
2. Prefer durable, identity-level facts (who/what they are, stable preferences, goals, ongoing roles). Skip transient episode details.
3. Do not list claim IDs, source IDs, predicates, dates, or asserted_by tags in the output. Phrase as natural prose.
4. If the supplied evidence is too thin to write a useful description, return a single short sentence stating only what is known (e.g., the label and type).
5. Keep the description under ${MAX_DESCRIPTION_CHARS.toString()} characters. Plain text. No headings, no bullet lists, no markdown.
6. Do not refer to "the user" in third person if this node IS the user — write naturally about the entity the node represents.

Return JSON matching the schema { description: string }.`;
}

/**
 * Compute a stable hash over all inputs that would change the synthesis output.
 *
 * NOTE: the prior description is intentionally excluded — it's an output of a
 * previous synthesis run, so including it would prevent cache hits on
 * unchanged claim sets (every successful run would rewrite the description,
 * which would change the next hash, defeating idempotence).
 */
function computeProfileHash(inputs: NodeProfileInputs): string {
  const canonical = {
    label: inputs.label,
    nodeType: inputs.nodeType,
    aliases: inputs.aliases,
    attributeClaims: inputs.attributeClaims.map((claim) => ({
      id: claim.id,
      status: claim.status,
      predicate: claim.predicate,
      objectValue: claim.objectValue,
      statement: claim.statement,
      statedAt: claim.statedAt.toISOString(),
      assertedByKind: claim.assertedByKind,
    })),
    relationshipClaims: inputs.relationshipClaims.map((claim) => ({
      id: claim.id,
      status: claim.status,
      predicate: claim.predicate,
      statement: claim.statement,
      objectLabel: claim.objectLabel,
      statedAt: claim.statedAt.toISOString(),
      assertedByKind: claim.assertedByKind,
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const PROFILE_HASH_KEY = "profileSynthesisHash";

const NodeAdditionalDataSchema = z
  .object({
    [PROFILE_HASH_KEY]: z.string().optional(),
  })
  .passthrough();

function readPriorHash(additionalData: unknown): string | undefined {
  const parsed = NodeAdditionalDataSchema.safeParse(additionalData);
  if (!parsed.success) return undefined;
  return parsed.data[PROFILE_HASH_KEY];
}

function mergeAdditionalData(
  additionalData: unknown,
  hash: string,
): Record<string, unknown> {
  const parsed = NodeAdditionalDataSchema.safeParse(additionalData);
  const base = parsed.success ? parsed.data : {};
  return { ...base, [PROFILE_HASH_KEY]: hash };
}

/**
 * Returns true iff the node has at least one personal-scope source link or
 * personal-scope active claim touching it. Mirrors `nodeHasScopeSupport` in
 * `src/lib/graph.ts` but expressed at the row level for a single node.
 */
async function hasPersonalScopeSupport(
  db: DrizzleDB,
  userId: string,
  nodeId: TypeId<"node">,
): Promise<boolean> {
  const personalSourceLink = db
    .select({ one: sql<number>`1` })
    .from(sourceLinks)
    .innerJoin(sources, eq(sources.id, sourceLinks.sourceId))
    .where(
      and(
        eq(sourceLinks.nodeId, nodeId),
        eq(sources.userId, userId),
        eq(sources.scope, "personal"),
      ),
    );

  const personalClaim = db
    .select({ one: sql<number>`1` })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.scope, "personal"),
        eq(claims.status, "active"),
        or(
          eq(claims.subjectNodeId, nodeId),
          eq(claims.objectNodeId, nodeId),
        ),
      ),
    );

  const [row] = await db
    .select({
      supported: sql<boolean>`(${exists(personalSourceLink)} OR ${exists(personalClaim)})`,
    })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .limit(1);

  return row?.supported === true;
}

async function fetchNodeProfileInputs(
  db: DrizzleDB,
  userId: string,
  nodeId: TypeId<"node">,
): Promise<{
  inputs: NodeProfileInputs;
  nodeType: string;
  priorAdditionalData: unknown;
} | null> {
  const [nodeRow] = await db
    .select({
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      priorDescription: nodeMetadata.description,
      additionalData: nodeMetadata.additionalData,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .limit(1);

  if (!nodeRow) return null;

  const attributeClaimRows: AttributeClaimRow[] = await db
    .select({
      id: claims.id,
      predicate: claims.predicate,
      objectValue: claims.objectValue,
      statement: claims.statement,
      status: claims.status,
      statedAt: claims.statedAt,
      assertedByKind: claims.assertedByKind,
    })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.subjectNodeId, nodeId),
        eq(claims.status, "active"),
        eq(claims.scope, "personal"),
        inArray(claims.assertedByKind, [...TRUSTED_PROFILE_KINDS]),
        inArray(claims.predicate, [...ATTRIBUTE_PREDICATE_LIST]),
      ),
    )
    .orderBy(asc(claims.statedAt), asc(claims.id));

  const relationshipClaimRows: RelationshipClaimRow[] = await db
    .select({
      id: claims.id,
      predicate: claims.predicate,
      statement: claims.statement,
      status: claims.status,
      statedAt: claims.statedAt,
      assertedByKind: claims.assertedByKind,
      objectLabel: nodeMetadata.label,
    })
    .from(claims)
    .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, claims.objectNodeId))
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.subjectNodeId, nodeId),
        eq(claims.status, "active"),
        eq(claims.scope, "personal"),
        inArray(claims.assertedByKind, [...TRUSTED_PROFILE_KINDS]),
        isNotNull(claims.objectNodeId),
        sql`${claims.predicate} NOT IN ${[...ATTRIBUTE_PREDICATES]}`,
      ),
    )
    .orderBy(desc(claims.statedAt), asc(claims.id))
    .limit(RELATIONSHIP_CLAIM_LIMIT);

  const aliasMap = await listAliasesForNodeIds(db, userId, [nodeId]);
  const aliasRows = aliasMap.get(nodeId) ?? [];
  const aliasTexts = aliasRows.map((row) => row.aliasText);

  return {
    nodeType: nodeRow.nodeType,
    priorAdditionalData: nodeRow.additionalData,
    inputs: {
      label: nodeRow.label,
      nodeType: nodeRow.nodeType,
      priorDescription: nodeRow.priorDescription,
      aliases: aliasTexts,
      attributeClaims: attributeClaimRows,
      relationshipClaims: relationshipClaimRows,
    },
  };
}

export type ProfileSynthesisStatus =
  | "skipped_node_missing"
  | "skipped_reference_only"
  | "skipped_cache_hit"
  | "synthesized";

export interface ProfileSynthesisResult {
  status: ProfileSynthesisStatus;
  hash?: string;
  description?: string;
}

/**
 * Run profile synthesis for a single node. Idempotent via input content hash.
 *
 * - Skips nodes with no personal-scope support (reference-only nodes).
 * - Skips when the input hash matches a previously stored synthesis hash.
 * - Otherwise calls the LLM, persists the description, and stores the hash.
 */
export async function runProfileSynthesis(
  input: ProfileSynthesisJobInput,
): Promise<ProfileSynthesisResult> {
  const { userId, nodeId } = input;
  const db = await useDatabase();

  const supported = await hasPersonalScopeSupport(db, userId, nodeId);
  if (!supported) {
    return { status: "skipped_reference_only" };
  }

  const fetched = await fetchNodeProfileInputs(db, userId, nodeId);
  if (!fetched) {
    return { status: "skipped_node_missing" };
  }

  const hash = computeProfileHash(fetched.inputs);
  const priorHash = readPriorHash(fetched.priorAdditionalData);
  if (priorHash === hash) {
    return { status: "skipped_cache_hit", hash };
  }

  const prompt = buildProfileSynthesisPrompt(fetched.inputs);
  const parsed = await performStructuredAnalysis({
    userId,
    prompt,
    schema: ProfileSynthesisOutputSchema,
  });

  const description = z.string().parse(parsed["description"]).trim();

  await db
    .update(nodeMetadata)
    .set({
      description,
      additionalData: mergeAdditionalData(fetched.priorAdditionalData, hash),
    })
    .where(eq(nodeMetadata.nodeId, nodeId));

  return { status: "synthesized", hash, description };
}
