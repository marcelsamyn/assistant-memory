import type { Job, Processor } from "bullmq";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import { newTypeId } from "~/types/typeid";

const mocks = vi.hoisted(() => ({
  processor: undefined as Processor | undefined,
  passthroughSchema: { parse: (value: unknown) => value },
  ingestDocument: vi.fn(),
  ingestFile: vi.fn(),
  runDedupSweep: vi.fn(),
}));
vi.mock("bullmq", () => ({
  Queue: class {},
  FlowProducer: class {},
  Worker: class {
    constructor(_name: string, processor: Processor) {
      mocks.processor = processor;
    }
  },
}));
vi.mock("ioredis", () => ({
  default: class {
    on(): void {}
  },
}));
vi.mock("~/utils/db", () => ({ useDatabase: async () => ({}) }));
vi.mock("~/lib/jobs/ingest-document", () => ({
  IngestDocumentJobInputSchema: mocks.passthroughSchema,
  ingestDocument: mocks.ingestDocument,
}));
vi.mock("~/lib/jobs/ingest-file", () => ({
  IngestFileJobInputSchema: mocks.passthroughSchema,
  ingestFile: mocks.ingestFile,
}));
vi.mock("~/lib/jobs/ingest-conversation", () => ({
  MessageSchema: z.unknown(),
  IngestConversationJobInputSchema: mocks.passthroughSchema,
  ingestConversation: vi.fn(),
}));
vi.mock("~/lib/jobs/ingest-transcript", () => ({
  IngestTranscriptJobInputSchema: mocks.passthroughSchema,
  ingestTranscript: vi.fn(),
}));
vi.mock("~/lib/jobs/dedup-sweep", () => ({
  runDedupSweep: mocks.runDedupSweep,
}));

describe("source job post-processing", () => {
  const priorSignals = new Map(
    (["SIGTERM", "SIGINT"] as const).map((signal) => [
      signal,
      process.listeners(signal),
    ]),
  );
  beforeAll(async () => {
    await import("./queues");
  });
  afterEach(() => vi.clearAllMocks());
  afterAll(() => {
    for (const [signal, prior] of priorSignals) {
      for (const listener of process.listeners(signal)) {
        if (!prior.includes(listener)) process.removeListener(signal, listener);
      }
    }
    for (const moduleId of [
      "bullmq",
      "ioredis",
      "~/utils/db",
      "~/lib/jobs/ingest-document",
      "~/lib/jobs/ingest-file",
      "~/lib/jobs/ingest-conversation",
      "~/lib/jobs/ingest-transcript",
      "~/lib/jobs/dedup-sweep",
    ]) {
      vi.doUnmock(moduleId);
    }
    vi.resetModules();
  });

  it.each(["ingest-document", "ingest-file"] as const)(
    "%s sweeps the partition returned by ingestion, including the unpartitioned destination",
    async (name) => {
      if (!mocks.processor)
        throw new Error("Worker processor was not registered");
      const originalPartition = contextPartitionKeySchema.parse("memory:old");
      const currentPartition =
        contextPartitionKeySchema.parse("memory:current");
      const job = {
        id: "operation",
        name,
        attemptsMade: 0,
        opts: { attempts: 3 },
        data: {
          userId: "owner",
          partitionKey: originalPartition,
          sourceId: newTypeId("source"),
          expectedSourceVersion: 1,
          operationId: "operation",
          timestamp: "2026-09-10T10:00:00.000Z",
          documentId: "document",
          filename: "file.txt",
          mimeType: "text/plain",
        },
      } as Job;
      const ingest =
        name === "ingest-document" ? mocks.ingestDocument : mocks.ingestFile;
      for (const partitionKey of [currentPartition, undefined]) {
        ingest.mockResolvedValueOnce({ partitionKey });
        await mocks.processor(job);
        expect(mocks.runDedupSweep).toHaveBeenLastCalledWith(
          "owner",
          undefined,
          partitionKey,
        );
      }
      expect(mocks.runDedupSweep).toHaveBeenCalledTimes(2);
      ingest.mockResolvedValueOnce(undefined);
      await mocks.processor(job);
      expect(mocks.runDedupSweep).toHaveBeenCalledTimes(2);
    },
  );
});
