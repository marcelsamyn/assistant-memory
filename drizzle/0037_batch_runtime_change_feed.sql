ALTER TABLE "source_blob_uploads" DROP CONSTRAINT "source_blob_uploads_state_ck";
--> statement-breakpoint
ALTER TABLE "source_blob_uploads" ADD CONSTRAINT "source_blob_uploads_state_ck" CHECK ("state" IN ('reserved', 'uploading', 'upload_unknown', 'uploaded', 'cleanup_pending', 'cleanup_completed'));
--> statement-breakpoint
-- Collect row events without rewriting the feed head for every row. Statement
-- triggers flush before control returns to the caller, including nested writes.
CREATE FUNCTION prepare_memory_change_feed_batch() RETURNS trigger AS $$
BEGIN
	IF to_regclass('pg_temp.memory_change_feed_pending') IS NULL THEN
		CREATE TEMP TABLE memory_change_feed_pending (
			position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
			user_id text NOT NULL,
			partition_key varchar(200),
			kind varchar(32) NOT NULL,
			action varchar(40) NOT NULL,
			entity_type varchar(32) NOT NULL,
			entity_id text,
			source_id text,
			effective_change_time timestamptz,
			provenance jsonb,
			freshness jsonb,
			status varchar(30),
			payload jsonb
		) ON COMMIT DELETE ROWS;
	END IF;
	-- Do not clear an existing queue: a nested statement or ON CONFLICT can
	-- invoke another BEFORE STATEMENT trigger while earlier row events await flush.
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION queue_memory_change_feed_event(
	p_user_id text, p_partition_key varchar, p_kind varchar, p_action varchar,
	p_entity_type varchar, p_entity_id text, p_source_id text,
	p_effective_change_time timestamptz, p_provenance jsonb, p_freshness jsonb,
	p_status varchar, p_payload jsonb
) RETURNS void AS $$
BEGIN
	INSERT INTO pg_temp.memory_change_feed_pending (
		user_id, partition_key, kind, action, entity_type, entity_id, source_id,
		effective_change_time, provenance, freshness, status, payload
	) VALUES (
		p_user_id, p_partition_key, p_kind, p_action, p_entity_type, p_entity_id,
		p_source_id, COALESCE(p_effective_change_time, now()), p_provenance,
		p_freshness, p_status, COALESCE(p_payload, '{}'::jsonb)
	);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION flush_memory_change_feed_batch() RETURNS trigger AS $$
DECLARE
	v_partition record;
	v_feed_epoch integer;
	v_next_sequence bigint;
BEGIN
	FOR v_partition IN
		SELECT user_id, partition_key, count(*) AS event_count
		FROM pg_temp.memory_change_feed_pending
		GROUP BY user_id, partition_key
		ORDER BY user_id, partition_key NULLS FIRST
	LOOP
		INSERT INTO memory_change_feed_heads (id, user_id, partition_key)
		VALUES (
			'mcfh_' || md5(jsonb_build_array(v_partition.user_id, v_partition.partition_key)::text),
			v_partition.user_id, v_partition.partition_key
		) ON CONFLICT (user_id, partition_key) DO NOTHING;

		-- Retain the original commit-safe allocation boundary. Locks remain held
		-- until transaction end; direct append callers use these same head rows.
		SELECT feed_epoch, next_sequence INTO v_feed_epoch, v_next_sequence
		FROM memory_change_feed_heads
		WHERE user_id = v_partition.user_id
			AND partition_key IS NOT DISTINCT FROM v_partition.partition_key
		FOR UPDATE;

		INSERT INTO memory_change_feed_events (
			event_id, user_id, partition_key, feed_epoch, sequence, kind, action,
			entity_type, entity_id, source_id, effective_change_time, provenance,
			freshness, status, payload
		)
		SELECT
			'mcfe_' || md5(jsonb_build_array(user_id, partition_key, v_feed_epoch, sequence)::text),
			user_id, partition_key, v_feed_epoch, sequence, kind, action,
			entity_type, entity_id, source_id, effective_change_time, provenance,
			freshness, status, payload
		FROM (
			SELECT pending.*, v_next_sequence - 1 + row_number() OVER (ORDER BY position) AS sequence
			FROM pg_temp.memory_change_feed_pending pending
			WHERE user_id = v_partition.user_id
				AND partition_key IS NOT DISTINCT FROM v_partition.partition_key
		) numbered
		ORDER BY sequence;

		UPDATE memory_change_feed_heads
		SET next_sequence = v_next_sequence + v_partition.event_count, updated_at = now()
		WHERE user_id = v_partition.user_id
			AND partition_key IS NOT DISTINCT FROM v_partition.partition_key;
	END LOOP;
	DELETE FROM pg_temp.memory_change_feed_pending;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION emit_memory_change_feed_event() RETURNS trigger AS $$
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
			PERFORM queue_memory_change_feed_event(v_user_id, v_partition_key, v_kind, v_action, v_entity_type, v_entity_id, v_source_id, v_effective_change_time, v_provenance, NULL, v_status, v_payload);
		END IF;
		IF COALESCE(to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'predicate', '') IN ('HAS_TASK_STATUS', 'ASSIGNED_TO', 'DUE_ON') AND NOT (TG_OP = 'UPDATE' AND NEW.partition_key IS DISTINCT FROM OLD.partition_key) THEN
			PERFORM queue_memory_change_feed_event(
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
			PERFORM queue_memory_change_feed_event(OLD.user_id, OLD.partition_key, 'deletion', 'tombstone', v_entity_type, v_entity_id, v_source_id, now(), v_provenance, NULL, OLD.status, jsonb_build_object('reclassified', true, 'toPartition', NEW.partition_key, 'claim', to_jsonb(OLD)));
			PERFORM queue_memory_change_feed_event(NEW.user_id, NEW.partition_key, 'claim', 'snapshot', v_entity_type, v_entity_id, v_source_id, v_effective_change_time, v_provenance, NULL, NEW.status, jsonb_build_object('reclassified', true, 'fromPartition', OLD.partition_key, 'claim', to_jsonb(NEW)));
			IF COALESCE(to_jsonb(OLD)->>'predicate', '') IN ('HAS_TASK_STATUS', 'ASSIGNED_TO', 'DUE_ON') THEN
				PERFORM queue_memory_change_feed_event(OLD.user_id, OLD.partition_key, 'deletion', 'tombstone', 'commitment', to_jsonb(OLD)->>'subject_node_id', v_source_id, now(), v_provenance, NULL, OLD.status, jsonb_build_object('reclassified', true, 'toPartition', NEW.partition_key, 'claim', to_jsonb(OLD)));
			END IF;
			IF COALESCE(to_jsonb(NEW)->>'predicate', '') IN ('HAS_TASK_STATUS', 'ASSIGNED_TO', 'DUE_ON') THEN
				PERFORM queue_memory_change_feed_event(NEW.user_id, NEW.partition_key, 'commitment', 'snapshot', 'commitment', to_jsonb(NEW)->>'subject_node_id', v_source_id, v_effective_change_time, v_provenance, NULL, NEW.status, jsonb_build_object('reclassified', true, 'fromPartition', OLD.partition_key, 'claim', to_jsonb(NEW)));
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
			PERFORM queue_memory_change_feed_event(OLD.user_id, OLD.partition_key, 'deletion', 'tombstone', v_entity_type, v_entity_id, v_source_id, now(), v_provenance, v_freshness, OLD.status, jsonb_build_object('reclassified', true, 'toPartition', NEW.partition_key, 'source', to_jsonb(OLD)));
			PERFORM queue_memory_change_feed_event(NEW.user_id, NEW.partition_key, 'source', 'snapshot', v_entity_type, v_entity_id, v_source_id, v_effective_change_time, v_provenance, v_freshness, NEW.status, jsonb_build_object('reclassified', true, 'fromPartition', OLD.partition_key, 'source', to_jsonb(NEW)));
			FOR v_link IN
				SELECT sl.id, sl.source_id, sl.node_id, sl.created_at
				FROM source_links sl
				WHERE sl.source_id = NEW.id
				ORDER BY sl.id
			LOOP
				PERFORM queue_memory_change_feed_event(
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
				PERFORM queue_memory_change_feed_event(
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
			PERFORM queue_memory_change_feed_event(v_user_id, v_partition_key, v_kind, v_action, v_entity_type, v_entity_id, v_source_id, v_effective_change_time, v_provenance, v_freshness, v_status, v_payload);
		END IF;
		IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
			PERFORM queue_memory_change_feed_event(v_user_id, v_partition_key, 'ingestion', NEW.status, 'source', v_entity_id, v_source_id, v_effective_change_time, v_provenance, v_freshness, NEW.status, v_payload);
		END IF;
		IF TG_OP = 'UPDATE' AND NEW.last_ingested_at IS DISTINCT FROM OLD.last_ingested_at THEN
			PERFORM queue_memory_change_feed_event(v_user_id, v_partition_key, 'freshness', 'changed', 'source', v_entity_id, v_source_id, NEW.last_ingested_at, v_provenance, v_freshness, NEW.status, v_payload);
		END IF;
	ELSIF TG_TABLE_NAME = 'nodes' THEN
		v_kind := CASE WHEN TG_OP = 'DELETE' THEN 'deletion' ELSE 'node' END;
		v_action := CASE WHEN TG_OP = 'DELETE' THEN 'tombstone' WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'updated' END;
		v_entity_type := 'node';
		IF TG_OP = 'UPDATE' AND NEW.partition_key IS DISTINCT FROM OLD.partition_key THEN
			PERFORM queue_memory_change_feed_event(OLD.user_id, OLD.partition_key, 'deletion', 'tombstone', v_entity_type, v_entity_id, NULL, now(), NULL, NULL, NULL, jsonb_build_object('reclassified', true, 'toPartition', NEW.partition_key));
			PERFORM queue_memory_change_feed_event(NEW.user_id, NEW.partition_key, 'node', 'snapshot', v_entity_type, v_entity_id, NULL, v_effective_change_time, NULL, NULL, NULL, jsonb_build_object('reclassified', true, 'fromPartition', OLD.partition_key, 'node', to_jsonb(NEW)));
		ELSE
			PERFORM queue_memory_change_feed_event(v_user_id, v_partition_key, v_kind, v_action, v_entity_type, v_entity_id, NULL, v_effective_change_time, NULL, NULL, NULL, v_payload);
		END IF;
	ELSIF TG_TABLE_NAME = 'node_redirects' THEN
		v_kind := CASE WHEN TG_OP = 'DELETE' THEN 'deletion' ELSE 'redirect' END;
		v_action := CASE WHEN TG_OP = 'DELETE' THEN 'tombstone' WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'updated' END;
		v_entity_type := 'redirect';
		IF TG_OP = 'UPDATE' AND NEW.partition_key IS DISTINCT FROM OLD.partition_key THEN
			PERFORM queue_memory_change_feed_event(
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
			PERFORM queue_memory_change_feed_event(
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
			PERFORM queue_memory_change_feed_event(v_user_id, v_partition_key, v_kind, v_action, v_entity_type, v_entity_id, NULL, v_effective_change_time, jsonb_build_object('fromNodeId', to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'from_node_id', 'toNodeId', to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'to_node_id'), NULL, NULL, v_payload);
		END IF;
	ELSIF TG_TABLE_NAME = 'source_links' THEN
		v_kind := CASE WHEN TG_OP = 'DELETE' THEN 'deletion' ELSE 'provenance' END;
		v_action := CASE WHEN TG_OP = 'DELETE' THEN 'tombstone' WHEN TG_OP = 'INSERT' THEN 'attached' ELSE 'updated' END;
		v_entity_type := 'source_link';
		v_source_id := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'source_id';
		PERFORM queue_memory_change_feed_event(v_user_id, v_partition_key, v_kind, v_action, v_entity_type, v_entity_id, v_source_id, v_effective_change_time, jsonb_build_object('sourceId', v_source_id, 'nodeId', to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'node_id'), NULL, NULL, v_payload);
	END IF;
	IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER memory_change_feed_batch_prepare
BEFORE INSERT OR UPDATE OR DELETE ON claims FOR EACH STATEMENT EXECUTE FUNCTION prepare_memory_change_feed_batch();
--> statement-breakpoint
CREATE TRIGGER memory_change_feed_batch_flush
AFTER INSERT OR UPDATE OR DELETE ON claims FOR EACH STATEMENT EXECUTE FUNCTION flush_memory_change_feed_batch();
--> statement-breakpoint
CREATE TRIGGER memory_change_feed_batch_prepare
BEFORE INSERT OR UPDATE OR DELETE ON sources FOR EACH STATEMENT EXECUTE FUNCTION prepare_memory_change_feed_batch();
--> statement-breakpoint
CREATE TRIGGER memory_change_feed_batch_flush
AFTER INSERT OR UPDATE OR DELETE ON sources FOR EACH STATEMENT EXECUTE FUNCTION flush_memory_change_feed_batch();
--> statement-breakpoint
CREATE TRIGGER memory_change_feed_batch_prepare
BEFORE INSERT OR UPDATE OR DELETE ON nodes FOR EACH STATEMENT EXECUTE FUNCTION prepare_memory_change_feed_batch();
--> statement-breakpoint
CREATE TRIGGER memory_change_feed_batch_flush
AFTER INSERT OR UPDATE OR DELETE ON nodes FOR EACH STATEMENT EXECUTE FUNCTION flush_memory_change_feed_batch();
--> statement-breakpoint
CREATE TRIGGER memory_change_feed_batch_prepare
BEFORE INSERT OR UPDATE OR DELETE ON node_redirects FOR EACH STATEMENT EXECUTE FUNCTION prepare_memory_change_feed_batch();
--> statement-breakpoint
CREATE TRIGGER memory_change_feed_batch_flush
AFTER INSERT OR UPDATE OR DELETE ON node_redirects FOR EACH STATEMENT EXECUTE FUNCTION flush_memory_change_feed_batch();
--> statement-breakpoint
CREATE TRIGGER memory_change_feed_batch_prepare
BEFORE INSERT OR UPDATE OR DELETE ON source_links FOR EACH STATEMENT EXECUTE FUNCTION prepare_memory_change_feed_batch();
--> statement-breakpoint
CREATE TRIGGER memory_change_feed_batch_flush
AFTER INSERT OR UPDATE OR DELETE ON source_links FOR EACH STATEMENT EXECUTE FUNCTION flush_memory_change_feed_batch();
