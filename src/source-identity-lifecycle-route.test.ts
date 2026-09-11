import handler from "./routes/sources/identity/lifecycle.post";
import { createApp, toWebHandler } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartitionAccessError } from "~/lib/partition-access";
import { newTypeId } from "~/types/typeid";

const mocks = vi.hoisted(() => ({
  ensureUser: vi.fn(),
  assertPartitionReadAllowed: vi.fn(),
  applySourceIdentityLifecycle: vi.fn(),
}));

vi.mock("~/lib/ingestion/ensure-user", () => ({
  ensureUser: mocks.ensureUser,
}));
vi.mock("~/lib/partition-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/partition-access")>()),
  assertPartitionReadAllowed: mocks.assertPartitionReadAllowed,
}));
vi.mock("~/lib/source-identity-lifecycle", () => ({
  applySourceIdentityLifecycle: mocks.applySourceIdentityLifecycle,
}));
vi.mock("~/utils/db", () => ({
  useDatabase: async (): Promise<unknown> => ({}),
}));

describe("POST /sources/identity/lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function request(input: unknown): Promise<Response> {
    return toWebHandler(createApp().use(handler))(
      new Request("http://memory.test/sources/identity/lifecycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  }

  it("retires a stable identity and returns the source that won the race", async () => {
    const source = {
      sourceId: newTypeId("source"),
      partitionKey: "radar:mail",
      sourceVersion: 2,
      type: "document",
      externalId: "radar-gmail:opaque",
    };
    const input = {
      userId: "user_mail",
      partitionKey: "radar:mail",
      identities: [{ type: "document", externalId: "radar-gmail:opaque" }],
      action: "retire",
    };
    mocks.applySourceIdentityLifecycle.mockResolvedValue({ sources: [source] });

    const response = await request(input);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sources: [source],
    });
    expect(mocks.ensureUser).toHaveBeenCalledWith({}, input.userId);
    expect(mocks.assertPartitionReadAllowed).toHaveBeenCalledWith(
      {},
      input.userId,
      input.partitionKey,
    );
    expect(mocks.applySourceIdentityLifecycle).toHaveBeenCalledWith({}, input);
  });

  it("restores an identity even when no source exists", async () => {
    mocks.applySourceIdentityLifecycle.mockResolvedValue({ sources: [] });
    const response = await request({
      userId: "user_mail",
      partitionKey: "radar:mail",
      identities: [{ type: "document", externalId: "radar-gmail:missing" }],
      action: "restore",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sources: [] });
  });

  it.each(["manual", "legacy_migration", "unknown"])(
    "rejects unsupported identity type %s before changing state",
    async (type) => {
      const response = await request({
        userId: "user_mail",
        identities: [
          { type: "document", externalId: "supported" },
          { type, externalId: "unsupported" },
        ],
        action: "retire",
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toMatchObject({
        statusMessage: "Validation Error",
        data: { name: "ZodError" },
      });
      expect(JSON.parse(body.data.message)).toMatchObject([
        { path: ["identities", 1, "type"], code: "invalid_value" },
      ]);
      expect(mocks.ensureUser).not.toHaveBeenCalled();
      expect(mocks.applySourceIdentityLifecycle).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["unregistered partition", "assertPartitionReadAllowed"],
    ["identity in another partition", "applySourceIdentityLifecycle"],
  ] as const)("returns a structured conflict for %s", async (_, operation) => {
    mocks[operation].mockRejectedValueOnce(
      new PartitionAccessError("PARTITION_UNAUTHORIZED", "Partition denied"),
    );
    const response = await request({
      userId: "user_mail",
      partitionKey: "radar:mail",
      identities: [{ type: "document", externalId: "radar-gmail:opaque" }],
      action: "retire",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      statusMessage: "Partition denied",
      data: { code: "PARTITION_UNAUTHORIZED" },
    });
    if (operation === "assertPartitionReadAllowed") {
      expect(mocks.applySourceIdentityLifecycle).not.toHaveBeenCalled();
    }
  });
});
