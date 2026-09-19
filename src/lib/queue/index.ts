import { Queue, Worker, type Job, type JobState, type Processor } from 'bullmq';
import { Redis } from 'ioredis';

export { UnrecoverableError } from 'bullmq';

/** One queue for now; live-stream work (phase 2) may add another. */
export const TRANSCODE_QUEUE_NAME = 'transcode';
/** Redis key prefix. Tests override it per run so parallel suites never share state. */
export const DEFAULT_QUEUE_PREFIX = 'chitrayaan';

const ENQUEUE_TIMEOUT_MS = 5_000;
const LOOKUP_TIMEOUT_MS = 3_000;
const PING_TIMEOUT_MS = 2_000;
const CLOSE_TIMEOUT_MS = 3_000;

/** Payload stored in Redis. Everything else lives in the database, keyed by `jobId`. */
export interface TranscodeJobData {
  jobId: string;
  videoId: string;
}

export type TranscodeJob = Job<TranscodeJobData, void, typeof TRANSCODE_QUEUE_NAME>;
export type TranscodeProcessorFn = Processor<TranscodeJobData, void, typeof TRANSCODE_QUEUE_NAME>;

export interface QueueJobState {
  state: JobState | 'unknown';
  attemptsMade: number;
  failedReason: string | null;
  progress: number | null;
}

/**
 * BullMQ stores a failed job's message itself, but which code path wrote it decides what comes
 * back: a plain string, a JSON-encoded one, or a structured object. The API hands this to
 * clients, so flatten it to a readable string here.
 */
export function normalizeFailedReason(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('"') || trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        // Only take the decoded form when it is actually simpler than what we started with.
        if (typeof parsed === 'string' || (parsed !== null && typeof parsed === 'object')) {
          return normalizeFailedReason(parsed);
        }
      } catch {
        // Not JSON after all; the message just happens to start with a quote or a brace.
      }
    }
    return value;
  }
  if (typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * BullMQ needs `maxRetriesPerRequest: null`. Reconnection is unbounded with a capped backoff so a
 * Redis restart is survived; `onError` receives connection errors (ioredis requires a listener).
 */
export function createRedisClient(
  url: string,
  onError: (err: Error) => void,
  { enableOfflineQueue = true }: { enableOfflineQueue?: boolean } = {},
): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableOfflineQueue,
    retryStrategy: (times) => Math.min(times * 250, 5_000),
  });
  client.on('error', onError);
  return client;
}

async function closeRedis(client: Redis): Promise<void> {
  try {
    await withTimeout(client.quit(), CLOSE_TIMEOUT_MS, 'redis quit');
  } catch {
    // Not connected or Redis is gone: fall through and drop the socket.
  } finally {
    client.disconnect();
  }
}

export interface TranscodeQueueOptions {
  prefix?: string;
  onError?: (err: Error) => void;
  /** Total tries per job, including the first. Defaults to 3. */
  attempts?: number;
  /** Delay before the second try, doubling for each try after that. Defaults to 5s. */
  backoffMs?: number;
}

/**
 * Producer-side handle on the transcode queue, used by the API to enqueue jobs and to read live
 * queue state. Every call is bounded by a timeout: when Redis is down the API must degrade
 * (upload still succeeds, job stays `queued` in the DB for reconciliation) rather than hang.
 */
export class TranscodeQueue {
  readonly prefix: string;
  readonly queue: Queue<TranscodeJobData, void, typeof TRANSCODE_QUEUE_NAME>;
  private readonly redis: Redis;
  private readonly attempts: number;
  private readonly backoffMs: number;

  constructor(redisUrl: string, options: TranscodeQueueOptions = {}) {
    this.prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
    this.attempts = options.attempts ?? 3;
    this.backoffMs = options.backoffMs ?? 5_000;
    // Fail fast instead of buffering commands while disconnected.
    this.redis = createRedisClient(redisUrl, options.onError ?? (() => undefined), {
      enableOfflineQueue: false,
    });
    this.queue = new Queue(TRANSCODE_QUEUE_NAME, { connection: this.redis, prefix: this.prefix });
  }

  /**
   * Enqueue a database job. The BullMQ job id is the database job id, so enqueueing the same job
   * twice is a no-op rather than a duplicate. Resolves to the queue job id.
   *
   * Retries use exponential backoff. A processor that throws `UnrecoverableError` (bad input,
   * a timeout) skips them and fails immediately.
   */
  async enqueue(job: { id: string; videoId: string }): Promise<string> {
    const added = await withTimeout(
      this.queue.add(
        TRANSCODE_QUEUE_NAME,
        { jobId: job.id, videoId: job.videoId },
        {
          jobId: job.id,
          attempts: this.attempts,
          backoff: { type: 'exponential', delay: this.backoffMs },
          removeOnComplete: { count: 1_000 },
          removeOnFail: { count: 5_000 },
        },
      ),
      ENQUEUE_TIMEOUT_MS,
      'enqueue',
    );
    return added.id ?? job.id;
  }

  /** Live BullMQ view of a job, or null if the queue no longer knows it. */
  async getState(jobId: string): Promise<QueueJobState | null> {
    const job = await withTimeout(this.queue.getJob(jobId), LOOKUP_TIMEOUT_MS, 'queue lookup');
    if (!job) return null;
    const state = await withTimeout(job.getState(), LOOKUP_TIMEOUT_MS, 'queue state');
    return {
      state,
      attemptsMade: job.attemptsMade,
      failedReason: normalizeFailedReason(job.failedReason),
      progress: typeof job.progress === 'number' ? job.progress : null,
    };
  }

  /** Resolves once Redis answers; rejects (within the timeout) if it is unreachable. */
  async ping(): Promise<void> {
    // A ping issued right after startup must wait for the socket rather than fail on the
    // offline-queue rule, so first wait (bounded) for the client to report ready.
    await this.whenReady(PING_TIMEOUT_MS);
    await withTimeout(this.redis.ping(), PING_TIMEOUT_MS, 'redis ping');
  }

  private async whenReady(ms: number): Promise<void> {
    if (this.redis.status === 'ready') return;
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.redis.off('ready', onReady);
          this.redis.off('end', onEnd);
        };
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onEnd = () => {
          cleanup();
          reject(new Error('redis connection closed'));
        };
        this.redis.once('ready', onReady);
        this.redis.once('end', onEnd);
      }),
      ms,
      'redis connect',
    );
  }

  /** Test-only: wipe every key under this prefix. */
  async obliterate(): Promise<void> {
    await this.queue.obliterate({ force: true });
  }

  async close(): Promise<void> {
    try {
      await withTimeout(this.queue.close(), CLOSE_TIMEOUT_MS, 'queue close');
    } catch {
      // Redis unreachable: closing the socket below is all that is left to do.
    }
    await closeRedis(this.redis);
  }
}

export interface TranscodeWorkerOptions {
  redisUrl: string;
  processor: TranscodeProcessorFn;
  prefix?: string;
  concurrency?: number;
  onError?: (err: Error) => void;
}

export interface TranscodeWorkerHandle {
  worker: Worker<TranscodeJobData, void, typeof TRANSCODE_QUEUE_NAME>;
  /** Waits for in-flight jobs, then disconnects. */
  close: () => Promise<void>;
}

/** Consumer side: a BullMQ worker on its own connection (BullMQ duplicates it for blocking reads). */
export function createTranscodeWorker(options: TranscodeWorkerOptions): TranscodeWorkerHandle {
  const onError = options.onError ?? (() => undefined);
  const redis = createRedisClient(options.redisUrl, onError);
  const worker = new Worker(TRANSCODE_QUEUE_NAME, options.processor, {
    connection: redis,
    prefix: options.prefix ?? DEFAULT_QUEUE_PREFIX,
    concurrency: options.concurrency ?? 1,
  });
  worker.on('error', onError);
  return {
    worker,
    close: async () => {
      await worker.close();
      await closeRedis(redis);
    },
  };
}
