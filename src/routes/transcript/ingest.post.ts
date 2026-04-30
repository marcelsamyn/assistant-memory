import { batchQueue } from "~/lib/queues";
import {
  ingestTranscriptRequestSchema,
  ingestTranscriptResponseSchema,
} from "~/lib/schemas/ingest-transcript";

export default defineEventHandler(async (event) => {
  const body = ingestTranscriptRequestSchema.parse(await readBody(event));

  // The job-input schema accepts the same wire shape; revalidating here would
  // be redundant. We forward the parsed body verbatim so the worker can
  // re-parse and apply its own coercions (Date conversion in particular).
  await batchQueue.add("ingest-transcript", body);

  return ingestTranscriptResponseSchema.parse({
    message: "Transcript ingestion job accepted",
    jobId: body.transcriptId,
  });
});
