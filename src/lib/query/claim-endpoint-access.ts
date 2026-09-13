import {
  and,
  eq,
  isNull,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

/** Columns needed to prove that a claim and both graph endpoints share scope. */
export interface ClaimEndpointOwnershipColumns {
  claimUserId: SQLWrapper;
  claimPartitionKey: SQLWrapper;
  subjectUserId: SQLWrapper;
  subjectPartitionKey: SQLWrapper;
  objectNodeId: SQLWrapper;
  /** Pass joined endpoint columns when the query already joins the object. */
  objectUserId?: SQLWrapper;
  objectPartitionKey?: SQLWrapper;
}

/**
 * Reject malformed graph edges before their labels or IDs enter a read result.
 * A literal claim has no object node and therefore needs no object check.
 */
export function claimEndpointOwnershipCondition(
  columns: ClaimEndpointOwnershipColumns,
  userId: string,
): SQL<unknown> {
  const objectOwnership =
    columns.objectUserId && columns.objectPartitionKey
      ? and(
          eq(columns.objectUserId, userId),
          sql`${columns.claimPartitionKey} IS NOT DISTINCT FROM ${columns.objectPartitionKey}`,
        )
      : sql`EXISTS (
          SELECT 1
            FROM "nodes" AS claim_object_endpoint
           WHERE claim_object_endpoint.id = ${columns.objectNodeId}
             AND claim_object_endpoint.user_id = ${userId}
             AND claim_object_endpoint.partition_key IS NOT DISTINCT FROM ${columns.claimPartitionKey}
        )`;

  return and(
    eq(columns.claimUserId, userId),
    eq(columns.subjectUserId, userId),
    sql`${columns.claimPartitionKey} IS NOT DISTINCT FROM ${columns.subjectPartitionKey}`,
    or(isNull(columns.objectNodeId), objectOwnership),
  )!;
}
