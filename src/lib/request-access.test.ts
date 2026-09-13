import { createApp, toWebHandler } from "h3";
import { describe, expect, it } from "vitest";
import accessScopeMiddleware from "~/middleware/access-scope";

describe("memory access scope middleware", () => {
  function request(scope?: string): Promise<Response> {
    const headers = scope === undefined ? {} : { "x-memory-access-scope": scope };
    return toWebHandler(createApp().use(accessScopeMiddleware))(
      new Request("http://memory.test/", { headers }),
    );
  }

  it("accepts the explicit workspace scope", async () => {
    await expect(request("workspace")).resolves.toHaveProperty("status", 200);
  });

  it("keeps omitted scope strict", async () => {
    await expect(request()).resolves.toHaveProperty("status", 200);
  });

  it("rejects unknown scopes at the HTTP boundary", async () => {
    const response = await request("all");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      data: { code: "INVALID_ACCESS_SCOPE" },
    });
  });
});
