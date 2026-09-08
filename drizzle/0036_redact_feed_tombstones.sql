CREATE OR REPLACE FUNCTION redact_memory_change_feed_tombstone()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.action = 'tombstone' THEN
		NEW.provenance := '{}'::jsonb;
		NEW.freshness := NULL;
		NEW.status := NULL;
		NEW.payload := '{}'::jsonb;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS memory_change_feed_tombstone_redaction ON memory_change_feed_events;
--> statement-breakpoint
CREATE TRIGGER memory_change_feed_tombstone_redaction
BEFORE INSERT OR UPDATE ON memory_change_feed_events
FOR EACH ROW
EXECUTE FUNCTION redact_memory_change_feed_tombstone();
--> statement-breakpoint
UPDATE memory_change_feed_events
SET provenance = '{}'::jsonb,
	freshness = NULL,
	status = NULL,
	payload = '{}'::jsonb
WHERE action = 'tombstone';
--> statement-breakpoint
UPDATE memory_change_feed_events AS event
SET feed_epoch = head.feed_epoch + 1
FROM memory_change_feed_heads AS head
WHERE event.user_id = head.user_id
	AND event.partition_key IS NOT DISTINCT FROM head.partition_key
	AND event.feed_epoch = head.feed_epoch
	AND EXISTS (
		SELECT 1
		FROM memory_change_feed_events AS tombstone
		WHERE tombstone.user_id = head.user_id
			AND tombstone.partition_key IS NOT DISTINCT FROM head.partition_key
			AND tombstone.feed_epoch = head.feed_epoch
			AND tombstone.action = 'tombstone'
	);
--> statement-breakpoint
UPDATE memory_change_feed_heads AS head
SET feed_epoch = head.feed_epoch + 1,
	updated_at = now()
WHERE EXISTS (
	SELECT 1
	FROM memory_change_feed_events AS tombstone
	WHERE tombstone.user_id = head.user_id
		AND tombstone.partition_key IS NOT DISTINCT FROM head.partition_key
		AND tombstone.feed_epoch = head.feed_epoch + 1
		AND tombstone.action = 'tombstone'
);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM sources AS child
		JOIN sources AS parent ON parent.id = child.parent_source
		WHERE child.user_id <> parent.user_id
	) THEN
		RAISE EXCEPTION 'Cannot finish source lifecycle upgrade: legacy sources contain cross-user parent links'
			USING HINT = 'Clear or repair each cross-user parent_source value before retrying migration 0036.';
	END IF;
END;
$$;
