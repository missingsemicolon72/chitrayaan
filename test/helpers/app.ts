import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/api/app.js';
import { loadConfig } from '../../src/config/index.js';
import { TranscodeQueue } from '../../src/lib/queue/index.js';
import { redisAvailable, TEST_REDIS_URL, testQueuePrefix } from './redis.js';

export const TEST_API_KEY = 'a-sufficiently-long-test-key';

export interface TestApp {
  app: FastifyInstance;
  /** Set only when `listen: true`; e.g. `http://127.0.0.1:54321`. */
  baseUrl: string;
  apiKey: string;
  storageRoot: string;
  /** Queue handle on a prefix unique to this test app; wiped on close. */
  queue: TranscodeQueue;
  queuePrefix: string;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  /** Bind a real port (needed for protocol-level tests such as tus). */
  listen?: boolean;
  /** Extra env overrides on top of the test defaults. */
  env?: Record<string, string>;
}

/**
 * An app wired to an in-memory SQLite database, a throwaway storage directory, and a queue on a
 * per-run Redis key prefix. Always `await close()` in `afterAll`/`afterEach`.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    API_KEY: TEST_API_KEY,
    SQLITE_PATH: ':memory:',
    LOCAL_STORAGE_PATH: storageRoot,
    REDIS_URL: TEST_REDIS_URL,
    ...options.env,
  });
  const queuePrefix = testQueuePrefix();
  const queue = new TranscodeQueue(config.REDIS_URL, { prefix: queuePrefix });
  const app = await buildApp(config, { queue });

  let baseUrl = '';
  if (options.listen) {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  } else {
    await app.ready();
  }

  return {
    app,
    baseUrl,
    apiKey: TEST_API_KEY,
    storageRoot,
    queue,
    queuePrefix,
    close: async () => {
      await app.close();
      if (await redisAvailable()) await queue.obliterate().catch(() => undefined);
      await queue.close();
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}
