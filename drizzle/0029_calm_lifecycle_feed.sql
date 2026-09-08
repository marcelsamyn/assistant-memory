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

-- Deterministic initial backfill. Triggers are installed above before any
-- snapshot is appended, so a concurrent writer is serialized by the same
-- per-partition head lock and cannot be skipped between the two phases.
DO $$
DECLARE
	row_data record;
BEGIN
	FOR row_data IN
		SELECT id, user_id, partition_key, created_at
		FROM nodes
		ORDER BY user_id, partition_key NULLS FIRST, id
	LOOP
		PERFORM append_memory_change_feed_event(
			row_data.user_id, row_data.partition_key, 'node', 'snapshot',
			'node', row_data.id, NULL, row_data.created_at, NULL, NULL, NULL,
			jsonb_build_object('backfill', true, 'nodeId', row_data.id)
		);
	END LOOP;

	FOR row_data IN
		SELECT id, user_id, partition_key, type, external_id, status,
			created_at, last_ingested_at, metadata
		FROM sources
		ORDER BY user_id, partition_key NULLS FIRST, id
	LOOP
		PERFORM append_memory_change_feed_event(
			row_data.user_id, row_data.partition_key, 'source', 'snapshot',
			'source', row_data.id, row_data.id,
			COALESCE(row_data.last_ingested_at, row_data.created_at),
			jsonb_build_object('type', row_data.type, 'externalId', row_data.external_id),
			jsonb_build_object('status', row_data.status, 'lastIngestedAt', row_data.last_ingested_at),
			row_data.status,
			jsonb_build_object('backfill', true, 'sourceId', row_data.id, 'metadata', row_data.metadata)
		);
		PERFORM append_memory_change_feed_event(
			row_data.user_id, row_data.partition_key, 'ingestion', COALESCE(row_data.status, 'pending'),
			'source', row_data.id, row_data.id,
			COALESCE(row_data.last_ingested_at, row_data.created_at),
			jsonb_build_object('type', row_data.type, 'externalId', row_data.external_id),
			jsonb_build_object('status', row_data.status, 'lastIngestedAt', row_data.last_ingested_at),
			row_data.status,
			jsonb_build_object('backfill', true, 'sourceId', row_data.id)
		);
	END LOOP;

	FOR row_data IN
		SELECT id, user_id, partition_key, predicate, subject_node_id,
			object_node_id, source_id, status, asserted_by_kind, scope, created_at
		FROM claims
		ORDER BY user_id, partition_key NULLS FIRST, id
	LOOP
		PERFORM append_memory_change_feed_event(
			row_data.user_id, row_data.partition_key, 'claim', 'snapshot',
			'claim', row_data.id, row_data.source_id, row_data.created_at,
			jsonb_build_object('sourceId', row_data.source_id, 'assertedByKind', row_data.asserted_by_kind, 'scope', row_data.scope),
			NULL, row_data.status,
			jsonb_build_object('backfill', true, 'claimId', row_data.id)
		);
		IF row_data.predicate IN ('HAS_TASK_STATUS', 'ASSIGNED_TO', 'DUE_ON') THEN
			PERFORM append_memory_change_feed_event(
				row_data.user_id, row_data.partition_key, 'commitment', 'snapshot',
				'commitment', row_data.subject_node_id, row_data.source_id, row_data.created_at,
				jsonb_build_object('sourceId', row_data.source_id, 'predicate', row_data.predicate),
				NULL, row_data.status,
				jsonb_build_object('backfill', true, 'claimId', row_data.id, 'predicate', row_data.predicate)
			);
		END IF;
	END LOOP;

	FOR row_data IN
		SELECT r.user_id, r.partition_key, r.from_node_id, r.to_node_id, r.created_at
		FROM node_redirects r
		ORDER BY r.user_id, r.partition_key NULLS FIRST, r.from_node_id
	LOOP
		PERFORM append_memory_change_feed_event(
			row_data.user_id, row_data.partition_key, 'redirect', 'snapshot',
			'redirect', row_data.from_node_id, NULL, row_data.created_at,
			jsonb_build_object('fromNodeId', row_data.from_node_id, 'toNodeId', row_data.to_node_id),
			NULL, NULL, jsonb_build_object('backfill', true)
		);
	END LOOP;

	FOR row_data IN
		SELECT sl.id, s.user_id, s.partition_key, sl.source_id, sl.node_id, sl.created_at
		FROM source_links sl
		JOIN sources s ON s.id = sl.source_id
		ORDER BY s.user_id, s.partition_key NULLS FIRST, sl.id
	LOOP
		PERFORM append_memory_change_feed_event(
			row_data.user_id, row_data.partition_key, 'provenance', 'attached',
			'source_link', row_data.id, row_data.source_id, row_data.created_at,
			jsonb_build_object('sourceId', row_data.source_id, 'nodeId', row_data.node_id),
			NULL, NULL, jsonb_build_object('backfill', true, 'sourceLinkId', row_data.id)
		);
	END LOOP;

	-- Conservation checks make a partial migration fail closed instead of
	-- presenting a deceptively complete feed to the first consumer.
	IF (SELECT count(*) FROM nodes) <> (SELECT count(*) FROM memory_change_feed_events WHERE kind = 'node' AND payload->>'backfill' = 'true')
		OR (SELECT count(*) FROM sources) <> (SELECT count(*) FROM memory_change_feed_events WHERE kind = 'source' AND payload->>'backfill' = 'true')
		OR (SELECT count(*) FROM claims) <> (SELECT count(*) FROM memory_change_feed_events WHERE kind = 'claim' AND payload->>'backfill' = 'true')
		OR (SELECT count(*) FROM node_redirects) <> (SELECT count(*) FROM memory_change_feed_events WHERE kind = 'redirect' AND payload->>'backfill' = 'true')
		OR (SELECT count(*) FROM source_links) <> (SELECT count(*) FROM memory_change_feed_events WHERE kind = 'provenance' AND payload->>'backfill' = 'true')
	THEN
		RAISE EXCEPTION 'lifecycle feed backfill conservation check failed';
	END IF;
END;
$$;
