import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { newTypeId } from "~/types/typeid";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

process.env["DATABASE_URL"] ??=
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;
process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "http://localhost";
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test";
process.env["JINA_API_KEY"] ??= "test";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["MINIO_ENDPOINT"] ??= "localhost";
process.env["MINIO_ACCESS_KEY"] ??= "test";
process.env["MINIO_SECRET_KEY"] ??= "test";
process.env["SOURCES_BUCKET"] ??= "test";
process.env["IDENTITY_EMBEDDING_THRESHOLD"] ??= "0.78";
process.env["IDENTITY_PROFILE_COMPAT_THRESHOLD"] ??= "0.6";

const adminDsn = () =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;

const dsnFor = (dbName: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${dbName}`;

async function isServerReachable(): Promise<boolean> {
  const client = new Client({ connectionString: adminDsn() });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const SERVER_AVAILABLE = await isServerReachable();
const describeIfServer = SERVER_AVAILABLE ? describe : describe.skip;

/** Build a deterministic 1024-dim unit vector that puts mass on a single dim. */
function unitVector(dim: number): number[] {
  const v = Array.from({ length: 1024 }, () => 0);
  v[dim] = 1;
  return v;
}

async function createIdentityTables(client: Client): Promise<void> {
  await client.query(`CREATE EXTENSION IF NOT EXISTS "vector"`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY NOT NULL);
    CREATE TABLE IF NOT EXISTS "nodes" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "node_type" varchar(50) NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "node_metadata" (
      "id" text PRIMARY KEY NOT NULL,
      "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "label" text,
      "canonical_label" text,
      "description" text,
      "additional_data" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "node_metadata_node_id_unique" UNIQUE ("node_id")
    );
    CREATE TABLE IF NOT EXISTS "sources" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "type" varchar(50) NOT NULL,
      "external_id" text NOT NULL,
      "scope" varchar(16) DEFAULT 'personal' NOT NULL,
      "status" varchar(20) DEFAULT 'completed',
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "source_links" (
      "id" text PRIMARY KEY NOT NULL,
      "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
      "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "specific_location" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "source_links_source_node_unique" UNIQUE ("source_id", "node_id")
    );
    CREATE TABLE IF NOT EXISTS "claims" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "subject_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "object_node_id" text REFERENCES "nodes"("id") ON DELETE CASCADE,
      "object_value" text,
      "predicate" varchar(80) NOT NULL,
      "statement" text NOT NULL,
      "description" text,
      "metadata" jsonb,
      "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
      "scope" varchar(16) DEFAULT 'personal' NOT NULL,
      "asserted_by_kind" varchar(24) NOT NULL,
      "asserted_by_node_id" text REFERENCES "nodes"("id") ON DELETE SET NULL,
      "stated_at" timestamp with time zone NOT NULL,
      "status" varchar(30) DEFAULT 'active' NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "aliases" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "alias_text" text NOT NULL,
      "normalized_alias_text" text NOT NULL,
      "canonical_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "aliases_user_normalized_canonical_unique"
        UNIQUE ("user_id", "normalized_alias_text", "canonical_node_id")
    );
    CREATE TABLE IF NOT EXISTS "node_embeddings" (
      "id" text PRIMARY KEY NOT NULL,
      "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "embedding" vector(1024) NOT NULL,
      "model_name" varchar(100) NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
}

describeIfServer("resolveIdentity", () => {
  const dbName = `memory_identity_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
  });

  afterAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });
    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
    try {
      return await fn(client);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  }

  it("signal 1 — canonical label match resolves only within the same scope", async () => {
    await withDb(async (client) => {
      const userId = "user_canonical";
      const personalNodeId = newTypeId("node");
      const referenceNodeId = newTypeId("node");
      const personalSourceId = newTypeId("source");
      const referenceSourceId = newTypeId("source");
      await createIdentityTables(client);
      await client.query(`INSERT INTO "users"("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources"("id","user_id","type","external_id","scope")
           VALUES ($1,$3,'document','p1','personal'),($2,$3,'document','r1','reference')`,
        [personalSourceId, referenceSourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes"("id","user_id","node_type")
           VALUES ($1,$3,'Person'),($2,$3,'Person')`,
        [personalNodeId, referenceNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata"("id","node_id","label","canonical_label")
           VALUES ($1,$3,'Marcus','marcus'),($2,$4,'Marcus','marcus')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          personalNodeId,
          referenceNodeId,
        ],
      );
      await client.query(
        `INSERT INTO "source_links"("id","source_id","node_id")
           VALUES ($1,$3,$5),($2,$4,$6)`,
        [
          newTypeId("source_link"),
          newTypeId("source_link"),
          personalSourceId,
          referenceSourceId,
          personalNodeId,
          referenceNodeId,
        ],
      );

      const { resolveIdentity } = await import("./identity-resolution");

      const personalResolution = await resolveIdentity({
        userId,
        candidate: {
          proposedLabel: "Marcus",
          normalizedLabel: "marcus",
          nodeType: "Person",
          scope: "personal",
        },
      });
      expect(personalResolution.resolvedNodeId).toBe(personalNodeId);
      expect(personalResolution.decision.signal).toBe("canonical_label");

      // A reference candidate must not resolve to the personal node, and vice
      // versa. Both must hit the right node only.
      const referenceResolution = await resolveIdentity({
        userId,
        candidate: {
          proposedLabel: "Marcus",
          normalizedLabel: "marcus",
          nodeType: "Person",
          scope: "reference",
        },
      });
      expect(referenceResolution.resolvedNodeId).toBe(referenceNodeId);

      // Now a candidate label that ONLY exists in reference but is presented
      // as personal must refuse to merge cross-scope.
      const onlyReferenceNodeId = newTypeId("node");
      await client.query(
        `INSERT INTO "nodes"("id","user_id","node_type") VALUES ($1,$2,'Person')`,
        [onlyReferenceNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata"("id","node_id","label","canonical_label")
           VALUES ($1,$2,'Aurelius','aurelius')`,
        [newTypeId("node_metadata"), onlyReferenceNodeId],
      );
      await client.query(
        `INSERT INTO "source_links"("id","source_id","node_id") VALUES ($1,$2,$3)`,
        [newTypeId("source_link"), referenceSourceId, onlyReferenceNodeId],
      );

      const refused = await resolveIdentity({
        userId,
        candidate: {
          proposedLabel: "Aurelius",
          normalizedLabel: "aurelius",
          nodeType: "Person",
          scope: "personal",
        },
      });
      expect(refused.resolvedNodeId).toBeNull();
      const canonical = refused.decision.trace.find(
        (t) => t.signal === "canonical_label",
      );
      expect(canonical?.crossScopeRefusal).toMatchObject({
        nodeId: onlyReferenceNodeId,
        otherScope: "reference",
      });
    });
  });

  it("signal 2 — alias resolves within scope; cross-scope alias is refused", async () => {
    await withDb(async (client) => {
      const userId = "user_alias";
      const personalNodeId = newTypeId("node");
      const referenceNodeId = newTypeId("node");
      const personalSourceId = newTypeId("source");
      const referenceSourceId = newTypeId("source");
      await createIdentityTables(client);
      await client.query(`INSERT INTO "users"("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources"("id","user_id","type","external_id","scope")
           VALUES ($1,$3,'document','p2','personal'),($2,$3,'document','r2','reference')`,
        [personalSourceId, referenceSourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes"("id","user_id","node_type")
           VALUES ($1,$3,'Person'),($2,$3,'Person')`,
        [personalNodeId, referenceNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata"("id","node_id","label","canonical_label")
           VALUES ($1,$3,'Jane Doe','jane doe'),($2,$4,'Marcus Aurelius','marcus aurelius')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          personalNodeId,
          referenceNodeId,
        ],
      );
      await client.query(
        `INSERT INTO "source_links"("id","source_id","node_id")
           VALUES ($1,$3,$5),($2,$4,$6)`,
        [
          newTypeId("source_link"),
          newTypeId("source_link"),
          personalSourceId,
          referenceSourceId,
          personalNodeId,
          referenceNodeId,
        ],
      );
      // Personal Jane has alias "Janie"; reference Marcus has alias "Marcus".
      await client.query(
        `INSERT INTO "aliases"("id","user_id","alias_text","normalized_alias_text","canonical_node_id")
           VALUES ($1,$3,'Janie','janie',$4),($2,$3,'Marcus','marcus',$5)`,
        [
          newTypeId("alias"),
          newTypeId("alias"),
          userId,
          personalNodeId,
          referenceNodeId,
        ],
      );

      const { resolveIdentity } = await import("./identity-resolution");

      const aliasHit = await resolveIdentity({
        userId,
        candidate: {
          proposedLabel: "Janie",
          normalizedLabel: "janie",
          nodeType: "Person",
          scope: "personal",
        },
      });
      expect(aliasHit.resolvedNodeId).toBe(personalNodeId);
      expect(aliasHit.decision.signal).toBe("alias");

      // A personal candidate aliased "Marcus" must NOT merge into the
      // reference node; cross-scope refusal recorded in the trace.
      const refused = await resolveIdentity({
        userId,
        candidate: {
          proposedLabel: "Marcus",
          normalizedLabel: "marcus",
          nodeType: "Person",
          scope: "personal",
        },
      });
      expect(refused.resolvedNodeId).toBeNull();
      const aliasTrace = refused.decision.trace.find(
        (t) => t.signal === "alias",
      );
      expect(aliasTrace?.crossScopeRefusal).toMatchObject({
        nodeId: referenceNodeId,
        otherScope: "reference",
      });
    });
  });

  it("signal 3 — embedding similarity resolves within scope; reference-only candidate refused", async () => {
    await withDb(async (client) => {
      const userId = "user_embed";
      const personalNodeId = newTypeId("node");
      const referenceNodeId = newTypeId("node");
      const personalSourceId = newTypeId("source");
      const referenceSourceId = newTypeId("source");
      await createIdentityTables(client);
      await client.query(`INSERT INTO "users"("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources"("id","user_id","type","external_id","scope")
           VALUES ($1,$3,'document','pe','personal'),($2,$3,'document','re','reference')`,
        [personalSourceId, referenceSourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes"("id","user_id","node_type")
           VALUES ($1,$3,'Concept'),($2,$3,'Concept')`,
        [personalNodeId, referenceNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata"("id","node_id","label","canonical_label")
           VALUES ($1,$3,'Personal Idea','personal idea'),($2,$4,'Reference Idea','reference idea')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          personalNodeId,
          referenceNodeId,
        ],
      );
      await client.query(
        `INSERT INTO "source_links"("id","source_id","node_id")
           VALUES ($1,$3,$5),($2,$4,$6)`,
        [
          newTypeId("source_link"),
          newTypeId("source_link"),
          personalSourceId,
          referenceSourceId,
          personalNodeId,
          referenceNodeId,
        ],
      );
      // Both nodes get the SAME embedding (unit vector at dim 0). Cosine
      // similarity == 1.0 against a query of the same vector. Scope alone is
      // what differentiates them.
      await client.query(
        `INSERT INTO "node_embeddings"("id","node_id","embedding","model_name")
           VALUES
             ($1,$3,array_prepend(1::real, array_fill(0::real, ARRAY[1023]))::vector,'test'),
             ($2,$4,array_prepend(1::real, array_fill(0::real, ARRAY[1023]))::vector,'test')`,
        [
          newTypeId("node_embedding"),
          newTypeId("node_embedding"),
          personalNodeId,
          referenceNodeId,
        ],
      );

      const { resolveIdentity } = await import("./identity-resolution");
      const embedding = unitVector(0);

      // Personal candidate must not be helped by the reference node, even
      // though both have identical embeddings.
      const personalHit = await resolveIdentity({
        userId,
        candidate: {
          proposedLabel: "fresh personal idea",
          normalizedLabel: "fresh personal idea",
          nodeType: "Concept",
          scope: "personal",
          embedding,
          // No supporting claims → signal 4 cannot fire; embedding alone is
          // intentionally not enough to merge.
        },
      });
      expect(personalHit.resolvedNodeId).toBeNull();
      const embedTrace = personalHit.decision.trace.find(
        (t) => t.signal === "embedding_sim",
      );
      expect(embedTrace?.fired).toBe(true);
      expect(
        embedTrace?.signal === "embedding_sim" &&
          embedTrace.candidates.map((c) => c.nodeId),
      ).toEqual([personalNodeId]);
    });
  });

  it("signal 4 — claim profile compatibility picks the matching node and ignores assistant_inferred contributions", async () => {
    await withDb(async (client) => {
      const userId = "user_profile";
      const matchNodeId = newTypeId("node");
      const decoyNodeId = newTypeId("node");
      const colleagueNodeId = newTypeId("node");
      const personalSourceId = newTypeId("source");
      await createIdentityTables(client);
      await client.query(`INSERT INTO "users"("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources"("id","user_id","type","external_id","scope")
           VALUES ($1,$2,'document','prof','personal')`,
        [personalSourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes"("id","user_id","node_type")
           VALUES ($1,$4,'Person'),($2,$4,'Person'),($3,$4,'Person')`,
        [matchNodeId, decoyNodeId, colleagueNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata"("id","node_id","label","canonical_label")
           VALUES
             ($1,$4,'Match','match'),
             ($2,$5,'Decoy','decoy'),
             ($3,$6,'Colleague','colleague')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          matchNodeId,
          decoyNodeId,
          colleagueNodeId,
        ],
      );
      await client.query(
        `INSERT INTO "source_links"("id","source_id","node_id")
           VALUES ($1,$4,$5),($2,$4,$6),($3,$4,$7)`,
        [
          newTypeId("source_link"),
          newTypeId("source_link"),
          newTypeId("source_link"),
          personalSourceId,
          matchNodeId,
          decoyNodeId,
          colleagueNodeId,
        ],
      );
      // Both candidate-side nodes get identical embeddings so signal 3 yields
      // BOTH as embedding-near; signal 4 must break the tie.
      await client.query(
        `INSERT INTO "node_embeddings"("id","node_id","embedding","model_name")
           VALUES
             ($1,$3,array_prepend(1::real, array_fill(0::real, ARRAY[1023]))::vector,'test'),
             ($2,$4,array_prepend(1::real, array_fill(0::real, ARRAY[1023]))::vector,'test')`,
        [
          newTypeId("node_embedding"),
          newTypeId("node_embedding"),
          matchNodeId,
          decoyNodeId,
        ],
      );
      // matchNode has user-asserted profile: HAS_GOAL=ship-q4, OWNED_BY→colleague.
      // decoyNode has the same shape, but only as `assistant_inferred`, so it
      // must NOT contribute to profile compatibility.
      const matchClaim1 = newTypeId("claim");
      const matchClaim2 = newTypeId("claim");
      const decoyClaim1 = newTypeId("claim");
      const decoyClaim2 = newTypeId("claim");
      await client.query(
        `INSERT INTO "claims"(
            "id","user_id","subject_node_id","object_node_id","object_value",
            "predicate","statement","source_id","scope","asserted_by_kind","stated_at","status")
           VALUES
             ($1,$5,$6,NULL,'ship-q4','HAS_GOAL','match goal',$7,'personal','user',now(),'active'),
             ($2,$5,$6,$8,NULL,'OWNED_BY','match owns colleague',$7,'personal','user',now(),'active'),
             ($3,$5,$9,NULL,'ship-q4','HAS_GOAL','decoy goal',$7,'personal','assistant_inferred',now(),'active'),
             ($4,$5,$9,$8,NULL,'OWNED_BY','decoy owns colleague',$7,'personal','assistant_inferred',now(),'active')`,
        [
          matchClaim1,
          matchClaim2,
          decoyClaim1,
          decoyClaim2,
          userId,
          matchNodeId,
          personalSourceId,
          colleagueNodeId,
          decoyNodeId,
        ],
      );

      const { resolveIdentity } = await import("./identity-resolution");

      const resolution = await resolveIdentity({
        userId,
        candidate: {
          proposedLabel: "Newly Mentioned Person",
          normalizedLabel: "newly mentioned person",
          nodeType: "Person",
          scope: "personal",
          embedding: unitVector(0),
          supportingClaimsForCompat: [
            {
              predicate: "HAS_GOAL",
              objectValue: "ship-q4",
              assertedByKind: "user",
            },
            {
              predicate: "OWNED_BY",
              objectNodeId: colleagueNodeId,
              assertedByKind: "user",
            },
          ],
        },
      });

      expect(resolution.resolvedNodeId).toBe(matchNodeId);
      expect(resolution.decision.signal).toBe("profile_compat");
      const profileTrace = resolution.decision.trace.find(
        (t) => t.signal === "profile_compat",
      );
      expect(profileTrace?.fired).toBe(true);
      // The decoy must not appear in the firing-candidate list because its
      // claims are all `assistant_inferred`.
      expect(
        profileTrace?.signal === "profile_compat" &&
          profileTrace.candidates.map((c) => c.nodeId),
      ).toEqual([matchNodeId]);
    });
  });

  it("logs identity.cross_scope_merge_refused when a personal candidate matches only a reference alias", async () => {
    await withDb(async (client) => {
      const userId = "user_xscope_log";
      const referenceNodeId = newTypeId("node");
      const referenceSourceId = newTypeId("source");
      await createIdentityTables(client);
      await client.query(`INSERT INTO "users"("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources"("id","user_id","type","external_id","scope")
           VALUES ($1,$2,'document','rxs','reference')`,
        [referenceSourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes"("id","user_id","node_type") VALUES ($1,$2,'Person')`,
        [referenceNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata"("id","node_id","label","canonical_label")
           VALUES ($1,$2,'Marcus Aurelius','marcus aurelius')`,
        [newTypeId("node_metadata"), referenceNodeId],
      );
      await client.query(
        `INSERT INTO "source_links"("id","source_id","node_id") VALUES ($1,$2,$3)`,
        [newTypeId("source_link"), referenceSourceId, referenceNodeId],
      );
      await client.query(
        `INSERT INTO "aliases"("id","user_id","alias_text","normalized_alias_text","canonical_node_id")
           VALUES ($1,$2,'Marcus','marcus',$3)`,
        [newTypeId("alias"), userId, referenceNodeId],
      );

      const logSpy = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);
      try {
        const { resolveIdentity } = await import("./identity-resolution");
        const result = await resolveIdentity({
          userId,
          candidate: {
            proposedLabel: "Marcus",
            normalizedLabel: "marcus",
            nodeType: "Person",
            scope: "personal",
          },
        });

        expect(result.resolvedNodeId).toBeNull();

        const refusalLogs = logSpy.mock.calls
          .map((args) => String(args[0] ?? ""))
          .filter((line) => line.includes("identity.cross_scope_merge_refused"));
        expect(refusalLogs.length).toBeGreaterThan(0);
        const parsed = JSON.parse(refusalLogs[0] ?? "{}");
        expect(parsed).toMatchObject({
          event: "identity.cross_scope_merge_refused",
          userId,
          candidateScope: "personal",
          rejectedNodeId: referenceNodeId,
          rejectedScope: "reference",
        });
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  it("decision trace records every signal attempted, in order", async () => {
    await withDb(async (client) => {
      const userId = "user_trace";
      await createIdentityTables(client);
      await client.query(`INSERT INTO "users"("id") VALUES ($1)`, [userId]);

      const { resolveIdentity } = await import("./identity-resolution");
      const result = await resolveIdentity({
        userId,
        candidate: {
          proposedLabel: "Nothing Here",
          normalizedLabel: "nothing here",
          nodeType: "Person",
          scope: "personal",
          // No embedding → signal 3 is skipped explicitly with reason.
        },
      });

      expect(result.resolvedNodeId).toBeNull();
      expect(result.decision.signal).toBe("none");
      expect(result.decision.confidence).toBe(0);
      expect(result.decision.trace.map((t) => t.signal)).toEqual([
        "canonical_label",
        "alias",
        "embedding_sim",
        "profile_compat",
      ]);
      const embedTrace = result.decision.trace.find(
        (t) => t.signal === "embedding_sim",
      );
      expect(embedTrace?.signal === "embedding_sim" && embedTrace.skipped).toBe(
        "no_embedding",
      );
      const profileTrace = result.decision.trace.find(
        (t) => t.signal === "profile_compat",
      );
      expect(
        profileTrace?.signal === "profile_compat" && profileTrace.skipped,
      ).toBe("no_embedding_candidates");
    });
  });
});
