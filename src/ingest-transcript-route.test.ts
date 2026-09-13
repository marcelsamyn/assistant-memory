import handler from "./routes/transcript/ingest.post";
import { createApp, createError, toWebHandler } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartitionAccessError } from "~/lib/partition-access";

const mocks = vi.hoisted(() => ({
  preparePartitionWrite: vi.fn(),
  ensurePersonalPartition: vi.fn(),
  assertPartitionReadAllowed: vi.fn(),
  ensureUser: vi.fn(),
  add: vi.fn(),
  assertWorkspaceOperationReady: vi.fn(),
  limit: vi.fn(),
}));

vi.mock("~/db", () => ({
  default: {
    select: () => ({
      from: () => ({ where: () => ({ limit: mocks.limit }) }),
    }),
  },
}));
vi.mock("~/lib/ingestion/ensure-user", () => ({
  ensureUser: mocks.ensureUser,
}));
vi.mock("~/lib/partition-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/partition-access")>()),
  preparePartitionWrite: mocks.preparePartitionWrite,
  ensurePersonalPartition: mocks.ensurePersonalPartition,
  assertPartitionReadAllowed: mocks.assertPartitionReadAllowed,
}));
vi.mock("~/lib/queues", () => ({ batchQueue: { add: mocks.add } }));
vi.mock("~/lib/workspace-partitions", () => ({
  assertWorkspaceOperationReady: mocks.assertWorkspaceOperationReady,
}));

function requestTranscript(options?: {
  partitionKey?: string | undefined;
  workspace?: boolean;
}): Request {
  const workspace = options?.workspace ?? false;
  const partitionKey = options ? options.partitionKey : "room:client";
  return new Request("http://memory.test/transcript/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(workspace ? { "x-memory-access-scope": "workspace" } : {}),
    },
    body: JSON.stringify({
      userId: "user_transcript",
      ...(partitionKey === undefined ? {} : { partitionKey }),
      transcriptId: "transcript-1",
      occurredAt: "2026-09-10T09:00:00.000Z",
      content: { kind: "raw", text: "Remember this" },
    }),
  });
}

describe("POST /transcript/ingest", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    new PartitionAccessError("PARTITION_UNAUTHORIZED", "Partition denied"),
    new PartitionAccessError(
      "PARTITION_MIGRATION_REQUIRED",
      "Migration required",
    ),
  ])("returns the structured $code conflict", async (error) => {
    mocks.preparePartitionWrite.mockRejectedValueOnce(error);

    const response = await toWebHandler(createApp().use(handler))(
      requestTranscript(),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ statusMessage: error.message });
    expect(body.data).toEqual({ code: error.code });
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it.each([403, 409])(
    "preserves unrelated %i H3 errors",
    async (statusCode) => {
      mocks.preparePartitionWrite.mockRejectedValueOnce(
        createError({
          statusCode,
          statusMessage: "Transcript source unavailable",
          data: { reason: "source_conflict" },
        }),
      );

      const response = await toWebHandler(createApp().use(handler))(
        requestTranscript(),
      );

      expect(response.status).toBe(statusCode);
      await expect(response.json()).resolves.toMatchObject({
        statusMessage: "Transcript source unavailable",
        data: { reason: "source_conflict" },
      });
      expect(mocks.add).not.toHaveBeenCalled();
    },
  );

  it("fails a new workspace transcript before source mutation during migration", async () => {
    const error = new PartitionAccessError(
      "PARTITION_REQUIRED",
      "Workspace operation is unavailable during migration",
    );
    mocks.limit.mockResolvedValue([]);
    mocks.assertWorkspaceOperationReady.mockRejectedValueOnce(error);

    const response = await toWebHandler(createApp().use(handler))(
      requestTranscript({ partitionKey: undefined, workspace: true }),
    );

    expect(response.status).toBe(409);
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.preparePartitionWrite).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("resolves a new migrated workspace transcript before readiness checks", async () => {
    mocks.limit.mockResolvedValue([]);
    mocks.ensurePersonalPartition.mockResolvedValue("memory:personal");
    mocks.assertWorkspaceOperationReady.mockResolvedValue(undefined);
    mocks.assertPartitionReadAllowed.mockRejectedValue(
      new PartitionAccessError("PARTITION_UNAUTHORIZED", "Partition denied"),
    );

    const response = await toWebHandler(createApp().use(handler))(
      requestTranscript({ partitionKey: undefined, workspace: true }),
    );

    expect(response.status).toBe(409);
    expect(mocks.ensurePersonalPartition).toHaveBeenCalledWith(
      expect.anything(),
      "user_transcript",
    );
    expect(mocks.assertWorkspaceOperationReady).toHaveBeenCalledWith(
      expect.anything(),
      "user_transcript",
      ["memory:personal"],
      "workspace",
    );
    expect(mocks.assertPartitionReadAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "user_transcript",
      "memory:personal",
    );
    expect(mocks.preparePartitionWrite).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("does not enqueue an existing transcript in a quarantined partition", async () => {
    mocks.limit.mockResolvedValue([{ partitionKey: "room:quarantined" }]);
    mocks.assertWorkspaceOperationReady.mockResolvedValue(undefined);
    mocks.assertPartitionReadAllowed.mockRejectedValue(
      new PartitionAccessError("PARTITION_UNAUTHORIZED", "Partition denied"),
    );

    const response = await toWebHandler(createApp().use(handler))(
      requestTranscript({ partitionKey: undefined, workspace: true }),
    );

    expect(response.status).toBe(409);
    expect(mocks.assertPartitionReadAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "user_transcript",
      "room:quarantined",
    );
    expect(mocks.preparePartitionWrite).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("does not mutate or enqueue a tombstoned workspace transcript", async () => {
    mocks.limit.mockResolvedValue([
      {
        id: "source_deleted",
        partitionKey: "room:deleted",
        deletedAt: new Date(),
      },
    ]);

    const response = await toWebHandler(createApp().use(handler))(
      requestTranscript({ partitionKey: undefined, workspace: true }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.data).toEqual({ code: "SOURCE_TOMBSTONED" });
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.preparePartitionWrite).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
