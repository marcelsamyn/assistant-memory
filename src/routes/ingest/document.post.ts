import { defineEventHandler } from "h3";
import { saveMemory } from "~/lib/ingestion/save-document";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  ingestDocumentRequestSchema,
  ingestDocumentResponseSchema,
} from "~/lib/schemas/ingest-document-request";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, document, updateExisting } = parseRequestBody(
    ingestDocumentRequestSchema,
    await readBody(event),
  );
  const accessScope = getRequestAccessScope(event);
  try {
    return ingestDocumentResponseSchema.parse(
      await saveMemory({
        userId,
        partitionKey,
        document,
        updateExisting,
        accessScope,
      }),
    );
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
