CREATE TABLE "commitment_presentations" (
	"task_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source_id" text NOT NULL,
	"excerpt" text,
	"why" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commitment_presentations" ADD CONSTRAINT "commitment_presentations_task_id_nodes_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_presentations" ADD CONSTRAINT "commitment_presentations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_presentations" ADD CONSTRAINT "commitment_presentations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commitment_presentations_user_id_idx" ON "commitment_presentations" USING btree ("user_id");