import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';

/** Redis used by queue tests. Override with TEST_REDIS_URL. */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

let probe: Promise<boolean> | undefined;

/**
 * True when a Redis answers at TEST_REDIS_URL. Queue-dependent suites use
 * `describe.skipIf(!(await redisAvailable()))` so the rest of the suite stays green without it.
 */
export function redisAvailable(): Promise<boolean> {
  probe ??= (async () => {
    const client = new Redis(TEST_REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 1_500,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.ping();
      return true;
    } catch {
      console.warn(`[tests] Redis not reachable at ${TEST_REDIS_URL}; queue tests are skipped`);
      return false;
    } finally {
      client.disconnect();
    }
  })();
  return probe;
}

/** A key prefix unique to one test file so parallel suites never see each other's jobs. */
export function testQueuePrefix(): string {
  return `chitrayaan-test-${randomUUID().slice(0, 8)}`;
}
