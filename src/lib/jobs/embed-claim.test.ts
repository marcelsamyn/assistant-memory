import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { claimEmbeddings, users } from "~/db/schema";
import { newTypeId } from "~/types/typeid";

process.env["DATABASE_URL"] ??=
  "postgres://postgres:postgres@localhost:5431/postgres";
process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "https://api.openai.com/v1";
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test-model";
process.env["JINA_API_KEY"] ??= "test";
process.env["REDIS_URL"] ??= "redis://localhost:6380";
process.env["MINIO_ENDPOINT"] ??= "localhost";
process.env["MINIO_ACCESS_KEY"] ??= "test";
process.env["MINIO_SECRET_KEY"] ??= "test";
process.env["SOURCES_BUCKET"] ??= "test";

const { createMigratedTestDb, isServerReachable } = await import(
  "~/lib/search/test-db"
);
const describeIfServer = (await isServerReachable()) ? describe : describe.skip;

const embeddingInputs: string[][] = [];
let failNextEmbedding = false;
const queuedJobs: Array<{ name: string; data: unknown; opts: unknown }> = [];

describeIfServer("claim embedding job", () => {
  const userId = "user_embed_claim";
  let handle: Awaited<ReturnType<typeof createMigratedTestDb>>;

  beforeAll(async () => {
    handle = await createMigratedTestDb(
      `memory_embed_claim_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    );
    await handle.db.insert(users).values([{ id: userId }, { id: "other" }]);

    // The suite shares one module registry, so mocks must replace modules
    // that earlier files already loaded.
    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => handle.db }));
    vi.doMock("~/lib/embeddings", () => ({
      generateEmbeddings: async (params: { input: string[] }) => {
        embeddingInputs.push(params.input);
        if (failNextEmbedding) {
          failNextEmbedding = false;
          throw new Error("Jina API error: 503 Service Unavailable");
        }
        return {
          data: params.input.map(() => ({
            embedding: Array.from({ length: 1024 }, () => 0.01),
          })),
        };
      },
    }));
    vi.doMock("~/lib/queues", () => ({
      batchQueue: {
        add: async (name: string, data: unknown, opts: unknown) => {
          queuedJobs.push({ name, data, opts });
        },
      },
    }));
    vi.doMock("~/lib/context/cache", () => ({
      invalidateCachedBundle: async () => undefined,
    }));
  });

  afterAll(async () => {
    vi.doUnmock("~/utils/db");
    vi.doUnmock("~/lib/embeddings");
    vi.doUnmock("~/lib/queues");
    vi.doUnmock("~/lib/context/cache");
    vi.resetModules();
    await handle?.drop();
  });

  beforeEach(() => {
    embeddingInputs.length = 0;
    queuedJobs.length = 0;
  });

  it("returns a status change without calling the embedding API, then embeds it once across retries", async () => {
    const { createCommitment, setCommitmentStatus } = await import(
      "~/lib/commitments"
    );
    const { embedClaim, EmbedClaimJobInputSchema } = await import(
      "./embed-claim"
    );
    const created = await createCommitment({
      userId,
      label: "Send the spec",
      status: "pending",
      assertedByKind: "user",
    });
    embeddingInputs.length = 0;
    queuedJobs.length = 0;

    const changed = await setCommitmentStatus({
      userId,
      taskId: created.taskId,
      status: "done",
      assertedByKind: "user",
    });

    expect(embeddingInputs).toEqual([]);
    const embedJobs = queuedJobs.filter((job) => job.name === "embed-claim");
    expect(embedJobs).toHaveLength(1);
    const job = EmbedClaimJobInputSchema.parse(embedJobs[0]!.data);
    expect(job).toMatchObject({ userId, claimId: changed.claimId });
    expect(job.text).toMatch(
      /^HAS_TASK_STATUS Task marked done\. status=active statedAt=/,
    );
    expect(embedJobs[0]!.opts).toMatchObject({
      jobId: `embed-claim:${changed.claimId}`,
      attempts: 3,
    });

    failNextEmbedding = true;
    await expect(embedClaim(handle.db, job)).rejects.toThrow("503");
    await embedClaim(handle.db, job);
    await embedClaim(handle.db, job);

    expect(embeddingInputs).toEqual([[job.text], [job.text]]);
    const stored = await handle.db
      .select({ id: claimEmbeddings.id })
      .from(claimEmbeddings)
      .where(eq(claimEmbeddings.claimId, changed.claimId));
    expect(stored).toHaveLength(1);
  });

  it("skips a claim that was deleted or belongs to another user", async () => {
    const { createCommitment } = await import("~/lib/commitments");
    const { embedClaim } = await import("./embed-claim");
    const created = await createCommitment({
      userId,
      label: "Book the venue",
      status: "pending",
      assertedByKind: "user",
    });
    embeddingInputs.length = 0;

    await embedClaim(handle.db, {
      userId,
      claimId: newTypeId("claim"),
      text: "missing",
    });
    await embedClaim(handle.db, {
      userId: "other",
      claimId: created.statusClaimId,
      text: "foreign",
    });

    expect(embeddingInputs).toEqual([]);
    const stored = await handle.db
      .select({ id: claimEmbeddings.id })
      .from(claimEmbeddings)
      .where(eq(claimEmbeddings.claimId, created.statusClaimId));
    expect(stored).toHaveLength(0);
  });
});
