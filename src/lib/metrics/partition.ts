import { sql, type SQL } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { metricDefinitions, metricObservations, sources } from "~/db/schema";
import {
  assertPartitionReadAllowed,
  partitionAccessCondition,
} from "~/lib/partition-access";
import type {
  ContextPartitionKey,
  MemoryAccessScope,
} from "~/lib/schemas/partition";

export async function assertMetricPartitionRead(
  db: DrizzleDB,
  userId: string,
  partitionKey: ContextPartitionKey | undefined,
  accessScope?: MemoryAccessScope | undefined,
): Promise<void> {
  await assertPartitionReadAllowed(db, userId, partitionKey, accessScope);
}

export function metricObservationPartitionCondition(
  userId: string,
  partitionKey: ContextPartitionKey | undefined,
  accessScope?: MemoryAccessScope | undefined,
): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${sources}
    WHERE ${sources.id} = ${metricObservations.sourceId}
      AND ${sources.userId} = ${userId}
      AND ${sources.deletedAt} IS NULL
      AND ${partitionAccessCondition(
        sources.partitionKey,
        userId,
        partitionKey,
        accessScope,
      )}
  )`;
}

export function metricDefinitionPartitionCondition(
  userId: string,
  partitionKey: ContextPartitionKey | undefined,
  accessScope?: MemoryAccessScope | undefined,
): SQL | undefined {
  if (partitionKey === undefined && accessScope !== "workspace") {
    return undefined;
  }
  return sql`EXISTS (
    SELECT 1 FROM ${metricObservations}
    JOIN ${sources} ON ${sources.id} = ${metricObservations.sourceId}
    WHERE ${metricObservations.metricDefinitionId} = ${metricDefinitions.id}
      AND ${metricObservations.userId} = ${userId}
      AND ${sources.userId} = ${userId}
      AND ${sources.deletedAt} IS NULL
      AND ${partitionAccessCondition(
        sources.partitionKey,
        userId,
        partitionKey,
        accessScope,
      )}
  )`;
}
