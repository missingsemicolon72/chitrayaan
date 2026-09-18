import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/api/app.js';
import { loadConfig } from '../../src/config/index.js';

describe('GET /healthz', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', API_KEY: 'a-sufficiently-long-test-key' }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('responds 200 with a liveness payload and no auth header', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);

    const body = res.json<{ status: string; uptimeSeconds: number; timestamp: string }>();
    expect(body.status).toBe('ok');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
  });

  it('exposes the validated config on the instance', () => {
    expect(app.config.NODE_ENV).toBe('test');
    expect(app.config.API_KEY).toBe('a-sufficiently-long-test-key');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
  });
});
