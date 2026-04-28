import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),

  MEMORY_OPENAI_API_KEY: z.string().min(1),
  MEMORY_OPENAI_API_BASE_URL: z.string().min(1),

  MODEL_ID_GRAPH_EXTRACTION: z.string().min(1),

  JINA_API_KEY: z.string().min(1),

  HELICONE_API_KEY: z.string().min(1).optional(),

  REDIS_URL: z
    .string()
    .url()
    .min(1)
    .describe("URL for Redis connection (e.g., redis://localhost:6379)"),

  RUN_MIGRATIONS: z.string().default("false"),
  MINIO_ENDPOINT: z.string().min(1),
  MINIO_PORT: z.coerce.number().optional(),
  MINIO_USE_SSL: z.coerce.boolean().default(false),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  SOURCES_BUCKET: z.string().min(1),
  DEBUG_LOGS: z.coerce
    .boolean()
    .default(false)
    .describe("Enable debug logging"),

  DREAM_PROBABILITY: z.coerce.number().default(0.1),
  DREAM_SELECTION_PROBABILITY: z.coerce.number().default(0.4),
  DEEP_RESEARCH_PROBABILITY: z.coerce.number().default(0.5),

  // Identity resolution (signal 3 + 4) thresholds. Defaults are intentionally
  // conservative — false-positive merges are far worse than missed merges
  // because the cleanup pipeline can still propose a merge later, but a wrong
  // auto-merge silently corrupts the graph.
  IDENTITY_EMBEDDING_THRESHOLD: z.coerce.number().default(0.78),
  IDENTITY_PROFILE_COMPAT_THRESHOLD: z.coerce.number().default(0.6),
});

export const env = envSchema.parse(process.env);
