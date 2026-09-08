-- Custom SQL migration file, put your code below! --
-- A containment edge is an authority boundary. Parent liveness is enforced in
-- the database as well as by SourceService, so direct SQL cannot attach a new
-- child to erased material between lifecycle discovery and mutation.
CREATE OR REPLACE FUNCTION reject_inactive_source_parent() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_source IS NULL THEN
    RETURN NEW;
  END IF;

  -- This is the same transaction-scoped gate acquired by child ingestion and
  -- lifecycle tree discovery. Direct SQL must share it as well: otherwise a
  -- trigger can observe a live parent immediately before a concurrent
  -- tombstone closes that parent, then commit a live child after the erase.
  PERFORM pg_advisory_xact_lock(
    hashtext('source-parent:' || NEW.user_id || ':' || NEW.parent_source)
  );

  IF NOT EXISTS (
    SELECT 1
    FROM sources parent
    WHERE parent.id = NEW.parent_source
      AND parent.user_id = NEW.user_id
      AND parent.deleted_at IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM source_tombstones tombstone
    WHERE tombstone.user_id = NEW.user_id
      AND tombstone.source_id = NEW.parent_source
  ) THEN
    RAISE EXCEPTION 'source parent must be live and not tombstoned'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER sources_parent_liveness
  BEFORE INSERT OR UPDATE OF user_id, parent_source ON sources
  FOR EACH ROW EXECUTE FUNCTION reject_inactive_source_parent();
