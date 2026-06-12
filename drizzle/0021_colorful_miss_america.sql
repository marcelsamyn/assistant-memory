CREATE TABLE "rollup_state" (
	"user_id" text PRIMARY KEY NOT NULL,
	"watermark" timestamp with time zone,
	"pending_periods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rollup_state" ADD CONSTRAINT "rollup_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;