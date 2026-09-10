import type { ContextPartitionKey } from "~/lib/schemas/partition";

function encodeIdentityPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * Namespaces contextual sources by the connected account and destination
 * partition. Legacy callers keep their existing external id when no context
 * is supplied.
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
