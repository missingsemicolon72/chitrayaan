import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from '../helpers/app.js';

describe('X-API-Key auth', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('leaves /healthz public', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    // 200, or 503 when a dependency (Redis) is absent in this environment; never 401.
    expect([200, 503]).toContain(res.statusCode);
    expect(res.json()).toHaveProperty('checks');
  });

  it('rejects a missing key with 401 and a JSON body', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/videos' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'missing or invalid x-api-key header',
    });
  });

  it('rejects wrong keys, including ones of a different length', async () => {
    for (const key of ['wrong-key-of-the-same-length', 'short', `${t.apiKey}x`, '']) {
      const res = await t.app.inject({
        method: 'GET',
        url: '/api/videos',
        headers: { 'x-api-key': key },
      });
      expect(res.statusCode, key).toBe(401);
    }
  });

  it('accepts the configured key regardless of header casing', async () => {
    for (const name of ['X-API-Key', 'x-api-key', 'X-Api-Key']) {
      const res = await t.app.inject({
        method: 'GET',
        url: '/api/videos',
        headers: { [name]: t.apiKey },
      });
      expect(res.statusCode, name).toBe(200);
    }
  });

  it('answers 401 (not 404) for unknown routes without a key, 404 with one', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(401);
    expect(
      (await t.app.inject({ method: 'GET', url: '/nope', headers: { 'x-api-key': t.apiKey } }))
        .statusCode,
    ).toBe(404);
  });

  it('never blocks OPTIONS (CORS preflight cannot carry the header)', async () => {
    // No OPTIONS route exists here, so Fastify answers 404: the hook let it through.
    // (tus OPTIONS without a key is covered over real HTTP in uploads.test.ts.)
    const res = await t.app.inject({ method: 'OPTIONS', url: '/api/videos' });
    expect(res.statusCode).toBe(404);
  });
});
