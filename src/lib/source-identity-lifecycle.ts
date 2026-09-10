import { and, eq, inArray, or } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { sourceIdentityTombstones, sources } from "~/db/schema";
import {
  lockSourceIdentityGates,
  PartitionAccessError,
  type SourceIdentity,
} from "~/lib/partition-access";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import {
  sourceListableTypeEnum,
  type SourceListableType,
} from "~/lib/schemas/sources";

function identityKey(identity: SourceIdentity): string {
  return JSON.stringify([
    "source_identity",
    identity.userId,
    identity.sourceType,
    identity.externalId,
  ]);
}

export interface SourceIdentityLifecycleInput {
  userId: string;
  partitionKey?: ContextPartitionKey | undefined;
  identities: Array<{
    type: SourceListableType;
    externalId: string;
  }>;
  action: "retire" | "restore";
}

export interface SourceIdentityLifecycleResult {
  sources: Array<{
    sourceId: string;
    partitionKey: ContextPartitionKey | null;
    sourceVersion: number;
    type: SourceListableType;
    externalId: string;
  }>;
}

/**
 * Close or reopen one stable source identity under the same gate used by
 * source creation. Once retirement returns, a later insert cannot commit.
 */
export async function applySourceIdentityLifecycle(
  db: DrizzleDB,
  input: SourceIdentityLifecycleInput,
): Promise<SourceIdentityLifecycleResult> {
  return db.transaction(async (tx) => {
    const requestedIdentities = [
      ...new Map(
        input.identities.map((identity) => [
          JSON.stringify([identity.type, identity.externalId]),
          identity,
        ]),
      ).values(),
    ];
    const identities = requestedIdentities.map(
      (identity): SourceIdentity => ({
        userId: input.userId,
        sourceType: identity.type,
        externalId: identity.externalId,
      }),
    );
    await lockSourceIdentityGates(tx, identities);
    const requestedKeys = new Set(identities.map(identityKey));
    const types = [...new Set(requestedIdentities.map(({ type }) => type))];
    const externalIds = [
      ...new Set(requestedIdentities.map(({ externalId }) => externalId)),
    ];

    const matchingSources = await tx
      .select({
        sourceId: sources.id,
        partitionKey: sources.partitionKey,
        sourceVersion: sources.version,
        type: sources.type,
        externalId: sources.externalId,
      })
      .from(sources)
      .where(
        and(
          eq(sources.userId, input.userId),
          inArray(sources.type, types),
          inArray(sources.externalId, externalIds),
        ),
      );
    const matchingRetirements = await tx
      .select({
        partitionKey: sourceIdentityTombstones.partitionKey,
        type: sourceIdentityTombstones.type,
        externalId: sourceIdentityTombstones.externalId,
      })
      .from(sourceIdentityTombstones)
      .where(
        and(
          eq(sourceIdentityTombstones.userId, input.userId),
          inArray(sourceIdentityTombstones.type, types),
          inArray(sourceIdentityTombstones.externalId, externalIds),
        ),
      );
    const sourceMatches = matchingSources.filter((source) =>
      requestedKeys.has(
        identityKey({
          userId: input.userId,
          sourceType: source.type,
          externalId: source.externalId,
        }),
      ),
    );
    const retirementMatches = matchingRetirements.filter((retirement) =>
      requestedKeys.has(
        identityKey({
          userId: input.userId,
          sourceType: retirement.type,
          externalId: retirement.externalId,
        }),
      ),
    );
    if (
      sourceMatches.some(
        (source) => source.partitionKey !== (input.partitionKey ?? null),
      )
    ) {
      throw new PartitionAccessError(
        "PARTITION_UNAUTHORIZED",
        "Source identity belongs to another memory partition",
      );
    }
    if (
      retirementMatches.some(
        (retirement) =>
          retirement.partitionKey !== (input.partitionKey ?? null),
      )
    ) {
      throw new PartitionAccessError(
        "PARTITION_UNAUTHORIZED",
        "Source identity retirement belongs to another memory partition",
      );
    }

    if (input.action === "retire") {
      await tx
        .insert(sourceIdentityTombstones)
        .values(
          requestedIdentities.map((identity) => ({
            userId: input.userId,
            type: identity.type,
            externalId: identity.externalId,
            partitionKey: input.partitionKey,
          })),
        )
        .onConflictDoNothing({
          target: [
            sourceIdentityTombstones.userId,
            sourceIdentityTombstones.type,
            sourceIdentityTombstones.externalId,
          ],
        });
    } else {
      await tx
        .delete(sourceIdentityTombstones)
        .where(
          and(
            eq(sourceIdentityTombstones.userId, input.userId),
            or(
              ...requestedIdentities.map((identity) =>
                and(
                  eq(sourceIdentityTombstones.type, identity.type),
                  eq(sourceIdentityTombstones.externalId, identity.externalId),
                ),
              ),
            )!,
          ),
        );
    }

    return {
      sources: sourceMatches.map((source) => ({
        ...source,
        type: sourceListableTypeEnum.parse(source.type),
      })),
    };
  });
}
