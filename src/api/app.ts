import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { AppConfig } from '../config/index.js';
import { createDatabase, type Database } from '../lib/db/index.js';
import { createStorage, type ObjectStorage } from '../lib/storage/index.js';
import { healthRoutes } from './routes/health.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    db: Database;
    storage: ObjectStorage;
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
}

function loggerFromConfig(config: AppConfig): LoggerOption {
  if (config.NODE_ENV === 'test') return false;
  if (config.NODE_ENV === 'development') {
    return {
      level: config.LOG_LEVEL,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    };
  }
  return { level: config.LOG_LEVEL };
}

/**
 * Build a fully-wired Fastify instance without binding a port (so tests can use `app.inject`).
 * Opens storage and the database, applies migrations, and closes what it opened on `app.close()`.
 */
export async function buildApp(
  config: AppConfig,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? loggerFromConfig(config),
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

  app.decorate('db', db);
  app.decorate('storage', storage);
  if (ownsDb) app.addHook('onClose', () => db.close());

  app.log.info({ db: db.backend, storage: storage.backend }, 'storage and database ready');

  await app.register(healthRoutes);

  return app;
}
