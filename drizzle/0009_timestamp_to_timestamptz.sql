-- Convert all timestamp columns to timestamp with time zone.
-- PostgreSQL interprets existing values as UTC during conversion.

ALTER TABLE "nodes" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "node_metadata" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "edges" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "node_embeddings" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "edge_embeddings" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "aliases" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "last_ingested_at" TYPE timestamptz USING "last_ingested_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "deleted_at" TYPE timestamptz USING "deleted_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "source_links" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "user_profiles" ALTER COLUMN "last_updated_at" TYPE timestamptz USING "last_updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "user_profiles" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "scratchpads" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "scratchpads" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
