import { describe, expect, it } from "vitest";
import { createClaimRequestSchema } from "~/lib/schemas/claim";
import { createCommitmentRequestSchema } from "~/lib/schemas/create-commitment";
import { getCommitmentRequestSchema } from "~/lib/schemas/get-commitment";
import { ingestDocumentRequestSchema } from "~/lib/schemas/ingest-document-request";
import { getNodeRequestSchema } from "~/lib/schemas/node";
import { queryDayRequestSchema } from "~/lib/schemas/query-day";

describe("MCP partition contracts", () => {
  it.each([
    ["save_memory", ingestDocumentRequestSchema.shape.partitionKey],
    ["query_day", queryDayRequestSchema.shape.partitionKey],
    ["get_node", getNodeRequestSchema.shape.partitionKey],
    ["create_claim", createClaimRequestSchema.shape.partitionKey],
    ["create_commitment", createCommitmentRequestSchema.shape.partitionKey],
    ["get_commitment", getCommitmentRequestSchema.shape.partitionKey],
  ])("%s accepts and preserves the opaque room key", (_name, schema) => {
    expect(schema.parse("opaque:client-a")).toBe("opaque:client-a");
  });
});
