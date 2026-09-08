import { defineEventHandler } from "h3";
import { saveMemory } from "~/lib/ingestion/save-document";
import {
  ingestDocumentRequestSchema,
  ingestDocumentResponseSchema,
} from "~/lib/schemas/ingest-document-request";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, document, updateExisting } =
    ingestDocumentRequestSchema.parse(await readBody(event));
  return ingestDocumentResponseSchema.parse(
    await saveMemory({ userId, partitionKey, document, updateExisting }),
  );
});
