/**
 * Test-only compatibility schema for legacy handcrafted PostgreSQL fixtures.
 *
 * These fixtures intentionally model only the tables required by their
 * subject. Partition-specific behavior must use a fully migrated test
 * database so production constraints and triggers remain under test.
 */
import type { Client } from "pg";

type SqlExecutor = Pick<Client, "query">;

/** Add the minimum partition columns and access tables to a legacy fixture. */
export async function installPartitionCompatibilityFixture(
  client: SqlExecutor,
): Promise<void> {
  await client.query(`
    ALTER TABLE IF EXISTS "nodes"
      ADD COLUMN IF NOT EXISTS "partition_key" varchar(200);
    ALTER TABLE IF EXISTS "sources"
      ADD COLUMN IF NOT EXISTS "partition_key" varchar(200);
    ALTER TABLE IF EXISTS "sources"
      ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 0 NOT NULL;
    ALTER TABLE IF EXISTS "sources"
      ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
    ALTER TABLE IF EXISTS "claims"
      ADD COLUMN IF NOT EXISTS "partition_key" varchar(200);
    ALTER TABLE IF EXISTS "aliases"
      ADD COLUMN IF NOT EXISTS "partition_key" varchar(200);
    ALTER TABLE IF EXISTS "node_redirects"
      ADD COLUMN IF NOT EXISTS "partition_key" varchar(200);

    CREATE TABLE IF NOT EXISTS "memory_partitions" (
      "user_id" text NOT NULL,
      "partition_key" varchar(200) NOT NULL,
      "status" varchar(20) DEFAULT 'active' NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "memory_partitions_user_id_partition_key_pk"
        PRIMARY KEY ("user_id", "partition_key"),
      CONSTRAINT "memory_partitions_status_ck"
        CHECK ("status" IN ('active', 'quarantined'))
    );

    CREATE TABLE IF NOT EXISTS "partition_migration_state" (
      "user_id" text PRIMARY KEY NOT NULL,
      "state" varchar(20) NOT NULL,
      "version" integer DEFAULT 1 NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "partition_migration_state_state_ck"
        CHECK ("state" IN ('migrating', 'migrated')),
      CONSTRAINT "partition_migration_state_version_ck"
        CHECK ("version" > 0)
    );

    CREATE TABLE IF NOT EXISTS "source_tombstones" (
      "user_id" text NOT NULL,
      "source_id" text NOT NULL,
      "partition_key" varchar(200),
      "state" varchar(20) NOT NULL,
      "storage_cleanup_state" varchar(20) DEFAULT 'not_required' NOT NULL,
      "read_model_cleanup_state" varchar(20) DEFAULT 'not_required' NOT NULL,
      "storage_object_key" text,
      "erased_at" timestamp with time zone NOT NULL,
      "restorable_until" timestamp with time zone,
      "finalized_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "source_tombstones_user_id_source_id_pk"
        PRIMARY KEY ("user_id", "source_id"),
      CONSTRAINT "source_tombstones_state_ck"
        CHECK ("state" IN ('tombstoned', 'restored', 'purged')),
      CONSTRAINT "source_tombstones_storage_cleanup_state_ck"
        CHECK ("storage_cleanup_state" IN ('not_required', 'pending', 'completed')),
      CONSTRAINT "source_tombstones_read_model_cleanup_state_ck"
        CHECK ("read_model_cleanup_state" IN ('not_required', 'pending', 'completed'))
    );
  `);
}
