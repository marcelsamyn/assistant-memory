import { eq, isNull, sql, type SQL } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { metricDefinitions, metricObservations, sources } from "~/db/schema";
import { assertPartitionReadAllowed } from "~/lib/partition-access";
import type { ContextPartitionKey } from "~/lib/schemas/partition";

export async function assertMetricPartitionRead(
  db: DrizzleDB,
  userId: string,
  partitionKey: ContextPartitionKey | undefined,
): Promise<void> {
  await assertPartitionReadAllowed(db, userId, partitionKey);
}

export function metricObservationPartitionCondition(
  userId: string,
  partitionKey: ContextPartitionKey | undefined,
): SQL {
  const sourcePartition =
    partitionKey === undefined
      ? isNull(sources.partitionKey)
      : eq(sources.partitionKey, partitionKey);
  return sql`EXISTS (
    SELECT 1 FROM ${sources}
    WHERE ${sources.id} = ${metricObservations.sourceId}
      AND ${sources.userId} = ${userId}
      AND ${sources.deletedAt} IS NULL
      AND ${sourcePartition}
  )`;
}

export function metricDefinitionPartitionCondition(
  userId: string,
  partitionKey: ContextPartitionKey | undefined,
): SQL | undefined {
  if (partitionKey === undefined) return undefined;
  return sql`EXISTS (
    SELECT 1 FROM ${metricObservations}
    JOIN ${sources} ON ${sources.id} = ${metricObservations.sourceId}
    WHERE ${metricObservations.metricDefinitionId} = ${metricDefinitions.id}
      AND ${metricObservations.userId} = ${userId}
      AND ${sources.userId} = ${userId}
      AND ${sources.deletedAt} IS NULL
      AND ${sources.partitionKey} = ${partitionKey}
  )`;
}
