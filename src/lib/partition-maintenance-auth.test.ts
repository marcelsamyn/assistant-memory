import { createApp, defineEventHandler, toWebHandler } from "h3";
import { describe, expect, it } from "vitest";
import { assertPartitionMaintenanceAuthorizedWithToken } from "~/lib/partition-maintenance-auth";

describe("partition maintenance authentication", () => {
  it("fails closed when the server credential is missing", async () => {
    const app = createApp().use(
      defineEventHandler((event) => {
        assertPartitionMaintenanceAuthorizedWithToken(event, undefined);
        return { ok: true };
      }),
    );
    const response = await toWebHandler(app)(
      new Request("http://memory.test/maintenance", {
        headers: { authorization: `Bearer ${"m".repeat(32)}` },
      }),
    );
    expect(response.status).toBe(503);
  });
});
