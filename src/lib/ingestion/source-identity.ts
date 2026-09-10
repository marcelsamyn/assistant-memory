import type { ContextPartitionKey } from "../schemas/partition.js";
import { sourceContextSchema } from "../schemas/source-context.js";

function encodeIdentityPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * Namespaces contextual sources by the connected account and destination
 * partition. Legacy callers keep their existing external id when no context
 * is supplied.
 *
 * Ingestion accepts raw provider ids and applies this contract when sourceContext
 * is present. Lifecycle requests accept the returned canonical id. Call this
 * once with the source's accountId and current partitionKey (the destination
 * after a move); a canonical id must not be passed back as an ingestion id
 * with sourceContext.
 */
export function contextualSourceExternalId(input: {
  externalId: string;
  accountId?: string;
  partitionKey?: ContextPartitionKey;
}): string {
  if (input.accountId === undefined && input.partitionKey === undefined) {
    return input.externalId;
  }
  return [
    "context",
    encodeIdentityPart(input.accountId ?? "legacy-account"),
    encodeIdentityPart(input.partitionKey ?? "legacy-partition"),
    encodeIdentityPart(input.externalId),
  ].join(":");
}

/**
 * Returns the stable file identity. Content belongs to the processing
 * receipt, not the source identity: a revised file keeps its source links and
 * receives a new ingestion operation instead of becoming a new source.
 */
export function contextualFileRevisionExternalId(input: {
  externalId: string;
  accountId?: string;
  partitionKey?: ContextPartitionKey;
  /** Kept in the helper input for callers that already calculate the hash. */
  contentHash?: string;
}): string {
  return contextualSourceExternalId(input);
}

/** Rekey only identities backed by the stored contextual-ingestion contract. */
export function reclassifyContextualSourceExternalId(input: {
  externalId: string;
  metadata: unknown;
  expectedPartitionKey: ContextPartitionKey | null;
  targetPartitionKey: ContextPartitionKey;
}): string {
  const context = sourceContextSchema.safeParse(
    typeof input.metadata === "object" &&
      input.metadata !== null &&
      "sourceContext" in input.metadata
      ? input.metadata.sourceContext
      : undefined,
  );
  if (!context.success) return input.externalId;
  const parts = input.externalId.split(":");
  if (parts.length !== 4 || parts[0] !== "context" || parts[3] === undefined)
    return input.externalId;
  const providerId = Buffer.from(parts[3], "base64url").toString("utf8");
  const identity = {
    externalId: providerId,
    accountId: context.data.accountId,
  };
  if (
    contextualSourceExternalId({
      ...identity,
      ...(input.expectedPartitionKey !== null
        ? { partitionKey: input.expectedPartitionKey }
        : {}),
    }) !== input.externalId
  )
    return input.externalId;
  return contextualSourceExternalId({
    ...identity,
    partitionKey: input.targetPartitionKey,
  });
}
