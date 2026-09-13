import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "~/utils/env";

const SOURCE_PROCESSING_QUEUE_NAME = "batchProcessing";
const DEFAULT_INSPECTION_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 250;

interface SourceProcessingQueueInspectionOptions {
  /** Internal test seam; production uses the configured batch queue. */
  redisUrl?: string;
  queueName?: string;
  timeoutMs?: number;
}

export interface InspectedSourceProcessingJob {
  readonly id?: string | number;
  readonly name: string;
  readonly data: unknown;
}

export interface SourceProcessingQueueInspection {
  readonly job: InspectedSourceProcessingJob;
  readonly state: string;
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Source processing queue inspection timed out after ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function closeWithinDeadline(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    operation
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

/**
 * Reads one retained processing job without borrowing the worker connection.
 *
 * Status polling must fail in a bounded time when Redis is unavailable. The
 * worker connection intentionally retries forever, so this read uses its own
 * finite connection and disconnects it even when the command times out.
 */
export async function inspectSourceProcessingJob(
  operationId: string,
  options: SourceProcessingQueueInspectionOptions = {},
): Promise<SourceProcessingQueueInspection | undefined> {
  const timeoutMs = Math.max(
    1,
    options.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS,
  );
  const connection = new IORedis(options.redisUrl ?? env.REDIS_URL, {
    connectTimeout: Math.min(timeoutMs, 1_000),
    disconnectTimeout: CLEANUP_TIMEOUT_MS,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => 100,
  });
  let queue: Queue | undefined;
  try {
    queue = new Queue(options.queueName ?? SOURCE_PROCESSING_QUEUE_NAME, {
      connection,
      skipMetasUpdate: true,
    });
    // Queue initialization continues after the deadline races a Redis call.
    // Consume that eventual rejection while close() disconnects the client.
    void queue.client.catch(() => undefined);
    return await withDeadline(
      (async (): Promise<SourceProcessingQueueInspection | undefined> => {
        const job = await queue.getJob(operationId);
        if (!job) return undefined;
        return {
          job: {
            id: job.id,
            name: job.name,
            data: job.data,
          },
          state: await job.getState(),
        };
      })(),
      timeoutMs,
    );
  } finally {
    if (queue !== undefined) {
      await closeWithinDeadline(queue.close(), CLEANUP_TIMEOUT_MS);
    }
    connection.disconnect();
  }
}
