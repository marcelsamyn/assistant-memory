CREATE TABLE "source_lifecycle_commands" (
	"user_id" text NOT NULL,
	"command_id" varchar(200) NOT NULL,
	"source_id" text NOT NULL,
	"expected_partition_key" varchar(200),
	"expected_source_version" integer NOT NULL,
	"action" varchar(20) NOT NULL,
	"state" varchar(20) NOT NULL,
	"source_version" integer,
	"restorable_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_lifecycle_commands_user_id_command_id_pk" PRIMARY KEY("user_id","command_id"),
	CONSTRAINT "source_lifecycle_commands_action_ck" CHECK ("action" IN ('tombstone', 'restore', 'purge')),
	CONSTRAINT "source_lifecycle_commands_state_ck" CHECK ("state" IN ('tombstoned', 'restored', 'purged')),
	CONSTRAINT "source_lifecycle_commands_expected_version_ck" CHECK ("expected_source_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "source_tombstones" (
	"user_id" text NOT NULL,
	"source_id" text NOT NULL,
	"partition_key" varchar(200),
	"state" varchar(20) NOT NULL,
	"erased_at" timestamp with time zone NOT NULL,
	"restorable_until" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_tombstones_user_id_source_id_pk" PRIMARY KEY("user_id","source_id"),
	CONSTRAINT "source_tombstones_state_ck" CHECK ("state" IN ('tombstoned', 'restored', 'purged'))
);
--> statement-breakpoint
ALTER TABLE "source_lifecycle_commands" ADD CONSTRAINT "source_lifecycle_commands_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_tombstones" ADD CONSTRAINT "source_tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_tombstones_user_source_idx" ON "source_tombstones" USING btree ("user_id","source_id");
--> statement-breakpoint
-- Existing soft-deleted sources already have raw 0029 feed history. Seed a
-- permanent non-content tombstone for each one so replay projects redact that
-- history immediately after this migration, without rewriting sequence rows.
INSERT INTO "source_tombstones" (
  "user_id", "source_id", "partition_key", "state", "erased_at",
  "restorable_until", "finalized_at"
)
SELECT
  s."user_id", s."id", s."partition_key", 'purged',
  COALESCE(s."deleted_at", now()), NULL, COALESCE(s."deleted_at", now())
FROM "sources" s
WHERE s."deleted_at" IS NOT NULL
ON CONFLICT ("user_id", "source_id") DO NOTHING;
