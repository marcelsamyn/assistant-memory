/**
 * Shared fixtures for the rollup integration tests (summarize-period,
 * jobs/rollup). A plain module — NOT a .test file — so importing it never
 * re-registers another suite's tests.
 */
import type { StubCompletionClient } from "~/utils/test-overrides";

/** All tables the rollup write path touches (embeddings are skipped). */
export const ROLLUP_TEST_TABLES_SQL = `
  CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);
  CREATE TABLE "nodes" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id"),
    "node_type" varchar(50) NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE "node_metadata" (
    "id" text PRIMARY KEY NOT NULL,
    "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
    "label" text,
    "canonical_label" text,
    "description" text,
    "additional_data" jsonb,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "node_metadata_node_id_unique" UNIQUE ("node_id")
  );
  CREATE TABLE "sources" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id"),
    "type" varchar(50) NOT NULL,
    "external_id" text NOT NULL,
    "parent_source" text,
    "scope" varchar(16) DEFAULT 'personal' NOT NULL,
    "metadata" jsonb,
    "last_ingested_at" timestamp with time zone,
    "status" varchar(20) DEFAULT 'pending',
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "deleted_at" timestamp with time zone,
    "content_type" varchar(100),
    "content_length" integer,
    CONSTRAINT "sources_user_type_external_unique"
      UNIQUE ("user_id", "type", "external_id")
  );
  CREATE TABLE "claims" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id"),
    "subject_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
    "object_node_id" text REFERENCES "nodes"("id") ON DELETE CASCADE,
    "object_value" text,
    "predicate" varchar(80) NOT NULL,
    "statement" text NOT NULL,
    "description" text,
    "metadata" jsonb,
    "object_instant" timestamp with time zone,
    "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
    "scope" varchar(16) DEFAULT 'personal' NOT NULL,
    "asserted_by_kind" varchar(24) NOT NULL,
    "asserted_by_node_id" text REFERENCES "nodes"("id") ON DELETE SET NULL,
    "superseded_by_claim_id" text REFERENCES "claims"("id") ON DELETE SET NULL,
    "contradicted_by_claim_id" text REFERENCES "claims"("id") ON DELETE SET NULL,
    "stated_at" timestamp with time zone NOT NULL,
    "valid_from" timestamp with time zone,
    "valid_to" timestamp with time zone,
    "status" varchar(30) DEFAULT 'active' NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE "rollup_state" (
    "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id"),
    "watermark" timestamp with time zone,
    "pending_periods" jsonb DEFAULT '[]' NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
  );
`;

/** Stub LLM client that records prompts and returns canned summaries. */
export function stubLlm(): {
  client: StubCompletionClient;
  calls: string[];
} {
  const calls: string[] = [];
  const client = {
    chat: {
      completions: {
        parse: async (body: { messages: Array<{ content: string }> }) => {
          const prompt = body.messages.map((m) => m.content).join("\n");
          calls.push(prompt);
          return {
            choices: [
              {
                message: {
                  parsed: { summary: `LLM summary #${calls.length}` },
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    },
  } as unknown as StubCompletionClient;
  return { client, calls };
}
