ALTER TABLE "source_lifecycle_commands" ADD COLUMN "storage_cleanup_state" varchar(20) DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_tombstones" ADD COLUMN "storage_cleanup_state" varchar(20) DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_lifecycle_commands" ADD COLUMN "storage_object_keys" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_tombstones" ADD COLUMN "storage_object_key" text;--> statement-breakpoint
ALTER TABLE "source_lifecycle_commands" ADD CONSTRAINT "source_lifecycle_commands_storage_cleanup_state_ck" CHECK ("storage_cleanup_state" IN ('not_required', 'pending', 'completed'));--> statement-breakpoint
ALTER TABLE "source_tombstones" ADD CONSTRAINT "source_tombstones_storage_cleanup_state_ck" CHECK ("storage_cleanup_state" IN ('not_required', 'pending', 'completed'));--> statement-breakpoint
-- 0030 seeded these rows after the first privacy migration. Capture every
-- physical-object identity before a later restore/purge removes the source,
-- and scrub inline descriptors that the original soft delete left behind.
UPDATE "source_tombstones" tombstone
SET "storage_cleanup_state" = 'pending',
    "storage_object_key" = source."user_id" || '/' || source."id"
FROM "sources" source
WHERE tombstone."user_id" = source."user_id"
  AND tombstone."source_id" = source."id"
  AND source."deleted_at" IS NOT NULL;--> statement-breakpoint
UPDATE "sources"
SET "metadata" = '{}'::jsonb,
    "content_type" = NULL,
    "content_length" = NULL
WHERE "deleted_at" IS NOT NULL;

-- A soft-deleted source row remains present during the restore window, so an
-- ordinary FK cannot prevent a late worker from writing new evidence against
-- it. Lock the source authority row and reject every evidence/reference write
-- once its immutable tombstone exists. The row lock serializes this check with
-- lifecycle erasure: either the write commits first and is erased, or it fails
-- before it can recreate data after the tombstone commits.
CREATE OR REPLACE FUNCTION reject_tombstoned_source_reference() RETURNS trigger AS $$
DECLARE
  v_source_user_id text;
  v_referencing_user_id text;
  v_deleted_at timestamptz;
BEGIN
  SELECT s."user_id", s."deleted_at"
  INTO v_source_user_id, v_deleted_at
  FROM "sources" s
  WHERE s."id" = NEW."source_id"
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'source reference must resolve to a live source'
      USING ERRCODE = '23514';
  END IF;

  -- source_links deliberately has no user_id. Its owner is the linked node;
  -- every other guarded evidence row owns user_id directly. Resolve that
  -- authority explicitly instead of reading a non-existent NEW.user_id.
  IF TG_TABLE_NAME = 'source_links' THEN
    SELECT n."user_id"
    INTO v_referencing_user_id
    FROM "nodes" n
    WHERE n."id" = NEW."node_id"
    FOR SHARE;
  ELSE
    v_referencing_user_id := to_jsonb(NEW)->>'user_id';
  END IF;

  IF v_referencing_user_id IS NULL
    OR v_referencing_user_id IS DISTINCT FROM v_source_user_id THEN
    RAISE EXCEPTION 'source provenance must belong to the same user'
      USING ERRCODE = '23514';
  END IF;

  IF v_deleted_at IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM "source_tombstones" tombstone
      WHERE tombstone."user_id" = v_source_user_id
        AND tombstone."source_id" = NEW."source_id"
    ) THEN
    RAISE EXCEPTION 'cannot write evidence for a tombstoned source'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER claims_source_liveness
  BEFORE INSERT OR UPDATE OF "source_id", "user_id" ON "claims"
  FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_source_reference();--> statement-breakpoint
CREATE TRIGGER source_links_source_liveness
  BEFORE INSERT OR UPDATE OF "source_id", "node_id" ON "source_links"
  FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_source_reference();--> statement-breakpoint
CREATE TRIGGER commitment_presentations_source_liveness
  BEFORE INSERT OR UPDATE OF "source_id", "user_id" ON "commitment_presentations"
  FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_source_reference();--> statement-breakpoint
CREATE TRIGGER metric_observations_source_liveness
  BEFORE INSERT OR UPDATE OF "source_id", "user_id" ON "metric_observations"
  FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_source_reference();--> statement-breakpoint
