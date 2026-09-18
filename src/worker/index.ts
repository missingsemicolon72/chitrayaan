import { bootstrapConfig } from '../config/index.js';
import { createDatabase } from '../lib/db/index.js';
import { createLogger } from '../lib/logger.js';
import { createTranscodeWorker, TRANSCODE_QUEUE_NAME } from '../lib/queue/index.js';
import { createStorage } from '../lib/storage/index.js';
import { placeholderProcessor } from './processors/placeholder.js';
import { createJobRunner } from './runner.js';

/**
 * Worker process entrypoint. Runs alongside the API (`npm run dev:worker` / `start:worker`),
 * shares its database and storage, and consumes the transcode queue from Redis.
 */
const config = bootstrapConfig();
const log = createLogger(config, 'worker');

const db = await createDatabase(config);
await db.migrate();
const storage = await createStorage(config);

let lastRedisErrorAt = 0;
const handle = createTranscodeWorker({
  redisUrl: config.REDIS_URL,
  concurrency: config.WORKER_CONCURRENCY,
  processor: createJobRunner({ db, storage, processor: placeholderProcessor, log }),
  onError: (err) => {
    // ioredis emits one error per reconnect attempt; keep the log readable.
    const now = Date.now();
    if (now - lastRedisErrorAt > 30_000) {
      lastRedisErrorAt = now;
      log.error({ err: err.message }, 'redis connection error (will keep retrying)');
    }
  },
});

handle.worker.on('ready', () => log.info('connected to redis, waiting for jobs'));
handle.worker.on('stalled', (jobId) => log.warn({ queueJobId: jobId }, 'job stalled'));

log.info(
  {
    queue: TRANSCODE_QUEUE_NAME,
    concurrency: config.WORKER_CONCURRENCY,
    db: db.backend,
    storage: storage.backend,
  },
  'worker started',
);

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down, waiting for in-flight jobs');
  handle
    .close()
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      log.error(err, 'error during shutdown');
      process.exit(1);
    });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
