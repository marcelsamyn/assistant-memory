CREATE TABLE "source_blob_uploads" (
	"user_id" text NOT NULL,
	"source_id" text NOT NULL,
	"object_key" text NOT NULL,
	"state" varchar(24) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	"cleanup_completed_at" timestamp with time zone,
	CONSTRAINT "source_blob_uploads_user_id_source_id_pk" PRIMARY KEY("user_id","source_id"),
	CONSTRAINT "source_blob_uploads_state_ck" CHECK ("state" IN ('reserved', 'uploading', 'uploaded', 'cleanup_pending', 'cleanup_completed'))
);
--> statement-breakpoint
ALTER TABLE "source_blob_uploads" ADD CONSTRAINT "source_blob_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_blob_uploads_cleanup_idx" ON "source_blob_uploads" USING btree ("state","updated_at");
