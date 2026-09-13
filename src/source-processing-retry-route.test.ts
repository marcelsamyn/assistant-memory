import handler from "./routes/sources/processing/retry.post";
import {
  createApp,
  createError,
  readBody,
  toWebHandler,
  type H3Event,
} from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartitionAccessError } from "~/lib/partition-access";

const mocks = vi.hoisted(() => ({ retrySourceProcessing: vi.fn() }));
vi.mock("~/lib/ingestion/retry-source-processing", () => mocks);
vi.mock("~/lib/ingestion/source-processing", () => ({
  resolveSourceProcessingPartition: vi.fn(),
}));
vi.mock("~/lib/request-access", () => ({
  getRequestAccessScope: vi.fn(() => "partition"),
}));
vi.mock("~/utils/db", () => ({
  useDatabase: async (): Promise<unknown> => ({}),
}));

describe("POST /sources/processing/retry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  it("passes the validated owned operation to the shared retry service", async () => {
    const input = {
      userId: "user-1",
      partitionKey: "opaque:project-1",
      operationId: "operation-1",
    };
    const result = { processing: { operationId: input.operationId } };
    mocks.retrySourceProcessing.mockResolvedValue(result);
    vi.stubGlobal("readBody", async () => input);
    await expect(handler({} as H3Event)).resolves.toEqual(result);
    expect(mocks.retrySourceProcessing).toHaveBeenCalledWith(input);
  });

  it.each([
    new PartitionAccessError("PARTITION_UNAUTHORIZED", "Operation not found"),
    new PartitionAccessError("SOURCE_VERSION_CONFLICT", "Source changed", 4),
  ])("returns the structured $code conflict", async (error) => {
    mocks.retrySourceProcessing.mockRejectedValueOnce(error);
    vi.stubGlobal("readBody", readBody);

    const response = await toWebHandler(createApp().use(handler))(
      new Request("http://memory.test/sources/processing/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "user-1",
          partitionKey: "opaque:project-1",
          operationId: "operation-1",
        }),
      }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ statusMessage: error.message });
    expect(body.data).toEqual({
      code: error.code,
      ...(error.currentSourceVersion === undefined
        ? {}
        : { currentSourceVersion: error.currentSourceVersion }),
    });
  });

  it.each([
    createError({ statusCode: 409, statusMessage: "Job is still active" }),
    new Error("Queue unavailable"),
  ])("preserves unrelated errors: $message", async (error) => {
    mocks.retrySourceProcessing.mockRejectedValueOnce(error);
    vi.stubGlobal("readBody", async () => ({
      userId: "user-1",
      operationId: "operation-1",
    }));

    await expect(handler({} as H3Event)).rejects.toBe(error);
  });
});
