import { parseISO } from "date-fns";
import { IngestConversationJobInput } from "~/lib/jobs/ingest-conversation";
import { batchQueue } from "~/lib/queues";
import {
  ingestConversationRequestSchema,
  ingestConversationResponseSchema,
} from "~/lib/schemas/ingest-conversation";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, conversation } =
    ingestConversationRequestSchema.parse(await readBody(event));

  const jobInput: IngestConversationJobInput = {
    userId,
    partitionKey,
    conversationId: conversation.id,
    messages: conversation.messages.map((m) => ({
      id: m.id,
      content: m.content,
      role: m.role,
      name: m.name,
      timestamp: parseISO(m.timestamp),
    })),
  };

  await batchQueue.add("ingest-conversation", jobInput);

  return ingestConversationResponseSchema.parse({
    message: "Conversation ingestion job accepted",
    jobId: conversation.id,
  });
});
