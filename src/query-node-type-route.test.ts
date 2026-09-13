import handler from "./routes/query/node-type";
import type { H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OneHopNode } from "~/lib/graph";
import { queryNodeTypeResponseSchema } from "~/lib/schemas/query-node-type";
import { newTypeId } from "~/types/typeid";

const graphMocks = vi.hoisted(() => ({
  findDayNode: vi.fn(),
  findDayNodes: vi.fn(),
  findOneHopNodes: vi.fn(),
}));

const requestAccessMocks = vi.hoisted(() => ({
  getRequestAccessScope: vi.fn((): "partition" | "workspace" => "partition"),
}));

vi.mock("~/lib/graph", () => graphMocks);
vi.mock("~/lib/request-access", () => requestAccessMocks);

vi.mock("~/utils/db", () => ({
  useDatabase: async (): Promise<unknown> => ({}),
}));

describe("POST /query/node-type", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("maps one-hop node types to the public nodeType response field", async () => {
    const userId = "user_node_type";
    const dayNodeId = newTypeId("node");
    const personNodeId = newTypeId("node");
    const conceptNodeId = newTypeId("node");
    const emotionNodeId = newTypeId("node");
    const sourceClaimId = newTypeId("claim");
    const statedAt = new Date("2026-04-30T12:00:00.000Z");

    vi.stubGlobal("readBody", async () => ({
      userId,
      date: "2026-04-30",
      types: ["Person", "Emotion"],
      includeFormattedResult: false,
    }));
    graphMocks.findDayNode.mockResolvedValue(dayNodeId);
    graphMocks.findOneHopNodes.mockResolvedValue([
      {
        id: personNodeId,
        type: "Person",
        timestamp: statedAt,
        label: "Lila",
        description: "Assistant persona",
        claimId: sourceClaimId,
        claimSubjectId: personNodeId,
        claimObjectId: dayNodeId,
        predicate: "OCCURRED_ON",
        statement: "Lila tested memory on 2026-04-30.",
        scope: "personal",
        assertedByKind: "user",
        subjectLabel: "Lila",
        objectLabel: "2026-04-30",
      },
      {
        id: conceptNodeId,
        type: "Concept",
        timestamp: statedAt,
        label: "Memory Interface",
        description: null,
        claimId: newTypeId("claim"),
        claimSubjectId: conceptNodeId,
        claimObjectId: dayNodeId,
        predicate: "OCCURRED_ON",
        statement: "Memory Interface was discussed on 2026-04-30.",
        scope: "personal",
        assertedByKind: "user",
        subjectLabel: "Memory Interface",
        objectLabel: "2026-04-30",
      },
      {
        id: emotionNodeId,
        type: "Emotion",
        timestamp: statedAt,
        label: "Delighted",
        description: null,
        claimId: newTypeId("claim"),
        claimSubjectId: emotionNodeId,
        claimObjectId: dayNodeId,
        predicate: "OCCURRED_ON",
        statement: "Delighted occurred on 2026-04-30.",
        scope: "personal",
        assertedByKind: "user",
        subjectLabel: "Delighted",
        objectLabel: "2026-04-30",
      },
    ] satisfies OneHopNode[]);

    const response = queryNodeTypeResponseSchema.parse(
      await handler({} as H3Event),
    );

    expect(response.nodes).toEqual([
      {
        id: personNodeId,
        nodeType: "Person",
        metadata: {
          label: "Lila",
          description: "Assistant persona",
        },
      },
      {
        id: emotionNodeId,
        nodeType: "Emotion",
        metadata: {
          label: "Delighted",
        },
      },
    ]);
    expect(response.nodes.at(0)).not.toHaveProperty("type");
  });

  it("aggregates one-hop node types from every active workspace day node", async () => {
    const userId = "user_node_type_workspace";
    const dayNodeA = newTypeId("node");
    const dayNodeB = newTypeId("node");
    const personA = newTypeId("node");
    const personB = newTypeId("node");
    const statedAt = new Date("2026-04-30T12:00:00.000Z");

    requestAccessMocks.getRequestAccessScope.mockReturnValue("workspace");
    vi.stubGlobal("readBody", async () => ({
      userId,
      date: "2026-04-30",
      types: ["Person"],
      includeFormattedResult: false,
    }));
    graphMocks.findDayNodes.mockResolvedValue([dayNodeA, dayNodeB]);
    graphMocks.findOneHopNodes.mockResolvedValue([
      {
        id: personA,
        type: "Person",
        timestamp: statedAt,
        label: "Alice",
        description: null,
        claimId: newTypeId("claim"),
        claimSubjectId: personA,
        claimObjectId: dayNodeA,
        predicate: "OCCURRED_ON",
        statement: "Alice occurred on 2026-04-30.",
        scope: "personal",
        assertedByKind: "user",
        subjectLabel: "Alice",
        objectLabel: "2026-04-30",
      },
      {
        id: personB,
        type: "Person",
        timestamp: statedAt,
        label: "Bob",
        description: null,
        claimId: newTypeId("claim"),
        claimSubjectId: personB,
        claimObjectId: dayNodeB,
        predicate: "OCCURRED_ON",
        statement: "Bob occurred on 2026-04-30.",
        scope: "personal",
        assertedByKind: "user",
        subjectLabel: "Bob",
        objectLabel: "2026-04-30",
      },
    ] satisfies OneHopNode[]);

    const response = queryNodeTypeResponseSchema.parse(
      await handler({} as H3Event),
    );

    expect(graphMocks.findDayNodes).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      "2026-04-30",
      undefined,
      "workspace",
    );
    expect(graphMocks.findOneHopNodes).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      [dayNodeA, dayNodeB],
      { accessScope: "workspace" },
    );
    expect(response.nodes.map((node) => node.id)).toEqual([personA, personB]);
  });

  it("forwards every workspace day node when more than 64 partitions are active", async () => {
    const userId = "user_node_type_many_partitions";
    const dayNodeIds = Array.from({ length: 65 }, () => newTypeId("node"));
    const personNodeId = newTypeId("node");
    const statedAt = new Date("2026-05-02T12:00:00.000Z");

    requestAccessMocks.getRequestAccessScope.mockReturnValue("workspace");
    vi.stubGlobal("readBody", async () => ({
      userId,
      date: "2026-05-02",
      types: ["Person"],
      includeFormattedResult: false,
    }));
    graphMocks.findDayNodes.mockResolvedValue(dayNodeIds);
    graphMocks.findOneHopNodes.mockResolvedValue([
      {
        id: personNodeId,
        type: "Person",
        timestamp: statedAt,
        label: "Late partition person",
        description: null,
        claimId: newTypeId("claim"),
        claimSubjectId: personNodeId,
        claimObjectId: dayNodeIds.at(-1)!,
        predicate: "OCCURRED_ON",
        statement: "Late partition person occurred on 2026-05-02.",
        scope: "personal",
        assertedByKind: "user",
        subjectLabel: "Late partition person",
        objectLabel: "2026-05-02",
      },
    ] satisfies OneHopNode[]);

    const response = queryNodeTypeResponseSchema.parse(
      await handler({} as H3Event),
    );

    expect(graphMocks.findDayNodes).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      "2026-05-02",
      undefined,
      "workspace",
    );
    expect(graphMocks.findOneHopNodes).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      dayNodeIds,
      { accessScope: "workspace" },
    );
    expect(response.nodes).toEqual([
      {
        id: personNodeId,
        nodeType: "Person",
        metadata: { label: "Late partition person" },
      },
    ]);
  });
});
