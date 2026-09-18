import pino, { type Logger, type LoggerOptions } from 'pino';

import type { AppConfig } from '../config/index.js';

/** pino options shared by the API (via Fastify) and the worker: pretty in dev, JSON otherwise. */
export function pinoOptionsFor(config: Pick<AppConfig, 'NODE_ENV' | 'LOG_LEVEL'>): LoggerOptions {
  if (config.NODE_ENV === 'test') return { level: 'silent' };
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

export function createLogger(
  config: Pick<AppConfig, 'NODE_ENV' | 'LOG_LEVEL'>,
  name?: string,
): Logger {
  return pino({ ...pinoOptionsFor(config), ...(name ? { name } : {}) });
}

export type { Logger };

/** The subset shared by pino loggers and Fastify's `app.log`, for code that accepts either. */
export type MinimalLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
