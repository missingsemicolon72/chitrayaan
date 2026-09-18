import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/api/app.js';
import { loadConfig } from '../../src/config/index.js';
import type { Database } from '../../src/lib/db/index.js';

describe('GET /healthz', () => {
  let app: FastifyInstance;
  let storageRoot: string;

  beforeAll(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-healthz-'));
    app = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        API_KEY: 'a-sufficiently-long-test-key',
        SQLITE_PATH: ':memory:',
        LOCAL_STORAGE_PATH: storageRoot,
      }),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('responds 200 with a liveness payload and no auth header', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);

    const body = res.json<{
      status: string;
      checks: { db: string };
      uptimeSeconds: number;
      timestamp: string;
    }>();
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ db: 'ok' });
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
  });

  it('exposes config, a migrated database, and storage on the instance', async () => {
    expect(app.config.NODE_ENV).toBe('test');
    expect(app.db.backend).toBe('sqlite');
    expect(app.storage.backend).toBe('local');
    const video = await app.db.videos.create({ title: 'wired' });
    expect((await app.db.videos.get(video.id))?.title).toBe('wired');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('reports 503 degraded when the database ping fails', async () => {
    const broken: Database = {
      backend: 'sqlite',
      videos: app.db.videos,
      jobs: app.db.jobs,
      migrate: () => Promise.resolve(),
      ping: () => Promise.reject(new Error('database is down')),
      close: () => Promise.resolve(),
    };
    const degraded = await buildApp(app.config, { db: broken, storage: app.storage });
    try {
      const res = await degraded.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(503);
      expect(res.json<{ status: string; checks: { db: string } }>()).toMatchObject({
        status: 'degraded',
        checks: { db: 'error' },
      });
    } finally {
      await degraded.close();
    }
  });
});
