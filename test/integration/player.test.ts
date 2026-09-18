import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from '../helpers/app.js';

describe('test player page', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('serves the page and its assets without an API key', async () => {
    const page = await t.app.inject({ method: 'GET', url: '/player/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('Chitrayaan test player');
    expect(page.body).toContain('vendor/hls/hls.min.js');
    expect(page.body).toContain('vendor/dash/dash.all.min.js');

    for (const asset of ['/player/app.js', '/player/style.css']) {
      const res = await t.app.inject({ method: 'GET', url: asset });
      expect(res.statusCode, asset).toBe(200);
    }
  });

  it('serves pinned hls.js and dash.js UMD builds from node_modules', async () => {
    const hls = await t.app.inject({ method: 'GET', url: '/player/vendor/hls/hls.min.js' });
    expect(hls.statusCode).toBe(200);
    expect(hls.headers['content-type']).toMatch(/javascript/);
    expect(hls.body.length).toBeGreaterThan(100_000);

    const dash = await t.app.inject({ method: 'GET', url: '/player/vendor/dash/dash.all.min.js' });
    expect(dash.statusCode).toBe(200);
    expect(dash.body.length).toBeGreaterThan(100_000);
    expect(dash.body).toContain('dashjs');
  });

  it('does not expose anything outside the player and vendor directories', async () => {
    for (const url of [
      '/player/../package.json',
      '/player/vendor/hls/../../package.json',
      '/player/vendor/dash/../../../package.json',
      '/player/nope.html',
    ]) {
      const res = await t.app.inject({ method: 'GET', url });
      expect([400, 401, 403, 404], url).toContain(res.statusCode);
      expect(res.body, url).not.toContain('"name": "chitrayaan"');
    }
  });

  it('keeps the API itself behind the key', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/videos' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/playerx' })).statusCode).toBe(401);
  });
});
