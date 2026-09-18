import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { AppConfig } from '../config/index.js';
import { healthRoutes } from './routes/health.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
  }
}

type LoggerOption = NonNullable<FastifyServerOptions['logger']>;

export interface BuildAppOptions {
  /** Override Fastify's logger option (tests pass `false`). Defaults to a config-derived logger. */
  logger?: LoggerOption;
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

/** Build a fully-wired Fastify instance without binding a port (so tests can use `app.inject`). */
export async function buildApp(
  config: AppConfig,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? loggerFromConfig(config),
    trustProxy: false,
  });

  app.decorate('config', config);

  await app.register(healthRoutes);

  return app;
}
