import { registerMemoryIngestionTools } from "./ingestion-tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { newTypeId } from "~/types/typeid";

const domain = vi.hoisted(() => ({
  save: vi.fn(),
  read: vi.fn(),
  retry: vi.fn(),
  source: vi.fn(),
}));
vi.mock("~/lib/ingestion/save-document", () => ({ saveMemory: domain.save }));
vi.mock("~/lib/ingestion/source-processing", () => ({
  getSourceIngestionOperationById: domain.read,
}));
vi.mock("~/lib/ingestion/retry-source-processing", () => ({
  retrySourceProcessing: domain.retry,
}));
vi.mock("~/lib/get-source", () => ({ getSource: domain.source }));
vi.mock("~/utils/db", () => ({ useDatabase: async () => ({}) }));

const textResult = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});
function readResult(value: unknown): unknown {
  const text = textResult.parse(value).content[0]?.text;
  if (!text) throw new Error("Missing tool result");
  return JSON.parse(text);
}

describe("MCP source ingestion", () => {
  let server: McpServer;
  let client: Client;
  beforeEach(async () => {
    vi.resetAllMocks();
    server = new McpServer({ name: "memory-test", version: "1" });
    client = new Client({ name: "generic-client", version: "1" });
    registerMemoryIngestionTools(server);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("forwards a contextual revision and returns its acceptance receipt", async () => {
    const sourceContext = {
      version: 1,
      sourceKind: "document",
      purpose: "Remember project notes",
      accountId: "notes-vault",
      relationship: "owner",
      currentMessageRole: "primary",
      completeness: "complete",
    };
    const accepted = {
      message: "Accepted",
      sourceId: newTypeId("source"),
      jobId: "operation-1",
      ingestionOperationId: "operation-1",
    };
    domain.save.mockResolvedValue(accepted);
    const result = await client.callTool({
      name: "save_memory",
      arguments: {
        userId: "user-1",
        partitionKey: "project:one",
        updateExisting: true,
        document: {
          id: "note-1",
          content: "The agreed paint colour is green.",
          timestamp: "2026-09-11T08:00:00.000Z",
          sourceContext,
        },
      },
    });
    expect(domain.save).toHaveBeenCalledWith({
      userId: "user-1",
      partitionKey: "project:one",
      updateExisting: true,
      document: {
        id: "note-1",
        content: "The agreed paint colour is green.",
        contentType: "markdown",
        scope: "personal",
        timestamp: new Date("2026-09-11T08:00:00.000Z"),
        sourceContext,
      },
    });
    expect(readResult(result)).toEqual(accepted);
  });

  it("keeps plain note inputs and default non-replacement behavior", async () => {
    domain.save.mockResolvedValue({
      sourceId: newTypeId("source"),
      message: "Accepted",
      jobId: "legacy-job",
    });
    await client.callTool({
      name: "save_memory",
      arguments: {
        userId: "user-1",
        document: { id: "note-1", content: "A plain note" },
      },
    });
    expect(domain.save).toHaveBeenCalledWith({
      userId: "user-1",
      updateExisting: false,
      document: {
        id: "note-1",
        content: "A plain note",
        contentType: "markdown",
        scope: "personal",
      },
    });
  });

  it("uses the same user and partition for receipt reads and retries", async () => {
    const input = {
      userId: "user-1",
      partitionKey: "project:one",
      operationId: "operation-1",
    };
    domain.read.mockResolvedValue(null);
    expect(
      readResult(
        await client.callTool({
          name: "get_source_processing",
          arguments: input,
        }),
      ),
    ).toEqual({ processing: null });
    expect(domain.read).toHaveBeenCalledWith({ ...input, db: {} });
    domain.retry.mockRejectedValue(new Error("Source is purged"));
    const failed = await client.callTool({
      name: "retry_source_processing",
      arguments: input,
    });
    expect(domain.retry).toHaveBeenCalledWith(input);
    expect(failed.isError).toBe(true);
  });

  it("lets any MCP client read source text beyond extracted claims", async () => {
    const input = {
      userId: "user-1",
      partitionKey: "project:one",
      sourceId: newTypeId("source"),
      includeContent: true,
    };
    const result = {
      source: {
        sourceId: input.sourceId,
        content: { text: "The full retained note", format: "text" },
      },
    };
    domain.source.mockResolvedValue(result);
    expect(
      readResult(
        await client.callTool({ name: "get_source", arguments: input }),
      ),
    ).toEqual(result);
    expect(domain.source).toHaveBeenCalledWith(input);
  });
});
