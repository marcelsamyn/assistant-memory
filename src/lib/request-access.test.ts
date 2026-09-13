import { createApp, defineEventHandler, toWebHandler } from "h3";
import { describe, expect, it } from "vitest";
import { getRequestAccessScope } from "~/lib/request-access";
import accessScopeMiddleware from "~/middleware/access-scope";

describe("memory access scope middleware", () => {
  function request(scope?: string): Promise<Response> {
    const headers =
      scope === undefined ? {} : { "x-memory-access-scope": scope };
    return toWebHandler(
      createApp()
        .use(accessScopeMiddleware)
        .use(
          defineEventHandler((event) => ({
            scope: getRequestAccessScope(event),
          })),
        ),
    )(new Request("http://memory.test/", { headers }));
  }

  it("accepts the explicit workspace scope", async () => {
    const response = await request("workspace");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ scope: "workspace" });
  });

  it("keeps omitted scope strict", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ scope: "partition" });
  });

  it("rejects unknown scopes at the HTTP boundary", async () => {
    const response = await request("all");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      data: { code: "INVALID_ACCESS_SCOPE" },
    });
  });
});
