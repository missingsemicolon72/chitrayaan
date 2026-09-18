import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/api/app.js';
import type { Database } from '../../src/lib/db/index.js';
import { createTestApp, type TestApp } from '../helpers/app.js';

describe('GET /healthz', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('responds 200 with a liveness payload and no auth header', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });

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
    expect(t.app.config.NODE_ENV).toBe('test');
    expect(t.app.db.backend).toBe('sqlite');
    expect(t.app.storage.backend).toBe('local');
    const video = await t.app.db.videos.create({ title: 'wired' });
    expect((await t.app.db.videos.get(video.id))?.title).toBe('wired');
  });

  it('reports 503 degraded when the database ping fails', async () => {
    const broken: Database = {
      backend: 'sqlite',
      videos: t.app.db.videos,
      jobs: t.app.db.jobs,
      migrate: () => Promise.resolve(),
      ping: () => Promise.reject(new Error('database is down')),
      close: () => Promise.resolve(),
    };
    const degraded = await buildApp(t.app.config, { db: broken, storage: t.app.storage });
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
