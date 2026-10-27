import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { INGEST_STALE_MS } from '../../src/api/routes/live.js';
import { createTestApp, type TestApp } from '../helpers/app.js';

const STREAM = '3b241101-e2bb-4255-8caf-4136c566a962';
const PLAYLIST = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.000000,\nseg_00000.m4s\n';

describe('GET /api/live/:id/:file', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    // What the live process publishes for a stream.
    await t.app.storage.put(`live/${STREAM}/live.m3u8`, PLAYLIST);
    await t.app.storage.put(`live/${STREAM}/init.mp4`, Buffer.from('init'));
    await t.app.storage.put(`live/${STREAM}/seg_00000.m4s`, Buffer.from('segment-0'));
  });

  afterAll(async () => {
    await t.close();
  });

  const get = (url: string, apiKey: string | null = t.apiKey) =>
    t.app.inject({ method: 'GET', url, headers: apiKey === null ? {} : { 'x-api-key': apiKey } });

  it('serves the live playlist uncached', async () => {
    const res = await get(`/api/live/${STREAM}/live.m3u8`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/vnd\.apple\.mpegurl/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toBe(PLAYLIST);
  });

  it('serves the init and media segments it lists', async () => {
    const init = await get(`/api/live/${STREAM}/init.mp4`);
    expect(init.statusCode).toBe(200);
    expect(init.headers['content-type']).toBe('video/mp4');
    const segment = await get(`/api/live/${STREAM}/seg_00000.m4s`);
    expect(segment.statusCode).toBe(200);
    expect(segment.headers['content-type']).toBe('video/iso.segment');
    expect(segment.body).toBe('segment-0');
  });

  it('requires the API key', async () => {
    expect((await get(`/api/live/${STREAM}/live.m3u8`, null)).statusCode).toBe(401);
  });

  it('answers 404 for unknown streams, missing segments and anything not live output', async () => {
    for (const url of [
      '/api/live/00000000-0000-4000-8000-000000000000/live.m3u8',
      `/api/live/${STREAM}/seg_00001.m4s`,
      `/api/live/${STREAM}/master.m3u8`,
      `/api/live/${STREAM}/..%2F..%2Fvideos`,
      '/api/live/not-a-stream/live.m3u8',
      `/api/live/${STREAM.toUpperCase()}/live.m3u8`,
    ]) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
  });
});

/**
 * The lifecycle API against the database alone: these tests play the live process's part
 * (reporting in, going live, ending) through the same repositories it uses.
 */
describe('live stream lifecycle API', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const request = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    apiKey: string | null = t.apiKey,
  ) => t.app.inject({ method, url, headers: apiKey === null ? {} : { 'x-api-key': apiKey } });
  const ingestOnline = () => t.app.db.liveIngest.report({ state: 'idle', error: null });

  it('refuses to start a stream while live ingest is not running', async () => {
    let res = await request('POST', '/api/live/streams');
    expect(res.statusCode).toBe(503);
    expect(res.json<{ message: string }>().message).toMatch(/live ingest is not running/);

    // A clean shutdown reports `offline`.
    await t.app.db.liveIngest.report({ state: 'offline', error: null });
    expect((await request('POST', '/api/live/streams')).statusCode).toBe(503);

    // So does silence: a live process that died cannot report anything.
    await ingestOnline();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + INGEST_STALE_MS + 1_000);
    res = await request('POST', '/api/live/streams');
    expect(res.statusCode).toBe(503);
    expect(await t.app.db.liveStreams.list()).toMatchObject({ total: 0 });
  });

  it('starts one stream at a time and reports it', async () => {
    await ingestOnline();
    const created = await request('POST', '/api/live/streams');
    expect(created.statusCode).toBe(201);
    const stream = created.json<{ id: string; playlist: string }>();
    expect(created.headers.location).toBe(`/api/live/streams/${stream.id}`);
    expect(stream).toMatchObject({
      status: 'waiting',
      endReason: null,
      startedAt: null,
      playlist: `/api/live/${stream.id}/live.m3u8`,
      ingest: { online: true, state: 'idle', error: null },
    });

    const second = await request('POST', '/api/live/streams');
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ activeStreamId: stream.id });

    // The live process reports what it is doing; the API passes it on.
    await t.app.db.liveIngest.report({ state: 'restarting', error: 'cannot listen on port 1935' });
    const got = await request('GET', `/api/live/streams/${stream.id}`);
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({
      id: stream.id,
      status: 'waiting',
      ingest: { online: true, state: 'restarting', error: 'cannot listen on port 1935' },
    });

    const list = await request('GET', '/api/live/streams?status=waiting');
    expect(list.json()).toMatchObject({ total: 1, items: [{ id: stream.id, status: 'waiting' }] });
    expect((await request('GET', '/api/live/streams?status=ended')).json()).toMatchObject({
      total: 0,
    });
    expect((await request('GET', '/api/live/streams?status=bogus')).statusCode).toBe(400);
    expect((await request('GET', '/api/live/streams/no-such-stream')).statusCode).toBe(404);
  });

  it('stops a waiting stream itself, at once, and is idempotent', async () => {
    await ingestOnline();
    const { id } = (await request('POST', '/api/live/streams')).json<{ id: string }>();

    const stopped = await request('DELETE', `/api/live/streams/${id}`);
    expect(stopped.statusCode).toBe(200);
    const body = stopped.json<{ cleanupAfter: string }>();
    expect(body).toMatchObject({ status: 'ended', endReason: 'stopped', startedAt: null });
    // Nothing was published, so nothing needs to linger.
    expect(Date.parse(body.cleanupAfter)).toBeLessThanOrEqual(Date.now());

    const again = await request('DELETE', `/api/live/streams/${id}`);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'ended', endReason: 'stopped' });
    expect((await request('DELETE', '/api/live/streams/no-such-stream')).statusCode).toBe(404);

    // The slot is free again.
    expect((await request('POST', '/api/live/streams')).statusCode).toBe(201);
  });

  it('asks the live process to stop a live stream and waits for it to end', async () => {
    await ingestOnline();
    const { id } = (await request('POST', '/api/live/streams')).json<{ id: string }>();
    await t.app.db.liveStreams.markLive(id);

    // Stand in for the live process: end the stream once the stop request shows up.
    const liveProcess = (async () => {
      for (;;) {
        const stream = await t.app.db.liveStreams.get(id);
        if (stream?.stopRequestedAt) {
          await t.app.db.liveStreams.end(id, {
            reason: 'stopped',
            cleanupAfter: new Date(Date.now() + 60_000).toISOString(),
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
    const stopped = await request('DELETE', `/api/live/streams/${id}`);
    await liveProcess;
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ status: 'ended', endReason: 'stopped' });
    expect(stopped.json<{ stopRequestedAt: string | null }>().stopRequestedAt).not.toBeNull();
  });

  it('answers 202 for a live stream whose live process is gone', async () => {
    await ingestOnline();
    const { id } = (await request('POST', '/api/live/streams')).json<{ id: string }>();
    await t.app.db.liveStreams.markLive(id);
    await t.app.db.liveIngest.report({ state: 'offline', error: null });

    const res = await request('DELETE', `/api/live/streams/${id}`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'live', ingest: { online: false } });
    expect(res.json<{ stopRequestedAt: string | null }>().stopRequestedAt).not.toBeNull();
  });

  it('stops pointing at the playlist once the files are deleted', async () => {
    await ingestOnline();
    const { id } = (await request('POST', '/api/live/streams')).json<{ id: string }>();
    await request('DELETE', `/api/live/streams/${id}`);
    await t.app.db.liveStreams.markCleaned(id);
    const res = await request('GET', `/api/live/streams/${id}`);
    expect(res.json()).toMatchObject({ status: 'ended', playlist: null });
  });

  it('requires the API key for every lifecycle route', async () => {
    for (const [method, url] of [
      ['POST', '/api/live/streams'],
      ['GET', '/api/live/streams'],
      ['GET', `/api/live/streams/${STREAM}`],
      ['DELETE', `/api/live/streams/${STREAM}`],
    ] as const) {
      expect((await request(method, url, null)).statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
