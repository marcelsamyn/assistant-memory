import handler from "./routes/node/sources.post";
import { createApp, readBody, toWebHandler } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getNodeSources: vi.fn() }));

vi.mock("~/lib/node", () => ({ getNodeSources: mocks.getNodeSources }));

describe("POST /node/sources", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a source ID with a 400 that points to source operations", async () => {
    vi.stubGlobal("readBody", readBody);
    const response = await toWebHandler(createApp().use(handler))(
      new Request("http://memory.test/node/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "user_sources",
          nodeId: "src_01m34wpw4fesks6rketcme5875",
        }),
      }),
    );

    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      statusMessage: "Invalid request body",
      data: {
        issues: [
          {
            path: ["nodeId"],
            message: expect.stringContaining(
              "received a source ID. Use a source operation for this ID instead.",
            ),
          },
        ],
      },
    });
    expect(mocks.getNodeSources).not.toHaveBeenCalled();
  });
});
