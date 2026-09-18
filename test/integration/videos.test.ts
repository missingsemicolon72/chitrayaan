import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Video } from '../../src/lib/db/index.js';
import { createTestApp, type TestApp } from '../helpers/app.js';

describe('video read endpoints', () => {
  let t: TestApp;
  let headers: Record<string, string>;

  beforeAll(async () => {
    t = await createTestApp();
    headers = { 'x-api-key': t.apiKey };
  });

  afterAll(async () => {
    await t.close();
  });

  it('GET /api/videos/:id returns the video with its jobs, 404 when unknown', async () => {
    const video = await t.app.db.videos.create({ title: 'one', status: 'uploaded' });
    const job = await t.app.db.jobs.create({ videoId: video.id });

    const res = await t.app.inject({ method: 'GET', url: `/api/videos/${video.id}`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: video.id, title: 'one', jobs: [{ id: job.id }] });

    const missing = await t.app.inject({ method: 'GET', url: '/api/videos/nope', headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ statusCode: 404, error: 'Not Found' });
  });

  it('GET /api/videos paginates and filters by status', async () => {
    await t.app.db.videos.create({ status: 'ready' });
    await t.app.db.videos.create({ status: 'ready' });
    await t.app.db.videos.create({ status: 'failed' });

    const all = await t.app.inject({ method: 'GET', url: '/api/videos', headers });
    expect(all.statusCode).toBe(200);
    const page = all.json<{ items: Video[]; total: number; limit: number; offset: number }>();
    expect(page.total).toBeGreaterThanOrEqual(3);
    expect(page.limit).toBe(50);

    const ready = await t.app.inject({
      method: 'GET',
      url: '/api/videos?status=ready&limit=1&offset=1',
      headers,
    });
    const readyPage = ready.json<{
      items: Video[];
      total: number;
      limit: number;
      offset: number;
    }>();
    expect(readyPage).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(readyPage.items).toHaveLength(1);
    expect(readyPage.items[0]?.status).toBe('ready');
  });

  it('rejects invalid query parameters with 400', async () => {
    for (const qs of ['status=bogus', 'limit=0', 'limit=abc', 'offset=-1']) {
      const res = await t.app.inject({ method: 'GET', url: `/api/videos?${qs}`, headers });
      expect(res.statusCode, qs).toBe(400);
    }
  });
});
