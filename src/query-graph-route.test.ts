import handler from "./routes/query/graph";
import type { H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryKnowledgeGraph: vi.fn(),
  getRequestAccessScope: vi.fn(),
}));

vi.mock("~/lib/query/graph", () => ({
  queryKnowledgeGraph: mocks.queryKnowledgeGraph,
}));
vi.mock("~/lib/request-access", () => ({
  getRequestAccessScope: mocks.getRequestAccessScope,
}));

describe("POST /query/graph", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("propagates explicit workspace access to the graph query", async () => {
    vi.stubGlobal("readBody", async () => ({
      userId: "workspace-user",
      maxNodes: 25,
    }));
    mocks.getRequestAccessScope.mockReturnValue("workspace");
    mocks.queryKnowledgeGraph.mockResolvedValue({ nodes: [], claims: [] });

    await expect(handler({} as H3Event)).resolves.toEqual({
      nodes: [],
      claims: [],
    });

    expect(mocks.queryKnowledgeGraph).toHaveBeenCalledWith({
      userId: "workspace-user",
      maxNodes: 25,
      accessScope: "workspace",
    });
  });
});
