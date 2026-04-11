ALTER TABLE "node_metadata" ADD COLUMN IF NOT EXISTS "canonical_label" text;--> statement-breakpoint
-- Backfill canonical_label from existing labels
UPDATE "node_metadata" SET "canonical_label" = regexp_replace(lower(trim("label")), '\s+', ' ', 'g') WHERE "label" IS NOT NULL AND "canonical_label" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "node_metadata_canonical_label_idx" ON "node_metadata" USING btree ("canonical_label");