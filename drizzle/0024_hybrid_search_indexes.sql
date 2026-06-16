CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(statement, '') || ' ' || coalesce(description, ''))) STORED;--> statement-breakpoint
ALTER TABLE "node_metadata" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(label, '') || ' ' || coalesce(description, ''))) STORED;--> statement-breakpoint
CREATE INDEX "claims_search_tsv_idx" ON "claims" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "claims_statement_trgm_idx" ON "claims" USING gin ("statement" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "node_metadata_search_tsv_idx" ON "node_metadata" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "node_metadata_label_trgm_idx" ON "node_metadata" USING gin ("label" gin_trgm_ops);