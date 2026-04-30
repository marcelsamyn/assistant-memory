/**
 * Speaker resolution for transcript ingestion.
 *
 * Maps each raw speaker label (as emitted by the segmenter) to a Person
 * nodeId, in the following priority order:
 *   1. user-self (case-insensitive match against `userSelfAliases`)
 *   2. caller-supplied `knownParticipants` (validated to belong to the user)
 *   3. existing alias on a Person-typed node
 *   4. placeholder Person node (created lazily, alias written for next time)
 *
 * Common aliases: speaker map, speaker resolution, transcript participant
 * mapping, user-self detection, placeholder Person.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import {
  aliases,
  nodeMetadata,
  nodes,
  type NodeSelect,
} from "~/db/schema";
import { createAlias, normalizeAliasText } from "~/lib/alias";
import { normalizeLabel } from "~/lib/label";
import { getEffectiveNodeScopes } from "~/lib/node-scope";
import type { TypeId } from "~/types/typeid";

export type SpeakerResolution =
  | "user_self"
  | "known_participant"
  | "alias"
  | "placeholder";

export interface ResolvedSpeaker {
  nodeId: TypeId<"node">;
  isUserSelf: boolean;
  resolution: SpeakerResolution;
}

export interface KnownParticipant {
  label: string;
  nodeId: TypeId<"node">;
}

export interface ResolveSpeakersInput {
  db: DrizzleDB;
  userId: string;
  speakerLabels: string[];
  userSelfAliases: string[];
  knownParticipants?: KnownParticipant[];
}

export type SpeakerMap = Map<string, ResolvedSpeaker>;

/**
 * Resolve a list of raw speaker labels to a `SpeakerMap`. Idempotent across
 * runs: re-resolving the same labels for the same user yields the same node
 * ids (placeholder Person nodes are reused via alias lookup once written).
 */
export async function resolveSpeakers({
  db,
  userId,
  speakerLabels,
  userSelfAliases,
  knownParticipants = [],
}: ResolveSpeakersInput): Promise<SpeakerMap> {
  const map: SpeakerMap = new Map();
  const uniqueLabels = [...new Set(speakerLabels.map((label) => label.trim()))]
    .filter((label) => label.length > 0);

  if (uniqueLabels.length === 0) return map;

  const userSelfNormalized = new Set(
    userSelfAliases.map((alias) => normalizeAliasText(alias)).filter((s) => s.length > 0),
  );

  // Pre-validate known participants belong to this user.
  const knownParticipantNodeIds = knownParticipants.map((p) => p.nodeId);
  const validKnownNodeIds = new Set<TypeId<"node">>();
  if (knownParticipantNodeIds.length > 0) {
    const rows = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(eq(nodes.userId, userId), inArray(nodes.id, knownParticipantNodeIds)),
      );
    for (const row of rows) validKnownNodeIds.add(row.id);
  }
  const knownByNormalizedLabel = new Map<string, TypeId<"node">>();
  for (const participant of knownParticipants) {
    if (!validKnownNodeIds.has(participant.nodeId)) {
      console.warn(
        `Ignoring knownParticipant '${participant.label}': node ${participant.nodeId} does not belong to user ${userId}.`,
      );
      continue;
    }
    knownByNormalizedLabel.set(
      normalizeAliasText(participant.label),
      participant.nodeId,
    );
  }

  let userSelfNodeId: TypeId<"node"> | null = null;
  const ensureUserSelfNode = async (): Promise<TypeId<"node">> => {
    if (userSelfNodeId) return userSelfNodeId;
    userSelfNodeId = await ensureUserSelfPersonNode(db, userId);
    return userSelfNodeId;
  };

  for (const label of uniqueLabels) {
    const normalized = normalizeAliasText(label);

    // 1. user-self
    if (userSelfNormalized.has(normalized)) {
      const nodeId = await ensureUserSelfNode();
      map.set(label, { nodeId, isUserSelf: true, resolution: "user_self" });
      // Persist the alias on the user-self node so future identity resolution
      // picks it up too.
      await createAlias(db, {
        userId,
        canonicalNodeId: nodeId,
        aliasText: label,
      });
      continue;
    }

    // 2. known participants (caller-supplied)
    const knownNodeId = knownByNormalizedLabel.get(normalized);
    if (knownNodeId) {
      map.set(label, {
        nodeId: knownNodeId,
        isUserSelf: false,
        resolution: "known_participant",
      });
      // Write the alias the caller used so future transcripts resolve via the
      // alias table without the host having to re-pass `knownParticipants`.
      await createAlias(db, {
        userId,
        canonicalNodeId: knownNodeId,
        aliasText: label,
      });
      continue;
    }

    // 3. alias system (Person-typed). Restrict to personal-scope candidates so
    // a reference-document mention of the same name cannot poison transcript
    // speaker resolution.
    const aliasMatches = await db
      .select({ canonicalNodeId: aliases.canonicalNodeId })
      .from(aliases)
      .innerJoin(nodes, eq(nodes.id, aliases.canonicalNodeId))
      .where(
        and(
          eq(aliases.userId, userId),
          eq(aliases.normalizedAliasText, normalized),
          eq(nodes.nodeType, "Person"),
        ),
      );
    const candidateNodeIds = [
      ...new Set(aliasMatches.map((row) => row.canonicalNodeId)),
    ];
    let personalCandidateNodeIds: TypeId<"node">[] = [];
    if (candidateNodeIds.length > 0) {
      const scopes = await getEffectiveNodeScopes(db, userId, candidateNodeIds);
      personalCandidateNodeIds = candidateNodeIds.filter(
        (id) => (scopes.get(id) ?? "personal") === "personal",
      );
    }
    if (personalCandidateNodeIds.length === 1) {
      const nodeId = personalCandidateNodeIds[0]!;
      map.set(label, { nodeId, isUserSelf: false, resolution: "alias" });
      continue;
    }
    if (personalCandidateNodeIds.length > 1) {
      console.warn(
        `Speaker label '${label}' resolves to ${personalCandidateNodeIds.length} personal-scope Person nodes via alias; treating as unresolved.`,
      );
    }

    // 4. placeholder Person node
    const placeholderNodeId = await createPlaceholderPersonNode(
      db,
      userId,
      label,
    );
    await createAlias(db, {
      userId,
      canonicalNodeId: placeholderNodeId,
      aliasText: label,
    });
    map.set(label, {
      nodeId: placeholderNodeId,
      isUserSelf: false,
      resolution: "placeholder",
    });
  }

  return map;
}

/**
 * Ensure the user's own Person node exists. Looked up by
 * `nodeMetadata.additionalData.isUserSelf = true` for the user's Person nodes;
 * created lazily on first transcript ingestion if absent.
 *
 * Concurrency: serialized per-user via a transaction-scoped Postgres advisory
 * lock keyed on `hashtext('user_self_person:' || userId)`. Two concurrent
 * transcript jobs for the same user will queue at the lock and observe each
 * other's INSERT, so only one user-self Person row is ever created. The lock
 * is released automatically at transaction commit.
 */
async function ensureUserSelfPersonNode(
  db: DrizzleDB,
  userId: string,
): Promise<TypeId<"node">> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${"user_self_person:" + userId}))`,
    );

    const personNodes = await tx
      .select({
        id: nodes.id,
        label: nodeMetadata.label,
        additionalData: nodeMetadata.additionalData,
      })
      .from(nodes)
      .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(and(eq(nodes.userId, userId), eq(nodes.nodeType, "Person")));

    for (const row of personNodes) {
      const additional = row.additionalData;
      if (
        additional &&
        typeof additional === "object" &&
        !Array.isArray(additional) &&
        (additional as Record<string, unknown>)["isUserSelf"] === true
      ) {
        return row.id;
      }
    }

    const [newNode] = await tx
      .insert(nodes)
      .values({ userId, nodeType: "Person" })
      .returning();
    if (!newNode) {
      throw new Error(`Failed to create user-self Person node for ${userId}`);
    }
    await tx.insert(nodeMetadata).values({
      nodeId: newNode.id,
      label: userId,
      canonicalLabel: normalizeLabel(userId),
      additionalData: { isUserSelf: true },
    });
    return newNode.id;
  });
}

async function createPlaceholderPersonNode(
  db: DrizzleDB,
  userId: string,
  label: string,
): Promise<TypeId<"node">> {
  const [newNode]: NodeSelect[] = await db
    .insert(nodes)
    .values({ userId, nodeType: "Person" })
    .returning();
  if (!newNode) {
    throw new Error(
      `Failed to create placeholder Person node for speaker '${label}'`,
    );
  }
  await db.insert(nodeMetadata).values({
    nodeId: newNode.id,
    label,
    canonicalLabel: normalizeLabel(label),
    additionalData: { unresolvedSpeaker: true },
  });
  return newNode.id;
}
