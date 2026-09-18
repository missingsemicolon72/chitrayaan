import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { AppConfig } from '../config/index.js';
import { createDatabase, type Database } from '../lib/db/index.js';
import { pinoOptionsFor } from '../lib/logger.js';
import { TranscodeQueue } from '../lib/queue/index.js';
import { reconcileQueuedJobs } from '../lib/queue/reconcile.js';
import { createStorage, type ObjectStorage } from '../lib/storage/index.js';
import { registerApiKeyAuth } from './plugins/auth.js';
import { healthRoutes } from './routes/health.js';
import { jobRoutes } from './routes/jobs.js';
import { uploadRoutes } from './routes/uploads.js';
import { videoRoutes } from './routes/videos.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    db: Database;
    storage: ObjectStorage;
    queue: TranscodeQueue;
  }
}

type LoggerOption = NonNullable<FastifyServerOptions['logger']>;

export interface BuildAppOptions {
  /** Override Fastify's logger option (tests pass `false`). Defaults to a config-derived logger. */
  logger?: LoggerOption;
  /** Inject a database instead of building one from config. The caller then owns closing it. */
  db?: Database;
  /** Inject a storage driver instead of building one from config. */
  storage?: ObjectStorage;
  /** Inject a queue handle (tests use a per-run key prefix). The caller then owns closing it. */
  queue?: TranscodeQueue;
}

/**
 * Build a fully-wired Fastify instance without binding a port (so tests can use `app.inject`).
 * Opens storage, the database (applying migrations) and the queue, and closes what it opened on
 * `app.close()`. Redis being down is not fatal here: uploads still work and jobs wait in the
 * database until `reconcileQueuedJobs` can hand them over.
 */
export async function buildApp(
  config: AppConfig,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? (config.NODE_ENV === 'test' ? false : pinoOptionsFor(config)),
    trustProxy: false,
  });

  app.decorate('config', config);

  const ownsDb = options.db === undefined;
  const db = options.db ?? (await createDatabase(config));
  try {
    await db.migrate();
  } catch (err) {
    if (ownsDb) await db.close();
    throw err;
  }
  const storage = options.storage ?? (await createStorage(config));

  let lastRedisErrorAt = 0;
  const queue =
    options.queue ??
    new TranscodeQueue(config.REDIS_URL, {
      onError: (err) => {
        // ioredis emits one error per reconnect attempt; keep the log readable.
        const now = Date.now();
        if (now - lastRedisErrorAt > 30_000) {
          lastRedisErrorAt = now;
          app.log.warn({ err: err.message }, 'redis connection error (will keep retrying)');
        }
      },
    });

  app.decorate('db', db);
  app.decorate('storage', storage);
  app.decorate('queue', queue);
  if (ownsDb) app.addHook('onClose', () => db.close());
  if (options.queue === undefined) app.addHook('onClose', () => queue.close());

  app.log.info({ db: db.backend, storage: storage.backend }, 'storage and database ready');

  // Auth is registered before any routes so it applies to every plugin below.
  registerApiKeyAuth(app, config.API_KEY);

  await app.register(healthRoutes);
  await app.register(videoRoutes);
  await app.register(jobRoutes);
  await app.register(uploadRoutes);

  const reconciled = await reconcileQueuedJobs(db, queue, app.log);
  if (reconciled > 0) app.log.info({ count: reconciled }, 'reconciled pending jobs into queue');

  return app;
}
