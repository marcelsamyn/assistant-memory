-- Lossless lifecycle feed. Sequences are allocated while the matching head
-- row is locked; events are append-only and therefore safe to replay.
CREATE TABLE "memory_change_feed_heads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"partition_key" varchar(200),
	"feed_epoch" integer DEFAULT 1 NOT NULL,
	"next_sequence" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_change_feed_heads_user_partition_unique" UNIQUE NULLS NOT DISTINCT ("user_id", "partition_key"),
	CONSTRAINT "memory_change_feed_heads_epoch_ck" CHECK ("feed_epoch" > 0),
	CONSTRAINT "memory_change_feed_heads_sequence_ck" CHECK ("next_sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "memory_change_feed_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"partition_key" varchar(200),
	"feed_epoch" integer NOT NULL,
	"sequence" bigint NOT NULL,
	"kind" varchar(32) NOT NULL,
	"action" varchar(40) NOT NULL,
	"entity_type" varchar(32) NOT NULL,
	"entity_id" text,
	"source_id" text,
	"effective_change_time" timestamp with time zone NOT NULL,
	"provenance" jsonb,
	"freshness" jsonb,
	"status" varchar(30),
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_change_feed_events_user_partition_epoch_sequence_unique" UNIQUE NULLS NOT DISTINCT ("user_id", "partition_key", "feed_epoch", "sequence"),
	CONSTRAINT "memory_change_feed_events_epoch_ck" CHECK ("feed_epoch" > 0),
	CONSTRAINT "memory_change_feed_events_sequence_ck" CHECK ("sequence" > 0)
);
--> statement-breakpoint
CREATE INDEX "memory_change_feed_events_cursor_idx" ON "memory_change_feed_events" USING btree ("user_id", "partition_key", "feed_epoch", "sequence");
--> statement-breakpoint
CREATE INDEX "memory_change_feed_events_source_idx" ON "memory_change_feed_events" USING btree ("user_id", "source_id");
--> statement-breakpoint

CREATE FUNCTION append_memory_change_feed_event(
	p_user_id text,
	p_partition_key varchar,
	p_kind varchar,
	p_action varchar,
	p_entity_type varchar,
	p_entity_id text,
	p_source_id text,
	p_effective_change_time timestamptz,
	p_provenance jsonb,
	p_freshness jsonb,
	p_status varchar,
	p_payload jsonb
) RETURNS text AS $$
DECLARE
	v_feed_epoch integer;
	v_next_sequence bigint;
	v_event_id text;
	v_head_id text := 'mcfh_' || md5(jsonb_build_array(p_user_id, p_partition_key)::text);
BEGIN
	INSERT INTO memory_change_feed_heads (id, user_id, partition_key)
	VALUES (v_head_id, p_user_id, p_partition_key)
	ON CONFLICT (user_id, partition_key) DO NOTHING;

	-- This lock is the commit-safe append point. A transaction that rolls back
	-- releases the sequence without exposing an event or a cursor gap.
	SELECT feed_epoch, next_sequence
	INTO v_feed_epoch, v_next_sequence
	FROM memory_change_feed_heads
	WHERE user_id = p_user_id
		AND partition_key IS NOT DISTINCT FROM p_partition_key
	FOR UPDATE;

	v_event_id := 'mcfe_' || md5(jsonb_build_array(p_user_id, p_partition_key, v_feed_epoch, v_next_sequence)::text);
	INSERT INTO memory_change_feed_events (
		event_id, user_id, partition_key, feed_epoch, sequence, kind, action,
		entity_type, entity_id, source_id, effective_change_time, provenance,
		freshness, status, payload
	) VALUES (
		v_event_id, p_user_id, p_partition_key, v_feed_epoch, v_next_sequence,
		p_kind, p_action, p_entity_type, p_entity_id, p_source_id,
		COALESCE(p_effective_change_time, now()), p_provenance, p_freshness,
		p_status, COALESCE(p_payload, '{}'::jsonb)
	);
	UPDATE memory_change_feed_heads
	SET next_sequence = v_next_sequence + 1, updated_at = now()
	WHERE user_id = p_user_id
		AND partition_key IS NOT DISTINCT FROM p_partition_key;
	RETURN v_event_id;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE FUNCTION emit_memory_change_feed_event() RETURNS trigger AS $$
DECLARE
	v_user_id text;
	v_partition_key varchar;
	v_link record;
	v_kind varchar;
	v_action varchar;
	v_entity_type varchar;
	v_entity_id text;
	v_source_id text;
	v_effective_change_time timestamptz;
	v_provenance jsonb;
	v_freshness jsonb;
	v_status varchar;
	v_payload jsonb;
BEGIN
	IF TG_TABLE_NAME = 'source_links' THEN
		SELECT s.user_id, s.partition_key INTO v_user_id, v_partition_key
		FROM sources s
		WHERE s.id = (to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'source_id');
		IF v_user_id IS NULL THEN
			SELECT n.user_id, n.partition_key INTO v_user_id, v_partition_key
			FROM nodes n
			WHERE n.id = (to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'node_id');
		END IF;
		v_entity_id := COALESCE(to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'id', to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'source_id');
		v_payload := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) || jsonb_build_object('deleted', true) ELSE to_jsonb(NEW) END;
	ELSIF TG_OP = 'DELETE' THEN
		v_user_id := OLD.user_id;
		v_partition_key := OLD.partition_key;
		v_entity_id := COALESCE(to_jsonb(OLD)->>'id', to_jsonb(OLD)->>'from_node_id');
		v_payload := to_jsonb(OLD) || jsonb_build_object('deleted', true);
	ELSE
		v_user_id := NEW.user_id;
		v_partition_key := NEW.partition_key;
		v_entity_id := COALESCE(to_jsonb(NEW)->>'id', to_jsonb(NEW)->>'from_node_id');
		v_payload := to_jsonb(NEW);
	END IF;
	v_effective_change_time := COALESCE(
		CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE (to_jsonb(NEW)->>'updated_at')::timestamptz END,
		CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE (to_jsonb(NEW)->>'created_at')::timestamptz END,
		CASE WHEN TG_OP = 'DELETE' THEN (to_jsonb(OLD)->>'updated_at')::timestamptz ELSE NULL END,
		CASE WHEN TG_OP = 'DELETE' THEN (to_jsonb(OLD)->>'created_at')::timestamptz ELSE NULL END,
		now()
	);

	IF TG_TABLE_NAME = 'claims' THEN
		v_kind := 'claim';
		v_entity_type := 'claim';
		v_source_id := COALESCE(to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'source_id', NULL);
		v_provenance := jsonb_build_object(
			'sourceId', v_source_id,
			'assertedByKind', COALESCE(to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'asserted_by_kind', NULL),
			'scope', COALESCE(to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'scope', NULL)
		);
		v_status := COALESCE(to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'status', 'deleted');
		v_action := CASE
			WHEN TG_OP = 'DELETE' THEN 'tombstone'
			WHEN TG_OP = 'INSERT' THEN 'asserted'
			WHEN NEW.status IS DISTINCT FROM OLD.status THEN NEW.status
			ELSE 'updated'
		END;
		IF NOT (TG_OP = 'UPDATE' AND NEW.partition_key IS DISTINCT FROM OLD.partition_key) THEN
			PERFORM append_memory_change_feed_event(v_user_id, v_partition_key, v_kind, v_action, v_entity_type, v_entity_id, v_source_id, v_effective_change_time, v_provenance, NULL, v_status, v_payload);
		END IF;
		IF COALESCE(to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'predicate', '') IN ('HAS_TASK_STATUS', 'ASSIGNED_TO', 'DUE_ON') AND NOT (TG_OP = 'UPDATE' AND NEW.partition_key IS DISTINCT FROM OLD.partition_key) THEN
			PERFORM append_memory_change_feed_event(
				v_user_id,
				v_partition_key,
				'commitment',
				v_action,
				'commitment',
				to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'subject_node_id',
				v_source_id,
				v_effective_change_time,
				v_provenance,
				NULL,
				v_status,
				v_payload
			);
		END IF;
		IF TG_OP = 'UPDATE' AND NEW.partition_key IS DISTINCT FROM OLD.partition_key THEN
			PERFORM append_memory_change_feed_event(OLD.user_id, OLD.partition_key, 'deletion', 'tombstone', v_entity_type, v_entity_id, v_source_id, now(), v_provenance, NULL, OLD.status, jsonb_build_object('reclassified', true, 'toPartition', NEW.partition_key, 'claim', to_jsonb(OLD)));
			PERFORM append_memory_change_feed_event(NEW.user_id, NEW.partition_key, 'claim', 'snapshot', v_entity_type, v_entity_id, v_source_id, v_effective_change_time, v_provenance, NULL, NEW.status, jsonb_build_object('reclassified', true, 'fromPartition', OLD.partition_key, 'claim', to_jsonb(NEW)));
			IF COALESCE(to_jsonb(OLD)->>'predicate', '') IN ('HAS_TASK_STATUS', 'ASSIGNED_TO', 'DUE_ON') THEN
				PERFORM append_memory_change_feed_event(OLD.user_id, OLD.partition_key, 'deletion', 'tombstone', 'commitment', to_jsonb(OLD)->>'subject_node_id', v_source_id, now(), v_provenance, NULL, OLD.status, jsonb_build_object('reclassified', true, 'toPartition', NEW.partition_key, 'claim', to_jsonb(OLD)));
			END IF;
			IF COALESCE(to_jsonb(NEW)->>'predicate', '') IN ('HAS_TASK_STATUS', 'ASSIGNED_TO', 'DUE_ON') THEN
				PERFORM append_memory_change_feed_event(NEW.user_id, NEW.partition_key, 'commitment', 'snapshot', 'commitment', to_jsonb(NEW)->>'subject_node_id', v_source_id, v_effective_change_time, v_provenance, NULL, NEW.status, jsonb_build_object('reclassified', true, 'fromPartition', OLD.partition_key, 'claim', to_jsonb(NEW)));
			END IF;
		END IF;
	ELSIF TG_TABLE_NAME = 'sources' THEN
		v_kind := 'source';
		v_entity_type := 'source';
		v_source_id := v_entity_id;
		v_status := COALESCE(to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'status', 'deleted');
		v_provenance := jsonb_build_object('externalId', COALESCE(to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'external_id', NULL), 'type', COALESCE(to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'type', NULL));
		v_freshness := jsonb_build_object('status', v_status, 'lastIngestedAt', COALESCE(to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'last_ingested_at', NULL));
		v_action := CASE WHEN TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) THEN 'tombstone' WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'updated' END;
		IF TG_OP = 'UPDATE' AND NEW.partition_key IS DISTINCT FROM OLD.partition_key THEN
			PERFORM append_memory_change_feed_event(OLD.user_id, OLD.partition_key, 'deletion', 'tombstone', v_entity_type, v_entity_id, v_source_id, now(), v_provenance, v_freshness, OLD.status, jsonb_build_object('reclassified', true, 'toPartition', NEW.partition_key, 'source', to_jsonb(OLD)));
			PERFORM append_memory_change_feed_event(NEW.user_id, NEW.partition_key, 'source', 'snapshot', v_entity_type, v_entity_id, v_source_id, v_effective_change_time, v_provenance, v_freshness, NEW.status, jsonb_build_object('reclassified', true, 'fromPartition', OLD.partition_key, 'source', to_jsonb(NEW)));
			FOR v_link IN
				SELECT sl.id, sl.source_id, sl.node_id, sl.created_at
				FROM source_links sl
				WHERE sl.source_id = NEW.id
				ORDER BY sl.id
			LOOP
				PERFORM append_memory_change_feed_event(
					OLD.user_id,
					OLD.partition_key,
					'deletion',
					'tombstone',
					'source_link',
					v_link.id,
					OLD.id,
					v_link.created_at,
					jsonb_build_object('sourceId', OLD.id, 'nodeId', v_link.node_id),
					NULL,
					NULL,
					jsonb_build_object('reclassified', true, 'toPartition', NEW.partition_key, 'sourceLink', to_jsonb(v_link))
				);
				PERFORM append_memory_change_feed_event(
					NEW.user_id,
					NEW.partition_key,
					'provenance',
					'snapshot',
					'source_link',
					v_link.id,
					NEW.id,
					v_link.created_at,
					jsonb_build_object('sourceId', NEW.id, 'nodeId', v_link.node_id),
					NULL,
					NULL,
					jsonb_build_object('reclassified', true, 'fromPartition', OLD.partition_key, 'sourceLink', to_jsonb(v_link))
				);
			END LOOP;
		ELSE
			PERFORM append_memory_change_feed_event(v_user_id, v_partition_key, v_kind, v_action, v_entity_type, v_entity_id, v_source_id, v_effective_change_time, v_provenance, v_freshness, v_status, v_payload);
		END IF;
		IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
			PERFORM append_memory_change_feed_event(v_user_id, v_partition_key, 'ingestion', NEW.status, 'source', v_entity_id, v_source_id, v_effective_change_time, v_provenance, v_freshness, NEW.status, v_payload);
		END IF;
		IF TG_OP = 'UPDATE' AND NEW.last_ingested_at IS DISTINCT FROM OLD.last_ingested_at THEN
			PERFORM append_memory_change_feed_event(v_user_id, v_partition_key, 'freshness', 'changed', 'source', v_entity_id, v_source_id, NEW.last_ingested_at, v_provenance, v_freshness, NEW.status, v_payload);
		END IF;
	ELSIF TG_TABLE_NAME = 'nodes' THEN
		v_kind := CASE WHEN TG_OP = 'DELETE' THEN 'deletion' ELSE 'node' END;
		v_action := CASE WHEN TG_OP = 'DELETE' THEN 'tombstone' WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'updated' END;
		v_entity_type := 'node';
		IF TG_OP = 'UPDATE' AND NEW.partition_key IS DISTINCT FROM OLD.partition_key THEN
			PERFORM append_memory_change_feed_event(OLD.user_id, OLD.partition_key, 'deletion', 'tombstone', v_entity_type, v_entity_id, NULL, now(), NULL, NULL, NULL, jsonb_build_object('reclassified', true, 'toPartition', NEW.partition_key));
			PERFORM append_memory_change_feed_event(NEW.user_id, NEW.partition_key, 'node', 'snapshot', v_entity_type, v_entity_id, NULL, v_effective_change_time, NULL, NULL, NULL, jsonb_build_object('reclassified', true, 'fromPartition', OLD.partition_key, 'node', to_jsonb(NEW)));
		ELSE
			PERFORM append_memory_change_feed_event(v_user_id, v_partition_key, v_kind, v_action, v_entity_type, v_entity_id, NULL, v_effective_change_time, NULL, NULL, NULL, v_payload);
		END IF;
	ELSIF TG_TABLE_NAME = 'node_redirects' THEN
		v_kind := CASE WHEN TG_OP = 'DELETE' THEN 'deletion' ELSE 'redirect' END;
		v_action := CASE WHEN TG_OP = 'DELETE' THEN 'tombstone' WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'updated' END;
		v_entity_type := 'redirect';
		IF TG_OP = 'UPDATE' AND NEW.partition_key IS DISTINCT FROM OLD.partition_key THEN
			PERFORM append_memory_change_feed_event(
				OLD.user_id,
				OLD.partition_key,
				'deletion',
				'tombstone',
				v_entity_type,
				OLD.from_node_id,
				NULL,
				now(),
				jsonb_build_object('fromNodeId', OLD.from_node_id, 'toNodeId', OLD.to_node_id),
				NULL,
				NULL,
				jsonb_build_object('reclassified', true, 'toPartition', NEW.partition_key, 'redirect', to_jsonb(OLD))
			);
			PERFORM append_memory_change_feed_event(
				NEW.user_id,
				NEW.partition_key,
				'redirect',
				'snapshot',
				v_entity_type,
				NEW.from_node_id,
				NULL,
				v_effective_change_time,
				jsonb_build_object('fromNodeId', NEW.from_node_id, 'toNodeId', NEW.to_node_id),
				NULL,
				NULL,
				jsonb_build_object('reclassified', true, 'fromPartition', OLD.partition_key, 'redirect', to_jsonb(NEW))
			);
		ELSE
			PERFORM append_memory_change_feed_event(v_user_id, v_partition_key, v_kind, v_action, v_entity_type, v_entity_id, NULL, v_effective_change_time, jsonb_build_object('fromNodeId', to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'from_node_id', 'toNodeId', to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'to_node_id'), NULL, NULL, v_payload);
		END IF;
	ELSIF TG_TABLE_NAME = 'source_links' THEN
		v_kind := CASE WHEN TG_OP = 'DELETE' THEN 'deletion' ELSE 'provenance' END;
		v_action := CASE WHEN TG_OP = 'DELETE' THEN 'tombstone' WHEN TG_OP = 'INSERT' THEN 'attached' ELSE 'updated' END;
		v_entity_type := 'source_link';
		v_source_id := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'source_id';
		PERFORM append_memory_change_feed_event(v_user_id, v_partition_key, v_kind, v_action, v_entity_type, v_entity_id, v_source_id, v_effective_change_time, jsonb_build_object('sourceId', v_source_id, 'nodeId', to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'node_id'), NULL, NULL, v_payload);
	END IF;
	IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER memory_change_feed_claims AFTER INSERT OR UPDATE OR DELETE ON claims FOR EACH ROW EXECUTE FUNCTION emit_memory_change_feed_event();
--> statement-breakpoint
CREATE TRIGGER memory_change_feed_sources AFTER INSERT OR UPDATE OR DELETE ON sources FOR EACH ROW EXECUTE FUNCTION emit_memory_change_feed_event();
--> statement-breakpoint
CREATE TRIGGER memory_change_feed_nodes AFTER INSERT OR UPDATE OR DELETE ON nodes FOR EACH ROW EXECUTE FUNCTION emit_memory_change_feed_event();
--> statement-breakpoint
CREATE TRIGGER memory_change_feed_redirects AFTER INSERT OR UPDATE OR DELETE ON node_redirects FOR EACH ROW EXECUTE FUNCTION emit_memory_change_feed_event();
--> statement-breakpoint
CREATE TRIGGER memory_change_feed_source_links AFTER INSERT OR UPDATE OR DELETE ON source_links FOR EACH ROW EXECUTE FUNCTION emit_memory_change_feed_event();
--> statement-breakpoint

-- The migration transaction holds the DDL locks acquired above until commit.
-- Build the initial feed in bulk; repeatedly updating a head in one transaction
-- accumulates row versions and makes a large backfill progressively slower.
DO $$
DECLARE
	v_count bigint;
BEGIN
	RAISE NOTICE 'memory_migration:0029:backfill_preparing';
	CREATE TEMP TABLE initial_memory_feed ON COMMIT DROP AS
	SELECT *, row_number() OVER (
		PARTITION BY user_id, partition_key ORDER BY phase, sort_id, subphase
	) AS sequence
	FROM (
		SELECT user_id, partition_key, 1 AS phase, id AS sort_id, 1 AS subphase,
			'node'::text AS kind, 'snapshot'::text AS action, 'node'::text AS entity_type,
			id AS entity_id, NULL::text AS source_id, COALESCE(created_at, now()) AS effective_change_time,
			NULL::jsonb AS provenance, NULL::jsonb AS freshness, NULL::text AS status,
			jsonb_build_object('backfill', true, 'nodeId', id) AS payload
		FROM nodes
		UNION ALL
		SELECT user_id, partition_key, 2, id, event.subphase,
			event.kind, event.action, 'source', id, id,
			COALESCE(last_ingested_at, created_at, now()),
			jsonb_build_object('type', type, 'externalId', external_id),
			jsonb_build_object('status', status, 'lastIngestedAt', last_ingested_at),
			status, event.payload
		FROM sources
		CROSS JOIN LATERAL (VALUES
			(1, 'source', 'snapshot', jsonb_build_object('backfill', true, 'sourceId', id, 'metadata', metadata)),
			(2, 'ingestion', COALESCE(status, 'pending'), jsonb_build_object('backfill', true, 'sourceId', id))
		) AS event(subphase, kind, action, payload)
		UNION ALL
		SELECT user_id, partition_key, 3, id, event.subphase,
			event.kind, 'snapshot', event.kind, event.entity_id, source_id,
			COALESCE(created_at, now()), event.provenance, NULL::jsonb, status, event.payload
		FROM claims
		CROSS JOIN LATERAL (VALUES
			(1, 'claim', id,
				jsonb_build_object('sourceId', source_id, 'assertedByKind', asserted_by_kind, 'scope', scope),
				jsonb_build_object('backfill', true, 'claimId', id)),
			(2, 'commitment', subject_node_id,
				jsonb_build_object('sourceId', source_id, 'predicate', predicate),
				jsonb_build_object('backfill', true, 'claimId', id, 'predicate', predicate))
		) AS event(subphase, kind, entity_id, provenance, payload)
		WHERE event.subphase = 1 OR predicate IN ('HAS_TASK_STATUS', 'ASSIGNED_TO', 'DUE_ON')
		UNION ALL
		SELECT user_id, partition_key, 4, from_node_id, 1,
			'redirect', 'snapshot', 'redirect', from_node_id, NULL::text,
			COALESCE(created_at, now()),
			jsonb_build_object('fromNodeId', from_node_id, 'toNodeId', to_node_id),
			NULL::jsonb, NULL::text, jsonb_build_object('backfill', true)
		FROM node_redirects
		UNION ALL
		SELECT s.user_id, s.partition_key, 5, sl.id, 1,
			'provenance', 'attached', 'source_link', sl.id, sl.source_id,
			COALESCE(sl.created_at, now()),
			jsonb_build_object('sourceId', sl.source_id, 'nodeId', sl.node_id),
			NULL::jsonb, NULL::text, jsonb_build_object('backfill', true, 'sourceLinkId', sl.id)
		FROM source_links sl JOIN sources s ON s.id = sl.source_id
	) events;

	GET DIAGNOSTICS v_count = ROW_COUNT;
	RAISE NOTICE 'memory_migration:0029:backfill_prepared:%', v_count;

	INSERT INTO memory_change_feed_heads (id, user_id, partition_key, next_sequence)
	SELECT 'mcfh_' || md5(jsonb_build_array(user_id, partition_key)::text),
		user_id, partition_key, max(sequence) + 1
	FROM initial_memory_feed
	GROUP BY user_id, partition_key;

	RAISE NOTICE 'memory_migration:0029:backfill_inserting:%', v_count;
	INSERT INTO memory_change_feed_events (
		event_id, user_id, partition_key, feed_epoch, sequence, kind, action,
		entity_type, entity_id, source_id, effective_change_time, provenance,
		freshness, status, payload
	)
	SELECT 'mcfe_' || md5(jsonb_build_array(user_id, partition_key, 1, sequence)::text),
		user_id, partition_key, 1, sequence, kind, action,
		entity_type, entity_id, source_id, effective_change_time, provenance,
		freshness, status, payload
	FROM initial_memory_feed
	ORDER BY user_id, partition_key NULLS FIRST, sequence;

	GET DIAGNOSTICS v_count = ROW_COUNT;
	RAISE NOTICE 'memory_migration:0029:backfill_inserted:%', v_count;

	-- Verify every event class, including secondary source and commitment events.
	IF (SELECT count(*) FROM nodes) <> (SELECT count(*) FROM memory_change_feed_events WHERE kind = 'node')
		OR (SELECT count(*) FROM sources) <> (SELECT count(*) FROM memory_change_feed_events WHERE kind = 'source')
		OR (SELECT count(*) FROM sources) <> (SELECT count(*) FROM memory_change_feed_events WHERE kind = 'ingestion')
		OR (SELECT count(*) FROM claims) <> (SELECT count(*) FROM memory_change_feed_events WHERE kind = 'claim')
		OR (SELECT count(*) FROM claims WHERE predicate IN ('HAS_TASK_STATUS', 'ASSIGNED_TO', 'DUE_ON')) <> (SELECT count(*) FROM memory_change_feed_events WHERE kind = 'commitment')
		OR (SELECT count(*) FROM node_redirects) <> (SELECT count(*) FROM memory_change_feed_events WHERE kind = 'redirect')
		OR (SELECT count(*) FROM source_links) <> (SELECT count(*) FROM memory_change_feed_events WHERE kind = 'provenance')
	THEN
		RAISE EXCEPTION 'lifecycle feed backfill conservation check failed';
	END IF;
	RAISE NOTICE 'memory_migration:0029:backfill_verified:%', v_count;
END;
$$;
