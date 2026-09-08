CREATE TABLE "memory_partitions" (
	"user_id" text NOT NULL,
	"partition_key" varchar(200) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_partitions_user_id_partition_key_pk" PRIMARY KEY("user_id","partition_key"),
	CONSTRAINT "memory_partitions_status_ck" CHECK ("status" IN ('active', 'quarantined'))
);
--> statement-breakpoint
CREATE TABLE "partition_artifact_receipts" (
	"user_id" text NOT NULL,
	"source_node_id" text NOT NULL,
	"partition_key" varchar(200) NOT NULL,
	"artifact_kind" varchar(40) NOT NULL,
	"disposition" varchar(24) NOT NULL,
	"source_count" integer NOT NULL,
	"rebuilt_count" integer NOT NULL,
	"quarantined_count" integer NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partition_artifact_receipts_user_id_source_node_id_partition_key_artifact_kind_pk" PRIMARY KEY("user_id","source_node_id","partition_key","artifact_kind"),
	CONSTRAINT "partition_artifact_receipts_kind_ck" CHECK ("artifact_kind" IN ('aliases', 'node_embeddings', 'redirects', 'summary', 'user_profile', 'commitment_presentation')),
	CONSTRAINT "partition_artifact_receipts_disposition_ck" CHECK ("disposition" IN ('pending', 'rebuilt', 'quarantined', 'not_applicable')),
	CONSTRAINT "partition_artifact_receipts_counts_ck" CHECK ("source_count" >= 0 AND "rebuilt_count" >= 0 AND "quarantined_count" >= 0 AND "rebuilt_count" + "quarantined_count" <= "source_count"),
	CONSTRAINT "partition_artifact_receipts_terminal_counts_ck" CHECK ("disposition" = 'pending' OR "rebuilt_count" + "quarantined_count" = "source_count")
);
--> statement-breakpoint
CREATE TABLE "partition_migration_state" (
	"user_id" text PRIMARY KEY NOT NULL,
	"state" varchar(20) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partition_migration_state_state_ck" CHECK ("state" IN ('migrating', 'migrated')),
	CONSTRAINT "partition_migration_state_version_ck" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE TABLE "partition_node_mappings" (
	"user_id" text NOT NULL,
	"source_node_id" text NOT NULL,
	"partition_key" varchar(200) NOT NULL,
	"replacement_node_id" text,
	"source_id" text NOT NULL,
	"binding_generation" varchar(200) NOT NULL,
	"state" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partition_node_mappings_user_id_source_node_id_partition_key_pk" PRIMARY KEY("user_id","source_node_id","partition_key"),
	CONSTRAINT "partition_node_mappings_state_ck" CHECK ("state" IN ('quarantined', 'completed')),
	CONSTRAINT "partition_node_mappings_completion_ck" CHECK ("state" <> 'completed' OR "replacement_node_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "source_partition_commands" (
	"user_id" text NOT NULL,
	"binding_generation" varchar(200) NOT NULL,
	"source_id" text NOT NULL,
	"expected_partition_key" varchar(200),
	"target_partition_key" varchar(200) NOT NULL,
	"expected_source_version" integer NOT NULL,
	"source_version" integer NOT NULL,
	"moved_claim_count" integer NOT NULL,
	"node_mappings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_partition_commands_user_id_binding_generation_pk" PRIMARY KEY("user_id","binding_generation"),
	CONSTRAINT "source_partition_commands_source_version_unique" UNIQUE("user_id","source_id","source_version"),
	CONSTRAINT "source_partition_commands_versions_ck" CHECK ("expected_source_version" >= 0 AND "source_version" = "expected_source_version" + 1),
	CONSTRAINT "source_partition_commands_claim_count_ck" CHECK ("moved_claim_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "aliases" ADD COLUMN "partition_key" varchar(200);--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "partition_key" varchar(200);--> statement-breakpoint
ALTER TABLE "node_redirects" ADD COLUMN "partition_key" varchar(200);--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "partition_key" varchar(200);--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "partition_key" varchar(200);--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_partition_commands" ADD COLUMN "source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rollup_state" DROP CONSTRAINT "rollup_state_pkey";--> statement-breakpoint
ALTER TABLE "rollup_state" ADD COLUMN "partition_key" varchar(200);--> statement-breakpoint
ALTER TABLE "rollup_state" ADD CONSTRAINT "rollup_state_user_partition_unique" UNIQUE NULLS NOT DISTINCT("user_id","partition_key");--> statement-breakpoint
ALTER TABLE "memory_partitions" ADD CONSTRAINT "memory_partitions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partition_artifact_receipts" ADD CONSTRAINT "partition_artifact_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partition_migration_state" ADD CONSTRAINT "partition_migration_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partition_node_mappings" ADD CONSTRAINT "partition_node_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_partition_commands" ADD CONSTRAINT "source_partition_commands_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partition_node_mappings_replacement_idx" ON "partition_node_mappings" USING btree ("user_id","replacement_node_id");--> statement-breakpoint
CREATE INDEX "aliases_user_partition_normalized_idx" ON "aliases" USING btree ("user_id","partition_key","normalized_alias_text");--> statement-breakpoint
CREATE INDEX "claims_user_partition_status_stated_at_idx" ON "claims" USING btree ("user_id","partition_key","status","stated_at");--> statement-breakpoint
CREATE INDEX "nodes_user_partition_idx" ON "nodes" USING btree ("user_id","partition_key");--> statement-breakpoint
CREATE INDEX "sources_user_partition_idx" ON "sources" USING btree ("user_id","partition_key");--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_version_ck" CHECK ("version" >= 0);--> statement-breakpoint

-- Source version is the authoritative ABA fence. Protected mutations are:
-- partition_key, parent_source, scope, type, external_id, metadata,
-- last_ingested_at, status, deleted_at, content_type, and content_length.
CREATE FUNCTION enforce_source_version() RETURNS trigger AS $$
DECLARE
	protected_change boolean;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.version <> 0 THEN
			RAISE EXCEPTION 'new sources must start at version 0' USING ERRCODE = '23514';
		END IF;
		RETURN NEW;
	END IF;

	protected_change :=
		NEW.partition_key IS DISTINCT FROM OLD.partition_key OR
		NEW.parent_source IS DISTINCT FROM OLD.parent_source OR
		NEW.scope IS DISTINCT FROM OLD.scope OR
		NEW.type IS DISTINCT FROM OLD.type OR
		NEW.external_id IS DISTINCT FROM OLD.external_id OR
		NEW.metadata IS DISTINCT FROM OLD.metadata OR
		NEW.last_ingested_at IS DISTINCT FROM OLD.last_ingested_at OR
		NEW.status IS DISTINCT FROM OLD.status OR
		NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR
		NEW.content_type IS DISTINCT FROM OLD.content_type OR
		NEW.content_length IS DISTINCT FROM OLD.content_length;

	IF protected_change THEN
		NEW.version := OLD.version + 1;
	ELSIF NEW.version IS DISTINCT FROM OLD.version THEN
		RAISE EXCEPTION 'source version is database-managed' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER sources_authoritative_version
	BEFORE INSERT OR UPDATE ON sources
	FOR EACH ROW EXECUTE FUNCTION enforce_source_version();--> statement-breakpoint

CREATE FUNCTION assert_active_memory_partition(
	p_user_id text,
	p_partition_key varchar,
	p_entity text
) RETURNS void AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM partition_migration_state WHERE user_id = p_user_id
	) THEN
		IF p_partition_key IS NULL THEN
			RAISE EXCEPTION '% requires a partition after migration starts', p_entity
				USING ERRCODE = '23514';
		END IF;
		IF NOT EXISTS (
			SELECT 1 FROM memory_partitions
			WHERE user_id = p_user_id
				AND partition_key = p_partition_key
				AND status = 'active'
		) THEN
			RAISE EXCEPTION '% references an inactive or unregistered partition', p_entity
				USING ERRCODE = '23514';
		END IF;
	END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE FUNCTION validate_partitioned_entity() RETURNS trigger AS $$
DECLARE
	referenced_partition varchar;
	referenced_user text;
BEGIN
	PERFORM assert_active_memory_partition(NEW.user_id, NEW.partition_key, TG_TABLE_NAME);

	IF TG_TABLE_NAME = 'sources' AND to_jsonb(NEW)->>'parent_source' IS NOT NULL THEN
		SELECT user_id, partition_key INTO referenced_user, referenced_partition
		FROM sources WHERE id = to_jsonb(NEW)->>'parent_source';
		IF referenced_user IS DISTINCT FROM NEW.user_id OR referenced_partition IS DISTINCT FROM NEW.partition_key THEN
			RAISE EXCEPTION 'source parent must be in the same user partition' USING ERRCODE = '23514';
		END IF;
	ELSIF TG_TABLE_NAME = 'aliases' THEN
		SELECT user_id, partition_key INTO referenced_user, referenced_partition
		FROM nodes WHERE id = to_jsonb(NEW)->>'canonical_node_id';
		IF referenced_user IS DISTINCT FROM NEW.user_id OR referenced_partition IS DISTINCT FROM NEW.partition_key THEN
			RAISE EXCEPTION 'alias and canonical node must be in the same user partition' USING ERRCODE = '23514';
		END IF;
	ELSIF TG_TABLE_NAME = 'node_redirects' THEN
		SELECT user_id, partition_key INTO referenced_user, referenced_partition
		FROM nodes WHERE id = to_jsonb(NEW)->>'to_node_id';
		IF referenced_user IS DISTINCT FROM NEW.user_id OR referenced_partition IS DISTINCT FROM NEW.partition_key THEN
			RAISE EXCEPTION 'redirect and target node must be in the same user partition' USING ERRCODE = '23514';
		END IF;
	ELSIF TG_TABLE_NAME = 'claims' THEN
		IF EXISTS (
			SELECT 1 FROM sources
			WHERE id = to_jsonb(NEW)->>'source_id'
				AND (user_id IS DISTINCT FROM NEW.user_id OR partition_key IS DISTINCT FROM NEW.partition_key)
		) OR EXISTS (
			SELECT 1 FROM nodes
			WHERE id IN (
				to_jsonb(NEW)->>'subject_node_id',
				to_jsonb(NEW)->>'object_node_id',
				to_jsonb(NEW)->>'asserted_by_node_id'
			)
				AND (user_id IS DISTINCT FROM NEW.user_id OR partition_key IS DISTINCT FROM NEW.partition_key)
		) THEN
			RAISE EXCEPTION 'claim evidence must remain in one user partition' USING ERRCODE = '23514';
		END IF;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER nodes_partition_integrity
	AFTER INSERT OR UPDATE ON nodes
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	EXECUTE FUNCTION validate_partitioned_entity();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sources_partition_integrity
	AFTER INSERT OR UPDATE ON sources
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	EXECUTE FUNCTION validate_partitioned_entity();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER claims_partition_integrity
	AFTER INSERT OR UPDATE ON claims
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	EXECUTE FUNCTION validate_partitioned_entity();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER aliases_partition_integrity
	AFTER INSERT OR UPDATE ON aliases
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	EXECUTE FUNCTION validate_partitioned_entity();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER node_redirects_partition_integrity
	AFTER INSERT OR UPDATE ON node_redirects
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	EXECUTE FUNCTION validate_partitioned_entity();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER rollup_state_partition_integrity
	AFTER INSERT OR UPDATE ON rollup_state
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	EXECUTE FUNCTION validate_partitioned_entity();--> statement-breakpoint

CREATE FUNCTION validate_source_link_partition() RETURNS trigger AS $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM sources s
		JOIN nodes n ON n.id = NEW.node_id
		WHERE s.id = NEW.source_id
			AND (s.user_id IS DISTINCT FROM n.user_id OR s.partition_key IS DISTINCT FROM n.partition_key)
	) THEN
		RAISE EXCEPTION 'source link endpoints must be in the same user partition' USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER source_links_partition_integrity
	AFTER INSERT OR UPDATE OF source_id, node_id ON source_links
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	EXECUTE FUNCTION validate_source_link_partition();--> statement-breakpoint

CREATE FUNCTION validate_node_partition_dependents() RETURNS trigger AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM source_links sl JOIN sources s ON s.id = sl.source_id
		WHERE sl.node_id = NEW.id
			AND (s.user_id IS DISTINCT FROM NEW.user_id OR s.partition_key IS DISTINCT FROM NEW.partition_key)
	) OR EXISTS (
		SELECT 1 FROM claims c
		WHERE NEW.id IN (c.subject_node_id, c.object_node_id, c.asserted_by_node_id)
			AND (c.user_id IS DISTINCT FROM NEW.user_id OR c.partition_key IS DISTINCT FROM NEW.partition_key)
	) OR EXISTS (
		SELECT 1 FROM aliases a WHERE a.canonical_node_id = NEW.id
			AND (a.user_id IS DISTINCT FROM NEW.user_id OR a.partition_key IS DISTINCT FROM NEW.partition_key)
	) OR EXISTS (
		SELECT 1 FROM node_redirects r WHERE r.to_node_id = NEW.id
			AND (r.user_id IS DISTINCT FROM NEW.user_id OR r.partition_key IS DISTINCT FROM NEW.partition_key)
	) THEN
		RAISE EXCEPTION 'node partition change leaves cross-partition dependents' USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER nodes_partition_dependents
	AFTER UPDATE OF user_id, partition_key ON nodes
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	EXECUTE FUNCTION validate_node_partition_dependents();--> statement-breakpoint

CREATE FUNCTION reopen_mappings_for_replacement_partition() RETURNS trigger AS $$
BEGIN
	WITH reopened AS (
		UPDATE partition_node_mappings m
		SET state = 'quarantined', replacement_node_id = NULL, updated_at = now()
		WHERE m.replacement_node_id = NEW.id
			AND m.state = 'completed'
			AND m.partition_key IS DISTINCT FROM NEW.partition_key
		RETURNING m.user_id, m.source_node_id, m.partition_key
	)
	UPDATE partition_artifact_receipts r
	SET disposition = 'pending',
		details = jsonb_build_object('reason', 'replacement moved out of target partition'),
		updated_at = now()
	FROM reopened
	WHERE r.user_id = reopened.user_id
		AND r.source_node_id = reopened.source_node_id
		AND r.partition_key = reopened.partition_key;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER replacements_partition_recovery
	AFTER UPDATE OF partition_key ON nodes
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	EXECUTE FUNCTION reopen_mappings_for_replacement_partition();--> statement-breakpoint

CREATE FUNCTION validate_source_partition_dependents() RETURNS trigger AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM sources child WHERE child.parent_source = NEW.id
			AND (child.user_id IS DISTINCT FROM NEW.user_id OR child.partition_key IS DISTINCT FROM NEW.partition_key)
	) OR EXISTS (
		SELECT 1 FROM source_links sl JOIN nodes n ON n.id = sl.node_id
		WHERE sl.source_id = NEW.id
			AND (n.user_id IS DISTINCT FROM NEW.user_id OR n.partition_key IS DISTINCT FROM NEW.partition_key)
	) OR EXISTS (
		SELECT 1 FROM claims c WHERE c.source_id = NEW.id
			AND (c.user_id IS DISTINCT FROM NEW.user_id OR c.partition_key IS DISTINCT FROM NEW.partition_key)
	) THEN
		RAISE EXCEPTION 'source partition change leaves cross-partition dependents' USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sources_partition_dependents
	AFTER UPDATE OF user_id, partition_key, parent_source ON sources
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	EXECUTE FUNCTION validate_source_partition_dependents();--> statement-breakpoint

CREATE FUNCTION validate_memory_partition_status() RETURNS trigger AS $$
DECLARE
	partition_user text := COALESCE(NEW.user_id, OLD.user_id);
	partition_key_value varchar := COALESCE(NEW.partition_key, OLD.partition_key);
	partition_status varchar := CASE WHEN TG_OP = 'DELETE' THEN 'deleted' ELSE NEW.status END;
BEGIN
	IF partition_status <> 'active' AND (
		EXISTS (SELECT 1 FROM nodes WHERE user_id = partition_user AND partition_key = partition_key_value) OR
		EXISTS (SELECT 1 FROM sources WHERE user_id = partition_user AND partition_key = partition_key_value) OR
		EXISTS (SELECT 1 FROM claims WHERE user_id = partition_user AND partition_key = partition_key_value) OR
		EXISTS (SELECT 1 FROM aliases WHERE user_id = partition_user AND partition_key = partition_key_value) OR
		EXISTS (SELECT 1 FROM node_redirects WHERE user_id = partition_user AND partition_key = partition_key_value) OR
		EXISTS (SELECT 1 FROM rollup_state WHERE user_id = partition_user AND partition_key = partition_key_value)
	) THEN
		RAISE EXCEPTION 'an in-use memory partition must remain active' USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER memory_partitions_active_integrity
	AFTER UPDATE OF status OR DELETE ON memory_partitions
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	EXECUTE FUNCTION validate_memory_partition_status();--> statement-breakpoint

CREATE FUNCTION validate_partition_mapping_completion() RETURNS trigger AS $$
BEGIN
	IF NEW.state = 'completed' AND (
		NEW.replacement_node_id IS NULL OR
		(SELECT count(*) FROM partition_artifact_receipts r
		 WHERE r.user_id = NEW.user_id
			AND r.source_node_id = NEW.source_node_id
			AND r.partition_key = NEW.partition_key
			AND r.disposition <> 'pending') <> 6
	) THEN
		RAISE EXCEPTION 'completed partition mapping requires six durable terminal artifact receipts'
			USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER partition_mapping_completion_integrity
	AFTER INSERT OR UPDATE OF state, replacement_node_id ON partition_node_mappings
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	EXECUTE FUNCTION validate_partition_mapping_completion();--> statement-breakpoint

CREATE FUNCTION validate_completed_mapping_receipts() RETURNS trigger AS $$
DECLARE
	old_mapping_completed boolean := EXISTS (
		SELECT 1 FROM partition_node_mappings m
		WHERE m.user_id = OLD.user_id
			AND m.source_node_id = OLD.source_node_id
			AND m.partition_key = OLD.partition_key
			AND m.state = 'completed'
	);
	new_mapping_completed boolean := CASE WHEN TG_OP = 'DELETE' THEN false ELSE EXISTS (
		SELECT 1 FROM partition_node_mappings m
		WHERE m.user_id = NEW.user_id
			AND m.source_node_id = NEW.source_node_id
			AND m.partition_key = NEW.partition_key
			AND m.state = 'completed'
	) END;
BEGIN
	IF (old_mapping_completed OR new_mapping_completed) AND TG_OP = 'UPDATE' AND (
		OLD.user_id IS DISTINCT FROM NEW.user_id OR
		OLD.source_node_id IS DISTINCT FROM NEW.source_node_id OR
		OLD.partition_key IS DISTINCT FROM NEW.partition_key OR
		OLD.artifact_kind IS DISTINCT FROM NEW.artifact_kind OR
		OLD.disposition IS DISTINCT FROM NEW.disposition OR
		OLD.source_count IS DISTINCT FROM NEW.source_count OR
		OLD.rebuilt_count IS DISTINCT FROM NEW.rebuilt_count OR
		OLD.quarantined_count IS DISTINCT FROM NEW.quarantined_count OR
		OLD.details IS DISTINCT FROM NEW.details OR
		OLD.created_at IS DISTINCT FROM NEW.created_at OR
		OLD.updated_at IS DISTINCT FROM NEW.updated_at
	) THEN
		RAISE EXCEPTION 'completed partition mapping receipt dispositions and counts are immutable'
			USING ERRCODE = '23514';
	END IF;
	IF TG_OP = 'DELETE' AND old_mapping_completed AND (
		SELECT count(*) FROM partition_artifact_receipts r
		WHERE r.user_id = OLD.user_id
			AND r.source_node_id = OLD.source_node_id
			AND r.partition_key = OLD.partition_key
			AND r.disposition <> 'pending'
	) <> 6 THEN
		RAISE EXCEPTION 'completed partition mapping artifact receipts are immutable as a complete set'
			USING ERRCODE = '23514';
	END IF;
	IF TG_OP = 'UPDATE' AND new_mapping_completed AND (
		SELECT count(*) FROM partition_artifact_receipts r
		WHERE r.user_id = NEW.user_id
			AND r.source_node_id = NEW.source_node_id
			AND r.partition_key = NEW.partition_key
			AND r.disposition <> 'pending'
	) <> 6 THEN
		RAISE EXCEPTION 'completed partition mapping artifact receipts are immutable as a complete set'
			USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER completed_mapping_receipts_integrity
	AFTER UPDATE OR DELETE ON partition_artifact_receipts
	FOR EACH ROW EXECUTE FUNCTION validate_completed_mapping_receipts();

CREATE FUNCTION quarantine_deleted_commitment_presentation() RETURNS trigger AS $$
BEGIN
	WITH reopened AS (
		UPDATE partition_node_mappings m
		SET state = 'quarantined', updated_at = now()
		WHERE m.user_id = OLD.user_id
			AND m.replacement_node_id = OLD.task_id
			AND m.state = 'completed'
		RETURNING m.user_id, m.source_node_id, m.partition_key
	)
	UPDATE partition_artifact_receipts r
	SET disposition = 'quarantined',
		rebuilt_count = 0,
		quarantined_count = r.source_count,
		details = jsonb_build_object('reason', 'source-owned presentation was deleted'),
		updated_at = now()
	FROM reopened
	WHERE r.user_id = reopened.user_id
		AND r.source_node_id = reopened.source_node_id
		AND r.partition_key = reopened.partition_key
		AND r.artifact_kind = 'commitment_presentation';
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER deleted_commitment_presentation_integrity
	AFTER DELETE ON commitment_presentations
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	EXECUTE FUNCTION quarantine_deleted_commitment_presentation();
