-- Claims-first memory layer — Phase 1 PR 1a.
-- See docs/2026-04-24-claims-layer-design.md and
--     docs/2026-04-24-claims-implementation-plan.md (Phase 1, steps 1–4).
--
-- This migration is authored by hand and designed to be idempotent: every
-- ALTER / INSERT / UPDATE is guarded by existence checks so rerunning the
-- migration after a partial failure (or a double-apply) is a safe no-op.
-- The drizzle migrator already wraps each file in a single transaction.

-- 1. Rename `edges` → `claims` (idempotent via information_schema probe).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'edges'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'claims'
  ) THEN
    ALTER TABLE "edges" RENAME TO "claims";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    INNER JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'edges' AND c.relkind = 'v'
  ) THEN
    DROP VIEW "edges";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c
    INNER JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'edge_embeddings' AND c.relkind = 'v'
  ) THEN
    DROP VIEW "edge_embeddings";
  END IF;
END $$;
--> statement-breakpoint

-- 2. Rename columns: source_node_id → subject_node_id,
--    target_node_id → object_node_id, edge_type → predicate (widened to 80).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'claims'
      AND column_name = 'source_node_id'
  ) THEN
    ALTER TABLE "claims" RENAME COLUMN "source_node_id" TO "subject_node_id";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'claims'
      AND column_name = 'target_node_id'
  ) THEN
    ALTER TABLE "claims" RENAME COLUMN "target_node_id" TO "object_node_id";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'claims'
      AND column_name = 'edge_type'
  ) THEN
    ALTER TABLE "claims" RENAME COLUMN "edge_type" TO "predicate";
  END IF;
END $$;
--> statement-breakpoint

-- Widen `predicate` to varchar(80). Guarded because ALTER TYPE is not a
-- no-op when the column already has the target type.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'claims'
      AND column_name = 'predicate'
      AND (data_type <> 'character varying' OR character_maximum_length <> 80)
  ) THEN
    ALTER TABLE "claims" ALTER COLUMN "predicate" TYPE varchar(80);
  END IF;
END $$;
--> statement-breakpoint

-- 3. Add new columns (idempotent via IF NOT EXISTS).
ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "object_value" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "statement" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "source_id" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "stated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "valid_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "status" varchar(30) DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "claims" ALTER COLUMN "object_node_id" DROP NOT NULL;--> statement-breakpoint

-- 4. Drop the legacy edges UNIQUE(source_node_id, target_node_id, edge_type).
--    (The constraint was created in migration 0006 with a capitalized name.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'claims'
      AND constraint_name = 'edges_sourceNodeId_targetNodeId_edge_type_unique'
  ) THEN
    ALTER TABLE "claims"
      DROP CONSTRAINT "edges_sourceNodeId_targetNodeId_edge_type_unique";
  END IF;
END $$;
--> statement-breakpoint

-- Rename inherited FK constraints so live database names match the Drizzle
-- snapshot generated after the table/column renames.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edges_user_id_users_id_fk')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_user_id_users_id_fk') THEN
    ALTER TABLE "claims"
      RENAME CONSTRAINT "edges_user_id_users_id_fk" TO "claims_user_id_users_id_fk";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edges_source_node_id_nodes_id_fk')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_subject_node_id_nodes_id_fk') THEN
    ALTER TABLE "claims"
      RENAME CONSTRAINT "edges_source_node_id_nodes_id_fk" TO "claims_subject_node_id_nodes_id_fk";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edges_target_node_id_nodes_id_fk')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_object_node_id_nodes_id_fk') THEN
    ALTER TABLE "claims"
      RENAME CONSTRAINT "edges_target_node_id_nodes_id_fk" TO "claims_object_node_id_nodes_id_fk";
  END IF;
END $$;
--> statement-breakpoint

-- 5. Preserve source-node structural edges as source_links before deleting
--    them from factual claims. A structural edge points from a mentioned node
--    to a source-representing node; the source-representing node already has
--    a source_links row.
INSERT INTO "source_links" ("id", "source_id", "node_id")
SELECT
  'sln_0' || substring(md5('structural_source_link:' || sl."source_id" || ':' || c."subject_node_id") from 1 for 25),
  sl."source_id",
  c."subject_node_id"
FROM "claims" c
INNER JOIN "source_links" sl ON sl."node_id" = c."object_node_id"
WHERE c."predicate" IN ('MENTIONED_IN', 'CAPTURED_IN')
ON CONFLICT ("source_id", "node_id") DO NOTHING;
--> statement-breakpoint

-- Backfill factual claim provenance from the structural node-to-source links.
-- If a claim touches nodes linked to multiple sources, pick one deterministically.
WITH candidate_sources AS (
  SELECT
    c."id" AS claim_id,
    sl."source_id",
    row_number() OVER (
      PARTITION BY c."id"
      ORDER BY sl."created_at", sl."source_id"
    ) AS rn
  FROM "claims" c
  INNER JOIN "source_links" sl
    ON sl."node_id" IN (c."subject_node_id", c."object_node_id")
  WHERE c."source_id" IS NULL
    AND c."predicate" NOT IN ('MENTIONED_IN', 'CAPTURED_IN', 'INVALIDATED_ON')
)
UPDATE "claims" c
SET "source_id" = candidate_sources."source_id"
FROM candidate_sources
WHERE c."id" = candidate_sources.claim_id
  AND candidate_sources.rn = 1;
--> statement-breakpoint

-- MENTIONED_IN / CAPTURED_IN are structural and now represented via
-- source_links; INVALIDATED_ON is replaced by claim lifecycle status.
DELETE FROM "claims"
WHERE "predicate" IN ('MENTIONED_IN', 'CAPTURED_IN', 'INVALIDATED_ON');
--> statement-breakpoint

-- 6. Create one synthetic `legacy_migration` source per distinct user in
--    `claims` only when factual rows still lack provenance.
INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
SELECT
  'src_0' || substring(md5('legacy_migration:' || c."user_id") from 1 for 25) AS id,
  c."user_id",
  'legacy_migration' AS type,
  'legacy_migration:' || c."user_id" AS external_id,
  'completed' AS status
FROM (SELECT DISTINCT "user_id" FROM "claims" WHERE "source_id" IS NULL) c
ON CONFLICT ("user_id", "type", "external_id") DO NOTHING;
--> statement-breakpoint

-- 7. Backfill every remaining claim row with provenance and lifecycle fields.
UPDATE "claims" AS c
SET
  "source_id" = COALESCE(c."source_id", s."id"),
  "stated_at" = COALESCE(c."stated_at", c."created_at"),
  "status" = COALESCE(c."status", 'active'),
  "updated_at" = COALESCE(c."updated_at", c."created_at"),
  "statement" = COALESCE(c."statement", (
    SELECT
      COALESCE(srcMeta."label" || ' ', '')
      || c."predicate"
      || COALESCE(' ' || tgtMeta."label", '')
      || CASE
           WHEN c."description" IS NOT NULL AND c."description" <> ''
             THEN ': ' || c."description"
           ELSE ''
         END
    FROM (SELECT 1) _
    LEFT JOIN "node_metadata" srcMeta ON srcMeta."node_id" = c."subject_node_id"
    LEFT JOIN "node_metadata" tgtMeta ON tgtMeta."node_id" = c."object_node_id"
  )),
  "metadata" = COALESCE(c."metadata", '{}'::jsonb) || '{"backfilled": true}'::jsonb
FROM "sources" s
WHERE s."user_id" = c."user_id"
  AND s."type" = 'legacy_migration'
  AND (c."source_id" IS NULL OR c."statement" IS NULL OR c."stated_at" IS NULL OR c."status" IS NULL);
--> statement-breakpoint

-- Rows with real provenance do not join a legacy source; finish their non-source backfill.
UPDATE "claims" AS c
SET
  "stated_at" = COALESCE(c."stated_at", c."created_at"),
  "status" = COALESCE(c."status", 'active'),
  "updated_at" = COALESCE(c."updated_at", c."created_at"),
  "statement" = COALESCE(c."statement", (
    SELECT
      COALESCE(srcMeta."label" || ' ', '')
      || c."predicate"
      || COALESCE(' ' || tgtMeta."label", '')
      || CASE
           WHEN c."description" IS NOT NULL AND c."description" <> ''
             THEN ': ' || c."description"
           ELSE ''
         END
    FROM (SELECT 1) _
    LEFT JOIN "node_metadata" srcMeta ON srcMeta."node_id" = c."subject_node_id"
    LEFT JOIN "node_metadata" tgtMeta ON tgtMeta."node_id" = c."object_node_id"
  )),
  "metadata" = COALESCE(c."metadata", '{}'::jsonb) || '{"backfilled": true}'::jsonb
WHERE c."source_id" IS NOT NULL
  AND (c."statement" IS NULL OR c."stated_at" IS NULL OR c."status" IS NULL);
--> statement-breakpoint

-- 8. Apply NOT NULL now that backfill has populated required columns.
--    Idempotent: the ALTER is a no-op when the column is already NOT NULL.
ALTER TABLE "claims" ALTER COLUMN "statement" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ALTER COLUMN "source_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ALTER COLUMN "stated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint

-- Add FK for source_id → sources(id).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'claims'
      AND constraint_name = 'claims_source_id_sources_id_fk'
  ) THEN
    ALTER TABLE "claims"
      ADD CONSTRAINT "claims_source_id_sources_id_fk"
      FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint

-- 9. CHECK constraint on object shape: exactly one of node or scalar value.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'claims'
      AND constraint_name = 'claims_object_shape_xor_ck'
  ) THEN
    ALTER TABLE "claims"
      ADD CONSTRAINT "claims_object_shape_xor_ck"
      CHECK (num_nonnulls("object_node_id", "object_value") = 1);
  END IF;
END $$;
--> statement-breakpoint

-- 10. Rename legacy edges indexes to final claims vocabulary. Each block is guarded so a
--     rerun on an already-renamed index is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'edges_user_id_source_node_id_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'claims_user_id_subject_node_id_idx') THEN
    ALTER INDEX "edges_user_id_source_node_id_idx" RENAME TO "claims_user_id_subject_node_id_idx";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'edges_user_id_target_node_id_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'claims_user_id_object_node_id_idx') THEN
    ALTER INDEX "edges_user_id_target_node_id_idx" RENAME TO "claims_user_id_object_node_id_idx";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'edges_user_id_edge_type_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'claims_user_id_predicate_idx') THEN
    ALTER INDEX "edges_user_id_edge_type_idx" RENAME TO "claims_user_id_predicate_idx";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'claims_user_id_source_node_id_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'claims_user_id_subject_node_id_idx') THEN
    ALTER INDEX "claims_user_id_source_node_id_idx" RENAME TO "claims_user_id_subject_node_id_idx";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'claims_user_id_target_node_id_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'claims_user_id_object_node_id_idx') THEN
    ALTER INDEX "claims_user_id_target_node_id_idx" RENAME TO "claims_user_id_object_node_id_idx";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'claims_user_id_edge_type_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'claims_user_id_predicate_idx') THEN
    ALTER INDEX "claims_user_id_edge_type_idx" RENAME TO "claims_user_id_predicate_idx";
  END IF;
END $$;
--> statement-breakpoint

-- Rename the implicit primary-key constraint/index from the old table name.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edges_pkey') THEN
    ALTER TABLE "claims" RENAME CONSTRAINT "edges_pkey" TO "claims_pkey";
  END IF;
END $$;
--> statement-breakpoint

-- New design-doc indexes.
CREATE INDEX IF NOT EXISTS "claims_user_id_status_stated_at_idx"
  ON "claims" ("user_id", "status", "stated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claims_user_id_subject_status_idx"
  ON "claims" ("user_id", "subject_node_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claims_user_id_object_status_idx"
  ON "claims" ("user_id", "object_node_id", "status")
  WHERE "object_node_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claims_source_id_idx"
  ON "claims" ("source_id");--> statement-breakpoint

-- 11. Rename `edge_embeddings` → `claim_embeddings`; rename the FK column
--     `edge_id` → `claim_id`; drop the legacy FK before TypeID rewrites.
DO $$
DECLARE
  fk record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'edge_embeddings'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'claim_embeddings'
  ) THEN
    ALTER TABLE "edge_embeddings" RENAME TO "claim_embeddings";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'claim_embeddings'
      AND column_name = 'edge_id'
  ) THEN
    ALTER TABLE "claim_embeddings" RENAME COLUMN "edge_id" TO "claim_id";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edge_embeddings_pkey') THEN
    ALTER TABLE "claim_embeddings" RENAME CONSTRAINT "edge_embeddings_pkey" TO "claim_embeddings_pkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edge_embeddings_edge_id_edges_id_fk') THEN
    ALTER TABLE "claim_embeddings"
      DROP CONSTRAINT "edge_embeddings_edge_id_edges_id_fk";
  END IF;

  FOR fk IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'claim_embeddings'::regclass
      AND contype = 'f'
      AND conname <> 'claim_embeddings_claim_id_claims_id_fk'
  LOOP
    EXECUTE format('ALTER TABLE "claim_embeddings" DROP CONSTRAINT %I', fk.conname);
  END LOOP;
END $$;
--> statement-breakpoint

-- Rename claim_embeddings indexes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'edge_embeddings_embedding_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'claim_embeddings_embedding_idx') THEN
    ALTER INDEX "edge_embeddings_embedding_idx" RENAME TO "claim_embeddings_embedding_idx";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'edge_embeddings_edge_id_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'claim_embeddings_claim_id_idx') THEN
    ALTER INDEX "edge_embeddings_edge_id_idx" RENAME TO "claim_embeddings_claim_id_idx";
  END IF;
END $$;
--> statement-breakpoint

-- 12. TypeID prefix rewrite. Only touches IDs that still carry the old
--     prefix (idempotent by construction). We deliberately avoid broad
--     string replacement inside arbitrary JSON metadata blobs.
UPDATE "claims"
   SET "id" = 'claim_' || substring("id" from 6)
 WHERE "id" LIKE 'edge_%';--> statement-breakpoint
UPDATE "claim_embeddings"
   SET "id" = 'cemb_' || substring("id" from 6)
 WHERE "id" LIKE 'eemb_%';--> statement-breakpoint
UPDATE "claim_embeddings"
   SET "claim_id" = 'claim_' || substring("claim_id" from 6)
 WHERE "claim_id" LIKE 'edge_%';--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'claim_embeddings'
      AND constraint_name = 'claim_embeddings_claim_id_claims_id_fk'
  ) THEN
    ALTER TABLE "claim_embeddings"
      ADD CONSTRAINT "claim_embeddings_claim_id_claims_id_fk"
      FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint

-- 13. Aliases: add normalized_alias_text + UNIQUE constraint.
ALTER TABLE "aliases"
  ADD COLUMN IF NOT EXISTS "normalized_alias_text" text;--> statement-breakpoint

UPDATE "aliases"
   SET "normalized_alias_text" = trim(lower("alias_text"))
 WHERE "normalized_alias_text" IS NULL;--> statement-breakpoint

DELETE FROM "aliases" a
USING (
  SELECT "id"
  FROM (
    SELECT
      "id",
      row_number() OVER (
        PARTITION BY "user_id", "normalized_alias_text", "canonical_node_id"
        ORDER BY "created_at", "id"
      ) AS rn
    FROM "aliases"
  ) ranked
  WHERE ranked.rn > 1
) duplicates
WHERE a."id" = duplicates."id";--> statement-breakpoint

ALTER TABLE "aliases" ALTER COLUMN "normalized_alias_text" SET NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'aliases'
      AND constraint_name = 'aliases_user_normalized_canonical_unique'
  ) THEN
    ALTER TABLE "aliases"
      ADD CONSTRAINT "aliases_user_normalized_canonical_unique"
      UNIQUE ("user_id", "normalized_alias_text", "canonical_node_id");
  END IF;
END $$;
