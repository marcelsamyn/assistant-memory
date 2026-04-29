import { assistantDreamJob } from "./jobs/atlas-assistant";
import { processAtlasJob } from "./jobs/atlas-user";
import { z } from "zod";
import { CleanupGraphJobInputSchema } from "./jobs/cleanup-graph";
import { dream } from "./jobs/dream";
import { IdentityReevalJobInputSchema } from "./jobs/identity-reeval";
import { IngestConversationJobInputSchema } from "./jobs/ingest-conversation";
import { IngestDocumentJobInputSchema } from "./jobs/ingest-document";
import { ProfileSynthesisJobInputSchema } from "./jobs/profile-synthesis";
import { summarizeUserConversations } from "./jobs/summarize-conversation";
import { DeepResearchJobInputSchema } from "./schemas/deep-research";
import { FlowProducer, Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";
import { env } from "~/utils/env";

// Define connection options using environment variables
export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // Important for BullMQ
});

redisConnection.on("error", (err) => {
  console.error("Redis connection error:", err);
});

// Create the main batch processing queue
export const batchQueue = new Queue("batchProcessing", {
  connection: redisConnection,
});

export const flowProducer = new FlowProducer({ connection: redisConnection });

// Define Job Data Schemas (using Zod could be an option here too)
interface SummarizeJobData {
  userId: string;
}

export const AtlasUserJobInputSchema = z.object({
  userId: z.string().min(1),
  // Trigger tag is informational only — used for log/metrics correlation.
  trigger: z.enum(["scheduled", "supersede"]).default("scheduled"),
});

export interface DreamJobData {
  userId: string;
  assistantId: string;
  assistantDescription: string;
}

// Create the worker
// Keep the worker in scope even if not explicitly referenced later.
const worker = new Worker<SummarizeJobData | DreamJobData>(
  "batchProcessing",
  async (job) => {
    const db = await useDatabase();
    console.log(`Processing job ${job.id} of type ${job.name}`);

    try {
      if (job.name === "summarize") {
        const { userId } = job.data as SummarizeJobData;
        console.log(`Starting summarize job for user ${userId}`);

        // 1. Summarize conversations
        const summaryResult = await summarizeUserConversations(db, userId);
        console.log(
          `Summarized ${summaryResult.summarizedCount} conversations for user ${userId}.`,
        );
      } else if (job.name === "dream") {
        const { userId, assistantId, assistantDescription } =
          job.data as DreamJobData;
        console.log(
          `Starting dream job for user ${userId}, assistant ${assistantId}`,
        );
        // 1. Summarize conversations
        const summaryResult = await summarizeUserConversations(db, userId);
        console.log(
          `Summarized ${summaryResult.summarizedCount} conversations for user ${userId} in dream job.`,
        );
        // 2. Run both Atlas updates in parallel
        await Promise.all([
          processAtlasJob(db, userId),
          assistantDreamJob(db, userId, assistantId, assistantDescription),
        ]);

        await dream({
          userId,
          assistantDescription,
        });

        console.log(
          `\n\nAssistant dream completed for user ${userId}, assistant ${assistantId}.`,
        );
      } else if (job.name === "atlas-user") {
        // Standalone atlas refresh — used by the supersession invalidation
        // hook (Phase 3.4) and any caller that wants to schedule a refresh
        // outside the dream cadence. The full dream job runs the atlas
        // synchronously already.
        const { userId } = AtlasUserJobInputSchema.parse(job.data);
        const result = await processAtlasJob(db, userId);
        console.log(
          `Atlas user job for ${userId}: ${result.status}`,
        );
      } else if (job.name === "ingest-conversation") {
        const { userId, conversationId, messages } =
          IngestConversationJobInputSchema.parse(job.data);
        console.log(
          `Starting ingest-conversation job for user ${userId}, conversation ${conversationId}`,
        );

        const { ingestConversation } = await import(
          "./jobs/ingest-conversation"
        );
        await ingestConversation({
          db,
          userId,
          conversationId,
          messages,
        });
        console.log(
          `Ingested conversation ${conversationId} for user ${userId}.`,
        );

        // Run dedup sweep after ingestion to clean up any duplicates
        const { runDedupSweep } = await import("./jobs/dedup-sweep");
        await runDedupSweep(userId);

        // Queue deep research job if there are messages
        if (messages.length > 0) {
          // Simple throttling: add a low probability to reduce job frequency
          // This helps prevent too many jobs for users with many short conversations
          if (Math.random() < (env.DEEP_RESEARCH_PROBABILITY || 0.5)) {
            // Create a deterministic job ID to prevent duplicate jobs
            const jobId = `deep-research:${userId}:${conversationId}`;

            // Check if job already exists before adding
            const existingJob = await batchQueue.getJob(jobId);
            if (!existingJob) {
              await batchQueue.add(
                "deep-research",
                {
                  userId,
                  conversationId,
                  messages,
                  lastNMessages: 3,
                },
                {
                  jobId,
                  removeOnComplete: true,
                  removeOnFail: 50,
                },
              );
              console.log(
                `Queued deep research job for conversation ${conversationId}`,
              );
            } else {
              console.log(
                `Skipping duplicate deep research job for conversation ${conversationId}`,
              );
            }
          }
        }
      } else if (job.name === "deep-research") {
        const { userId, conversationId, messages, lastNMessages } =
          DeepResearchJobInputSchema.parse(job.data);
        console.log(
          `Starting deep-research job for user ${userId}, conversation ${conversationId}`,
        );

        const { performDeepResearch } = await import("./jobs/deep-research");
        await performDeepResearch({
          userId,
          conversationId,
          messages,
          lastNMessages,
        });
        console.log(
          `Completed deep research for conversation ${conversationId} for user ${userId}.`,
        );
      } else if (job.name === "ingest-document") {
        const {
          userId,
          documentId,
          content,
          scope,
          timestamp,
          updateExisting,
        } = IngestDocumentJobInputSchema.parse(job.data);
        console.log(
          `Starting ingest-document job for user ${userId}, document ${documentId}`,
        );

        const { ingestDocument } = await import("./jobs/ingest-document");
        await ingestDocument({
          db,
          userId,
          documentId,
          content,
          scope,
          timestamp,
          updateExisting,
        });
        console.log(`Ingested document ${documentId} for user ${userId}.`);

        // Run dedup sweep after ingestion
        const { runDedupSweep: runDocDedupSweep } = await import(
          "./jobs/dedup-sweep"
        );
        await runDocDedupSweep(userId);
      } else if (job.name === "profile-synthesis") {
        const { userId, nodeId } = ProfileSynthesisJobInputSchema.parse(
          job.data,
        );
        const { runProfileSynthesis } = await import(
          "./jobs/profile-synthesis"
        );
        const result = await runProfileSynthesis({
          userId,
          nodeId: nodeId as TypeId<"node">,
        });
        console.log(
          `Profile synthesis for user ${userId} node ${nodeId}: ${result.status}`,
        );
      } else if (job.name === "identity-reeval") {
        const { userId, nodeId } = IdentityReevalJobInputSchema.parse(job.data);
        const { runIdentityReeval } = await import("./jobs/identity-reeval");
        const result = await runIdentityReeval({
          userId,
          nodeId: nodeId as TypeId<"node">,
        });
        console.log(
          `Identity reeval for user ${userId} node ${nodeId}: ${result.status}`,
        );
      } else if (job.name === "cleanup-graph") {
        const data = CleanupGraphJobInputSchema.parse({
          ...job.data,
          llmModelId: env.MODEL_ID_GRAPH_EXTRACTION,
        });
        console.log(
          `Starting cleanup-graph job for user ${data.userId}, since ${data.since.toISOString()}`,
        );

        // First, run basic cleanup operations
        const { truncateLongLabels, generateMissingNodeEmbeddings } =
          await import("./jobs/cleanup-graph");

        console.log("Running basic cleanup operations...");
        const [truncateResult, embeddingsResult] = await Promise.all([
          truncateLongLabels(data.userId),
          generateMissingNodeEmbeddings(data.userId),
        ]);

        console.log(
          `Basic cleanup completed: truncated ${truncateResult.updatedCount} labels, generated ${embeddingsResult.generatedCount} embeddings`,
        );

        // Run deterministic dedup sweep before LLM-based cleanup
        const { runDedupSweep: runCleanupDedupSweep } = await import(
          "./jobs/dedup-sweep"
        );
        await runCleanupDedupSweep(data.userId);

        // Then run the iterative graph cleanup
        const { runIterativeCleanup } = await import(
          "./jobs/run-iterative-cleanup"
        );
        await runIterativeCleanup({
          ...data,
          iterations: 5, // default to 5 iterations per run
          seedsPerIteration: data.entryNodeLimit,
        });
        console.log(`Cleanup-graph completed for user ${data.userId}.`);
      } else {
        console.warn(`Unknown job type: ${job.name}`);
        throw new Error(`Unknown job type: ${job.name}`);
      }
    } catch (error) {
      console.error(`Job ${job.id} (${job.name}) failed:`, error);
      // Optionally, rethrow the error to have BullMQ mark the job as failed
      throw error;
    }
  },
  { connection: redisConnection },
);

console.log("BullMQ Worker started for batchProcessing queue.");

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down BullMQ worker...");
  await worker.close();
  await redisConnection.quit();
  console.log("BullMQ shutdown complete.");
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, shutting down BullMQ worker...");
  await worker.close();
  await redisConnection.quit();
  console.log("BullMQ shutdown complete.");
  process.exit(0);
});
