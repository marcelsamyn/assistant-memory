import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pruneStaleNodes: vi.fn(),
  pruneOrphanNodes: vi.fn(),
  getRequestAccessScope: vi.fn(() => "workspace"),
  resolveWorkspacePartitions: vi.fn(),
  assertPartitionReadAllowed: vi.fn(),
}));

vi.mock("~/lib/jobs/prune-stale-nodes", () => ({
  pruneStaleNodes: mocks.pruneStaleNodes,
}));
vi.mock("~/lib/jobs/prune-orphan-nodes", () => ({
  pruneOrphanNodes: mocks.pruneOrphanNodes,
}));
vi.mock("~/lib/partition-access", () => ({
  assertPartitionReadAllowed: mocks.assertPartitionReadAllowed,
}));
vi.mock("~/lib/request-access", () => ({
  getRequestAccessScope: mocks.getRequestAccessScope,
}));
vi.mock("~/lib/workspace-partitions", () => ({
  resolveWorkspacePartitions: mocks.resolveWorkspacePartitions,
}));
vi.mock("~/utils/db", () => ({ useDatabase: vi.fn().mockResolvedValue({}) }));

const staleResult = (partitionKey: string, deletedCount: number) => ({
  dryRun: false,
  appliedThreshold: 0.5,
  minIdleDays: 30,
  scannedCount: deletedCount,
  candidateCount: deletedCount,
  deletedCount,
  hasMore: false,
  scannedNodeTypes: ["Person"],
  candidates: [],
  partitionKey,
});

const orphanResult = (partitionKey: string, deletedCount: number) => ({
  dryRun: false,
  sourceScanCount: 0,
  sourceScanHasMore: false,
  missingBlobSourceCandidateCount: 0,
  deletedMissingBlobSourceCount: 0,
  candidateCount: deletedCount,
  deletedCount,
  hasMore: false,
  scannedNodeTypes: ["Person"],
  missingBlobSources: [],
  candidates: [],
  partitionKey,
});

function request(path: string): Request {
  return new Request(`http://memory.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "user_prune", limit: 3, dryRun: false }),
  });
}

describe("workspace deterministic prune routes", () => {
  beforeEach(() => {
    mocks.getRequestAccessScope.mockReturnValue("workspace");
    mocks.resolveWorkspacePartitions.mockResolvedValue([
      "room:one",
      "room:two",
    ]);
    mocks.assertPartitionReadAllowed.mockResolvedValue(undefined);
    mocks.pruneStaleNodes.mockImplementation(async (params) =>
      staleResult(params.partitionKey, params.limit === 3 ? 3 : 0),
    );
    mocks.pruneOrphanNodes.mockImplementation(async (params) =>
      orphanResult(params.partitionKey, params.limit === 3 ? 3 : 0),
    );
  });

  it("keeps stale pruning under one total limit and stops at zero", async () => {
    const route = (await import("~/routes/maintenance/prune-stale-nodes.post"))
      .default;
    const response = await toWebHandler(createApp().use(route))(
      request("/maintenance/prune-stale-nodes"),
    );

    expect(response.status).toBe(200);
    expect(mocks.pruneStaleNodes).toHaveBeenCalledTimes(1);
    expect(mocks.pruneStaleNodes).toHaveBeenCalledWith(
      expect.objectContaining({ partitionKey: "room:one", limit: 3 }),
      expect.anything(),
    );
    expect(mocks.assertPartitionReadAllowed).toHaveBeenCalledTimes(2);
  });

  it("keeps orphan pruning under one total limit and stops at zero", async () => {
    const route = (await import("~/routes/maintenance/prune-orphan-nodes.post"))
      .default;
    const response = await toWebHandler(createApp().use(route))(
      request("/maintenance/prune-orphan-nodes"),
    );

    expect(response.status).toBe(200);
    expect(mocks.pruneOrphanNodes).toHaveBeenCalledTimes(1);
    expect(mocks.pruneOrphanNodes).toHaveBeenCalledWith(
      expect.objectContaining({ partitionKey: "room:one", limit: 3 }),
      expect.anything(),
    );
  });
});
