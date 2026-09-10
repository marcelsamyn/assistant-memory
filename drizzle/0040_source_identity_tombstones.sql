CREATE TABLE "source_identity_tombstones" (
	"user_id" text NOT NULL,
	"type" varchar(50) NOT NULL,
	"external_id" text NOT NULL,
	"partition_key" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_identity_tombstones_user_id_type_external_id_pk" PRIMARY KEY("user_id","type","external_id")
);
--> statement-breakpoint
ALTER TABLE "source_identity_tombstones" ADD CONSTRAINT "source_identity_tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_identity_tombstones_user_partition_idx" ON "source_identity_tombstones" USING btree ("user_id","partition_key");