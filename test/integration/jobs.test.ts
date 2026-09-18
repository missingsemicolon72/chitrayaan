import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Job } from '../../src/lib/db/index.js';
import { createTestApp, type TestApp } from '../helpers/app.js';

interface JobPage {
  items: Job[];
  total: number;
  limit: number;
  offset: number;
}

describe('job status endpoints (no Redis required)', () => {
  let t: TestApp;
  let headers: Record<string, string>;

  beforeAll(async () => {
    t = await createTestApp();
    headers = { 'x-api-key': t.apiKey };
  });

  afterAll(async () => {
    await t.close();
  });

  it('GET /api/jobs/:id returns the database record, 404 when unknown', async () => {
    const video = await t.app.db.videos.create({ status: 'uploaded' });
    const job = await t.app.db.jobs.create({ videoId: video.id });

    const res = await t.app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json<Job & { queue: unknown }>();
    expect(body).toMatchObject({ id: job.id, videoId: video.id, status: 'queued', progress: 0 });
    expect('queue' in body).toBe(true);

    const missing = await t.app.inject({ method: 'GET', url: '/api/jobs/nope', headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ statusCode: 404, error: 'Not Found' });
  });

  it('GET /api/jobs lists newest first with videoId/status filters and pagination', async () => {
    const v1 = await t.app.db.videos.create({ status: 'uploaded' });
    const v2 = await t.app.db.videos.create({ status: 'uploaded' });
    const j1 = await t.app.db.jobs.create({ videoId: v1.id });
    const j2 = await t.app.db.jobs.create({ videoId: v1.id, status: 'completed' });
    await t.app.db.jobs.create({ videoId: v2.id });

    const forV1 = await t.app.inject({
      method: 'GET',
      url: `/api/jobs?videoId=${v1.id}`,
      headers,
    });
    expect(forV1.statusCode).toBe(200);
    const page = forV1.json<JobPage>();
    expect(page.total).toBe(2);
    expect(page.items.map((j) => j.id).sort()).toEqual([j1.id, j2.id].sort());

    const completed = await t.app.inject({
      method: 'GET',
      url: `/api/jobs?videoId=${v1.id}&status=completed`,
      headers,
    });
    expect(completed.json<JobPage>().items.map((j) => j.id)).toEqual([j2.id]);

    const paged = await t.app.inject({ method: 'GET', url: '/api/jobs?limit=1&offset=1', headers });
    expect(paged.json<JobPage>()).toMatchObject({ limit: 1, offset: 1 });
    expect(paged.json<JobPage>().items).toHaveLength(1);
  });

  it('rejects invalid query parameters with 400 and requires the API key', async () => {
    for (const qs of ['status=bogus', 'limit=0', 'offset=-1', 'videoId=']) {
      const res = await t.app.inject({ method: 'GET', url: `/api/jobs?${qs}`, headers });
      expect(res.statusCode, qs).toBe(400);
    }
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(401);
  });
});
