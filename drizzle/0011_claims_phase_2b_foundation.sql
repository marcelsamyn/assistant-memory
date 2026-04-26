-- Claims-first memory layer — Phase 2b foundation.
-- Adds predicate-policy-supporting storage fields: source/claim scope,
-- structured provenance, and lifecycle transition pointers.
--
-- Authored by hand so the additive migration is safe to rerun after a
-- partial failure. Drizzle wraps the file in a transaction.

ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "scope" varchar(16) DEFAULT 'personal' NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sources_scope_ck'
  ) THEN
    ALTER TABLE "sources"
      ADD CONSTRAINT "sources_scope_ck"
      CHECK ("scope" IN ('personal', 'reference'));
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "scope" varchar(16) DEFAULT 'personal' NOT NULL;--> statement-breakpoint

UPDATE "claims" c
SET "scope" = s."scope"
FROM "sources" s
WHERE c."source_id" = s."id"
  AND c."scope" <> s."scope";
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'claims_scope_ck'
  ) THEN
    ALTER TABLE "claims"
      ADD CONSTRAINT "claims_scope_ck"
      CHECK ("scope" IN ('personal', 'reference'));
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "asserted_by_kind" varchar(24);--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "asserted_by_node_id" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "superseded_by_claim_id" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "contradicted_by_claim_id" text;--> statement-breakpoint

UPDATE "claims" c
SET "asserted_by_kind" = 'system'
FROM "sources" s
WHERE c."source_id" = s."id"
  AND c."asserted_by_kind" IS NULL
  AND s."type" IN ('manual')
  AND c."predicate" IN ('OWNED_BY', 'OCCURRED_ON');
--> statement-breakpoint

UPDATE "claims"
SET "asserted_by_kind" = 'user'
WHERE "asserted_by_kind" IS NULL;
--> statement-breakpoint

ALTER TABLE "claims" ALTER COLUMN "asserted_by_kind" SET NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'claims_asserted_by_node_id_nodes_id_fk'
  ) THEN
    ALTER TABLE "claims"
      ADD CONSTRAINT "claims_asserted_by_node_id_nodes_id_fk"
      FOREIGN KEY ("asserted_by_node_id")
      REFERENCES "public"."nodes"("id")
      ON DELETE SET NULL
      ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'claims_superseded_by_claim_id_claims_id_fk'
  ) THEN
    ALTER TABLE "claims"
      ADD CONSTRAINT "claims_superseded_by_claim_id_claims_id_fk"
      FOREIGN KEY ("superseded_by_claim_id")
      REFERENCES "public"."claims"("id")
      ON DELETE SET NULL
      ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'claims_contradicted_by_claim_id_claims_id_fk'
  ) THEN
    ALTER TABLE "claims"
      ADD CONSTRAINT "claims_contradicted_by_claim_id_claims_id_fk"
      FOREIGN KEY ("contradicted_by_claim_id")
      REFERENCES "public"."claims"("id")
      ON DELETE SET NULL
      ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'claims_asserted_by_kind_ck'
  ) THEN
    ALTER TABLE "claims"
      ADD CONSTRAINT "claims_asserted_by_kind_ck"
      CHECK ("asserted_by_kind" IN ('user', 'user_confirmed', 'assistant_inferred', 'participant', 'document_author', 'system'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'claims_asserted_by_node_consistency_ck'
  ) THEN
    ALTER TABLE "claims"
      ADD CONSTRAINT "claims_asserted_by_node_consistency_ck"
      CHECK (("asserted_by_kind" = 'participant' AND "asserted_by_node_id" IS NOT NULL) OR "asserted_by_kind" <> 'participant');
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "claims_user_scope_status_stated_at_idx"
  ON "claims" USING btree ("user_id", "scope", "status", "stated_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "claims_user_scope_kind_status_idx"
  ON "claims" USING btree ("user_id", "scope", "asserted_by_kind", "status");--> statement-breakpoint

DROP INDEX IF EXISTS "claims_user_id_status_stated_at_idx";
