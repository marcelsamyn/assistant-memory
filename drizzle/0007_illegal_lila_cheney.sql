CREATE TABLE "scratchpads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "scratchpads_userId_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "scratchpads" ADD CONSTRAINT "scratchpads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scratchpads_user_id_idx" ON "scratchpads" USING btree ("user_id");