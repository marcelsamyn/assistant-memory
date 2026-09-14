import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import route from "~/routes/cleanup";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  getRequestAccessScope: vi.fn(() => "workspace"),
}));

vi.mock("~/lib/queues", () => ({
  batchQueue: { add: mocks.add },
}));

vi.mock("~/lib/request-access", () => ({
  getRequestAccessScope: mocks.getRequestAccessScope,
}));

function routeFetch(request: Request): Promise<Response> {
  return toWebHandler(createApp().use(route))(request);
}

describe("POST /cleanup", () => {
  beforeEach(() => {
    mocks.add.mockReset();
    mocks.getRequestAccessScope.mockReturnValue("workspace");
  });

  it("rejects workspace cleanup before enqueueing the graph job", async () => {
    const response = await routeFetch(
      new Request("http://memory.test/cleanup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "user_cleanup",
          partitionKey: "workspace:blocked",
          since: "2026-01-01T00:00:00.000Z",
        }),
      }),
    );

    expect(response.status).toBe(500);
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("keeps strict partition cleanup fail-closed", async () => {
    mocks.getRequestAccessScope.mockReturnValue("partition");

    const response = await routeFetch(
      new Request("http://memory.test/cleanup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "user_cleanup",
          partitionKey: "workspace:allowed",
          since: "2026-01-01T00:00:00.000Z",
        }),
      }),
    );

    expect(response.status).toBe(500);
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
