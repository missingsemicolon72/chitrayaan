import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from '../helpers/app.js';

const SESSION = '3b241101-e2bb-4255-8caf-4136c566a962';
const PLAYLIST = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.000000,\nseg_00000.m4s\n';

describe('GET /api/live/:id/:file', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    // What the live process publishes for a session.
    await t.app.storage.put(`live/${SESSION}/live.m3u8`, PLAYLIST);
    await t.app.storage.put(`live/${SESSION}/init.mp4`, Buffer.from('init'));
    await t.app.storage.put(`live/${SESSION}/seg_00000.m4s`, Buffer.from('segment-0'));
  });

  afterAll(async () => {
    await t.close();
  });

  const get = (url: string, apiKey: string | null = t.apiKey) =>
    t.app.inject({ method: 'GET', url, headers: apiKey === null ? {} : { 'x-api-key': apiKey } });

  it('serves the live playlist uncached', async () => {
    const res = await get(`/api/live/${SESSION}/live.m3u8`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/vnd\.apple\.mpegurl/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toBe(PLAYLIST);
  });

  it('serves the init and media segments it lists', async () => {
    const init = await get(`/api/live/${SESSION}/init.mp4`);
    expect(init.statusCode).toBe(200);
    expect(init.headers['content-type']).toBe('video/mp4');
    const segment = await get(`/api/live/${SESSION}/seg_00000.m4s`);
    expect(segment.statusCode).toBe(200);
    expect(segment.headers['content-type']).toBe('video/iso.segment');
    expect(segment.body).toBe('segment-0');
  });

  it('requires the API key', async () => {
    expect((await get(`/api/live/${SESSION}/live.m3u8`, null)).statusCode).toBe(401);
  });

  it('answers 404 for unknown sessions, missing segments and anything not live output', async () => {
    for (const url of [
      '/api/live/00000000-0000-4000-8000-000000000000/live.m3u8',
      `/api/live/${SESSION}/seg_00001.m4s`,
      `/api/live/${SESSION}/master.m3u8`,
      `/api/live/${SESSION}/..%2F..%2Fvideos`,
      '/api/live/not-a-session/live.m3u8',
      `/api/live/${SESSION.toUpperCase()}/live.m3u8`,
    ]) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
  });
});
