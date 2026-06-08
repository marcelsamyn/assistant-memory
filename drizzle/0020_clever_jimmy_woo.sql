CREATE TABLE "node_redirects" (
	"user_id" text NOT NULL,
	"from_node_id" text NOT NULL,
	"to_node_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_redirects_user_id_from_node_id_pk" PRIMARY KEY("user_id","from_node_id")
);
--> statement-breakpoint
ALTER TABLE "node_redirects" ADD CONSTRAINT "node_redirects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_redirects" ADD CONSTRAINT "node_redirects_to_node_id_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_redirects_user_to_node_idx" ON "node_redirects" USING btree ("user_id","to_node_id");