import handler from "./routes/sources/processing/retry.post";
import type { H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ retrySourceProcessing: vi.fn() }));
vi.mock("~/lib/ingestion/retry-source-processing", () => mocks);

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
});
