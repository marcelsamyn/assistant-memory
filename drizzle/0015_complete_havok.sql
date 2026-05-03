CREATE TABLE "metric_definition_embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"metric_definition_id" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"model_name" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_def_emb_def_unique" UNIQUE("metric_definition_id")
);
--> statement-breakpoint
CREATE TABLE "metric_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"unit" text NOT NULL,
	"aggregation_hint" varchar(8) NOT NULL,
	"valid_range_min" text,
	"valid_range_max" text,
	"needs_review" boolean DEFAULT false NOT NULL,
	"review_task_node_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_definitions_user_slug_unique" UNIQUE("user_id","slug"),
	CONSTRAINT "metric_definitions_aggregation_hint_ck" CHECK ("aggregation_hint" IN ('avg','sum','min','max'))
);
--> statement-breakpoint
CREATE TABLE "metric_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"metric_definition_id" text NOT NULL,
	"value" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"note" text,
	"event_node_id" text,
	"source_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "metric_definition_embeddings" ADD CONSTRAINT "metric_definition_embeddings_metric_definition_id_metric_definitions_id_fk" FOREIGN KEY ("metric_definition_id") REFERENCES "public"."metric_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_review_task_node_id_nodes_id_fk" FOREIGN KEY ("review_task_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_metric_definition_id_metric_definitions_id_fk" FOREIGN KEY ("metric_definition_id") REFERENCES "public"."metric_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_event_node_id_nodes_id_fk" FOREIGN KEY ("event_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "metric_def_emb_idx" ON "metric_definition_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "metric_def_emb_def_id_idx" ON "metric_definition_embeddings" USING btree ("metric_definition_id");--> statement-breakpoint
CREATE INDEX "metric_definitions_user_id_idx" ON "metric_definitions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "metric_definitions_user_needs_review_idx" ON "metric_definitions" USING btree ("user_id") WHERE "metric_definitions"."needs_review" = true;--> statement-breakpoint
CREATE INDEX "metric_observations_user_def_occurred_idx" ON "metric_observations" USING btree ("user_id","metric_definition_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "metric_observations_user_occurred_idx" ON "metric_observations" USING btree ("user_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "metric_observations_event_node_idx" ON "metric_observations" USING btree ("event_node_id") WHERE "metric_observations"."event_node_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "metric_observations_source_id_idx" ON "metric_observations" USING btree ("source_id");