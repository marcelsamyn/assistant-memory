ALTER TABLE "source_tombstones" ADD COLUMN "read_model_cleanup_state" varchar(20) DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_tombstones" ADD CONSTRAINT "source_tombstones_read_model_cleanup_state_ck" CHECK ("read_model_cleanup_state" IN ('not_required', 'pending', 'completed'));--> statement-breakpoint

-- 0030 created permanent tombstones for legacy soft deletes, but predates the
-- lifecycle transaction that retracts derived projections. Schedule each live
-- soft-deleted root for bounded maintenance recovery; no source content is
-- copied into the receipt.
UPDATE "source_tombstones" tombstone
SET "read_model_cleanup_state" = 'pending',
    "updated_at" = now()
FROM "sources" source
WHERE tombstone."user_id" = source."user_id"
  AND tombstone."source_id" = source."id"
  AND source."deleted_at" IS NOT NULL
  AND tombstone."read_model_cleanup_state" = 'not_required';--> statement-breakpoint

-- Cover a deployment gap where a legacy soft delete landed after 0030 ran.
-- The source still owns its identity, so this is an idempotent non-content
-- authority record that the maintenance sweep can safely claim.
INSERT INTO "source_tombstones" (
  "user_id", "source_id", "partition_key", "state",
  "read_model_cleanup_state", "storage_cleanup_state", "storage_object_key",
  "erased_at", "finalized_at"
)
SELECT
  source."user_id", source."id", source."partition_key", 'purged',
  'pending', 'pending', source."user_id" || '/' || source."id",
  COALESCE(source."deleted_at", now()), COALESCE(source."deleted_at", now())
FROM "sources" source
WHERE source."deleted_at" IS NOT NULL
ON CONFLICT ("user_id", "source_id") DO NOTHING;
