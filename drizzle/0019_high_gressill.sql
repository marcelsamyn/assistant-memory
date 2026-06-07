ALTER TABLE "claims" ADD COLUMN "object_instant" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "claims_due_instant_idx" ON "claims" USING btree ("user_id","object_instant") WHERE "claims"."predicate" = 'DUE_ON' AND "claims"."status" = 'active' AND "claims"."scope" = 'personal' AND "claims"."object_instant" IS NOT NULL;
