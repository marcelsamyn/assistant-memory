/** Structured partition failures safe to serialize at API boundaries. */
import type {
  ContextPartitionKey,
  PartitionMigrationState,
} from "~/lib/schemas/partition";

export type PartitionReclassificationErrorCode =
  | "MIGRATION_STATE_CONFLICT"
  | "MIGRATION_INCOMPLETE"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_VERSION_CONFLICT"
  | "SOURCE_PARTITION_CONFLICT"
  | "BINDING_GENERATION_CONFLICT"
  | "MAPPING_QUARANTINED";

export interface PartitionAuthoritativeState {
  migrationState?: PartitionMigrationState;
  migrationVersion?: number;
  sourcePartitionKey?: ContextPartitionKey | null;
  sourceVersion?: number;
  sourceNodeId?: string;
  targetPartitionKey?: ContextPartitionKey;
}

export class PartitionReclassificationError extends Error {
  constructor(
    readonly code: PartitionReclassificationErrorCode,
    message: string,
    readonly current: PartitionAuthoritativeState = {},
  ) {
    super(message);
    this.name = "PartitionReclassificationError";
  }
}
