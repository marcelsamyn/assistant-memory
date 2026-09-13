import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PartitionAccessError } from "~/lib/partition-access";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  ensureUser: vi.fn(),
  ensurePersonalPartition: vi.fn(),
  assertPartitionReadAllowed: vi.fn(),
  assertWorkspaceOperationReady: vi.fn(),
  limit: vi.fn(),
  getRequestAccessScope: vi.fn(() => "workspace"),
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
  ensurePersonalPartition: mocks.ensurePersonalPartition,
  assertPartitionReadAllowed: mocks.assertPartitionReadAllowed,
}));
vi.mock("~/lib/queues", () => ({ batchQueue: { add: mocks.add } }));
vi.mock("~/lib/request-access", () => ({
  getRequestAccessScope: mocks.getRequestAccessScope,
}));
vi.mock("~/lib/workspace-partitions", () => ({
  assertWorkspaceOperationReady: mocks.assertWorkspaceOperationReady,
}));

describe("POST /ingest/conversation", () => {
  let handler: typeof import("./routes/ingest/conversation.post").default;

  beforeAll(async () => {
    vi.stubGlobal("defineEventHandler", (callback: unknown) => callback);
    handler = (await import("./routes/ingest/conversation.post")).default;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("does not enqueue a new workspace conversation during migration", async () => {
    mocks.limit.mockResolvedValue([]);
    mocks.assertWorkspaceOperationReady.mockRejectedValue(
      new PartitionAccessError(
        "PARTITION_REQUIRED",
        "Workspace operation is unavailable while memory partition migration is migrating",
      ),
    );
    vi.stubGlobal("readBody", async () => ({
      userId: "user_conversation_migrating",
      conversation: {
        id: "conversation-1",
        messages: [],
      },
    }));

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 409,
      data: { code: "PARTITION_REQUIRED" },
    });
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("resolves a new migrated workspace conversation before readiness checks", async () => {
    mocks.limit.mockResolvedValue([]);
    mocks.ensurePersonalPartition.mockResolvedValue("memory:personal");
    mocks.assertWorkspaceOperationReady.mockResolvedValue(undefined);
    mocks.assertPartitionReadAllowed.mockRejectedValue(
      new PartitionAccessError("PARTITION_UNAUTHORIZED", "Partition denied"),
    );
    vi.stubGlobal("readBody", async () => ({
      userId: "user_conversation_migrated",
      conversation: { id: "conversation-2", messages: [] },
    }));

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 409,
      data: { code: "PARTITION_UNAUTHORIZED" },
    });
    expect(mocks.ensurePersonalPartition).toHaveBeenCalledWith(
      expect.anything(),
      "user_conversation_migrated",
    );
    expect(mocks.assertWorkspaceOperationReady).toHaveBeenCalledWith(
      expect.anything(),
      "user_conversation_migrated",
      ["memory:personal"],
      "workspace",
    );
    expect(mocks.assertPartitionReadAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "user_conversation_migrated",
      "memory:personal",
    );
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("does not enqueue an existing conversation in a quarantined partition", async () => {
    mocks.limit.mockResolvedValue([{ partitionKey: "room:quarantined" }]);
    mocks.assertWorkspaceOperationReady.mockResolvedValue(undefined);
    mocks.assertPartitionReadAllowed.mockRejectedValue(
      new PartitionAccessError("PARTITION_UNAUTHORIZED", "Partition denied"),
    );
    vi.stubGlobal("readBody", async () => ({
      userId: "user_conversation_quarantined",
      conversation: { id: "conversation-3", messages: [] },
    }));

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 409,
      data: { code: "PARTITION_UNAUTHORIZED" },
    });
    expect(mocks.assertPartitionReadAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "user_conversation_quarantined",
      "room:quarantined",
    );
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("returns a structured conflict for an explicit partition mismatch", async () => {
    mocks.limit.mockResolvedValue([{ partitionKey: "room:other" }]);
    vi.stubGlobal("readBody", async () => ({
      userId: "user_conversation_partition_mismatch",
      partitionKey: "room:requested",
      conversation: { id: "conversation-mismatch", messages: [] },
    }));

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 409,
      data: { code: "PARTITION_UNAUTHORIZED" },
    });
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("does not enqueue a tombstoned workspace conversation", async () => {
    mocks.limit.mockResolvedValue([
      { partitionKey: "room:deleted", deletedAt: new Date() },
    ]);
    vi.stubGlobal("readBody", async () => ({
      userId: "user_conversation_deleted",
      conversation: { id: "conversation-deleted", messages: [] },
    }));

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 409,
      data: { code: "SOURCE_TOMBSTONED" },
    });
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
