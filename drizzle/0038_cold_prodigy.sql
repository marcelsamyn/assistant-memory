CREATE TABLE "source_ingestion_operations" (
	"operation_id" varchar(200) PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source_id" text NOT NULL,
	"partition_key" varchar(200),
	"external_id" text NOT NULL,
	"content_hash" varchar(128),
	"source_version" integer NOT NULL,
	"status" varchar(20) NOT NULL,
	"stage" varchar(20) NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "source_ingestion_operations_content_unique" UNIQUE("user_id","source_id","content_hash"),
	CONSTRAINT "source_ingestion_operations_status_ck" CHECK ("status" IN ('queued', 'processing', 'completed', 'failed', 'purged')),
	CONSTRAINT "source_ingestion_operations_stage_ck" CHECK ("stage" IN ('content', 'extraction')),
	CONSTRAINT "source_ingestion_operations_attempt_ck" CHECK ("attempt" >= 0),
	CONSTRAINT "source_ingestion_operations_source_version_ck" CHECK ("source_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "source_ingestion_operations" ADD CONSTRAINT "source_ingestion_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_ingestion_operations_source_idx" ON "source_ingestion_operations" USING btree ("user_id","source_id","created_at");--> statement-breakpoint
CREATE INDEX "source_ingestion_operations_status_idx" ON "source_ingestion_operations" USING btree ("user_id","partition_key","status");