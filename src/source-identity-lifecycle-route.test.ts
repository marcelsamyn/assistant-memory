import handler from "./routes/sources/identity/lifecycle.post";
import type { H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newTypeId } from "~/types/typeid";

const mocks = vi.hoisted(() => ({
  ensureUser: vi.fn(),
  assertPartitionReadAllowed: vi.fn(),
  applySourceIdentityLifecycle: vi.fn(),
}));

vi.mock("~/lib/ingestion/ensure-user", () => ({
  ensureUser: mocks.ensureUser,
}));
vi.mock("~/lib/partition-access", () => ({
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
    vi.stubGlobal("readBody", async () => input);
    mocks.applySourceIdentityLifecycle.mockResolvedValue({ sources: [source] });

    await expect(handler({} as H3Event)).resolves.toEqual({
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
    vi.stubGlobal("readBody", async () => ({
      userId: "user_mail",
      partitionKey: "radar:mail",
      identities: [{ type: "document", externalId: "radar-gmail:missing" }],
      action: "restore",
    }));
    mocks.applySourceIdentityLifecycle.mockResolvedValue({ sources: [] });

    await expect(handler({} as H3Event)).resolves.toEqual({ sources: [] });
  });
});
