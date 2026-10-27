import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { MinimalLogger } from '../../src/lib/logger.js';
import { parseLivePlaylist } from '../../src/lib/packaging/index.js';
import { LiveController } from '../../src/live/controller.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { FFMPEG_PATH, ffmpegAvailable } from '../helpers/ffmpeg.js';
import { freePort, listenerReady, portInUse, publish, type Publisher } from '../helpers/rtmp.js';
import { waitFor } from '../helpers/wait.js';

const FFMPEG = await ffmpegAvailable();
const STREAM_KEY = 'test-stream-key-0123456789';
const SLOW = 60_000;
const CLEANUP_DELAY_SECONDS = 2;

interface StreamBody {
  id: string;
  status: string;
  endReason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  cleanupAfter: string | null;
  cleanedAt: string | null;
  playlist: string | null;
  ingest: { online: boolean; state: string; error: string | null };
}

interface Harness {
  t: TestApp;
  port: number;
  workRoot: string;
  logs: string[];
  controller: LiveController;
  /** Start another controller on the same database, storage and port, as a restart would. */
  restart: () => Promise<LiveController>;
}

const cleanups: (() => Promise<void> | void)[] = [];

/**
 * The API and the live process's controller, in one process for the test but sharing nothing
 * except the database and storage, as in production. `prepare` runs before the controller starts.
 */
async function startHarness(prepare?: (t: TestApp) => Promise<void>): Promise<Harness> {
  const t = await createTestApp();
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-lifecycle-'));
  cleanups.push(async () => {
    await t.close();
    await rm(scratch, { recursive: true, force: true });
  });
  await prepare?.(t);
  const port = await freePort();
  const workRoot = path.join(scratch, 'live');
  const logs: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      logs.push(`${level} ${JSON.stringify(args)}`);
    };
  const logger: MinimalLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
  const newController = async () => {
    const controller = new LiveController({
      db: t.app.db,
      storage: t.app.storage,
      ffmpegPath: FFMPEG_PATH,
      host: '127.0.0.1',
      port,
      streamKey: STREAM_KEY,
      workRoot,
      logger,
      cleanupDelaySeconds: CLEANUP_DELAY_SECONDS,
      checkMs: 100,
      reportMs: 1_000,
      idleTimeoutSeconds: 2,
      pollMs: 100,
    });
    cleanups.push(() => controller.stop());
    await controller.start();
    return controller;
  };
  return { t, port, workRoot, logs, controller: await newController(), restart: newController };
}

function api(h: Harness) {
  const call = async (method: 'GET' | 'POST' | 'DELETE', url: string) => {
    const res = await h.t.app.inject({ method, url, headers: { 'x-api-key': h.t.apiKey } });
    return { status: res.statusCode, body: res.json<StreamBody>(), text: res.body };
  };
  return {
    start: () => call('POST', '/api/live/streams'),
    get: (id: string) => call('GET', `/api/live/streams/${id}`),
    stop: (id: string) => call('DELETE', `/api/live/streams/${id}`),
    playlist: async (id: string) => {
      const res = await h.t.app.inject({
        method: 'GET',
        url: `/api/live/${id}/live.m3u8`,
        headers: { 'x-api-key': h.t.apiKey },
      });
      return { status: res.statusCode, text: res.body };
    },
  };
}

function startPublisher(...args: Parameters<typeof publish>): Publisher {
  const publisher = publish(...args);
  cleanups.push(() => publisher.kill());
  return publisher;
}

async function waitForStatus(h: Harness, id: string, done: (s: StreamBody) => boolean) {
  return (
    await waitFor(
      () => api(h).get(id),
      (res) => done(res.body),
      { timeoutMs: 20_000 },
    )
  ).body;
}

/** Wait until the API serves a playlist listing at least `segments` segments. */
async function waitForPlaylist(h: Harness, id: string, segments = 3) {
  return (
    await waitFor(
      () => api(h).playlist(id),
      (res) => res.status === 200 && parseLivePlaylist(res.text).segments.length >= segments,
      { timeoutMs: 20_000 },
    )
  ).text;
}

describe.skipIf(!FFMPEG)('live stream lifecycle (API + live controller + FFmpeg)', () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it(
    'runs a stream from start to cleanup: waiting, live, ended, files deleted',
    async () => {
      const h = await startHarness();
      const started = await api(h).start();
      expect(started.status).toBe(201);
      const { id } = started.body;
      expect(started.body).toMatchObject({ status: 'waiting', ingest: { online: true } });

      // The live process picks the stream up and listens for its publisher.
      await listenerReady(h.controller.ingest);
      expect(h.controller.ingest.currentStreamId).toBe(id);
      const publisher = startPublisher({ port: h.port, streamKey: STREAM_KEY, seconds: 8 });

      const live = await waitForStatus(h, id, (s) => s.status === 'live');
      expect(live.startedAt).not.toBeNull();
      expect(parseLivePlaylist(await waitForPlaylist(h, id)).ended).toBe(false);

      expect((await publisher.done).exitCode).toBe(0);
      const ended = await waitForStatus(h, id, (s) => s.status === 'ended');
      expect(ended).toMatchObject({ endReason: 'publisher-disconnected', cleanedAt: null });
      expect(Date.parse(ended.cleanupAfter ?? '') - Date.parse(ended.endedAt ?? '')).toBeCloseTo(
        CLEANUP_DELAY_SECONDS * 1000,
        -3,
      );
      const final = await api(h).playlist(id);
      expect(final.status).toBe(200);
      expect(parseLivePlaylist(final.text).ended).toBe(true);

      // One publish per stream: the port is closed until the next stream starts.
      await waitFor(
        async () => h.controller.ingest.status().state,
        (state) => state === 'idle',
      );
      expect(await portInUse(h.port)).toBe(false);

      // After the cleanup delay, its files go, and the API stops pointing at them.
      const cleaned = await waitForStatus(h, id, (s) => s.cleanedAt !== null);
      expect(cleaned).toMatchObject({ status: 'ended', playlist: null });
      expect((await api(h).playlist(id)).status).toBe(404);
      expect(await h.t.app.storage.list(`live/${id}/`)).toEqual([]);
      expect(h.logs.join('\n')).not.toContain(STREAM_KEY);
    },
    SLOW,
  );

  it(
    'stops a live stream through the API, cutting off the publisher, and frees the slot',
    async () => {
      const h = await startHarness();
      const { id } = (await api(h).start()).body;
      await listenerReady(h.controller.ingest);
      const publisher = startPublisher({ port: h.port, streamKey: STREAM_KEY, seconds: 30 });
      await waitForPlaylist(h, id);

      const stopped = await api(h).stop(id);
      expect(stopped.status).toBe(200);
      expect(stopped.body).toMatchObject({ status: 'ended', endReason: 'stopped' });
      expect((await publisher.done).exitCode).not.toBe(0);
      expect(parseLivePlaylist((await api(h).playlist(id)).text).ended).toBe(true);

      // The next stream can start at once, and the live process listens for it.
      const next = await api(h).start();
      expect(next.status).toBe(201);
      await waitFor(
        async () => h.controller.ingest.status(),
        (s) => s.streamId === next.body.id && s.state === 'listening',
      );
    },
    SLOW,
  );

  it(
    'stopping a stream before its publisher arrives closes the port',
    async () => {
      const h = await startHarness();
      const { id } = (await api(h).start()).body;
      await listenerReady(h.controller.ingest);
      expect(await portInUse(h.port)).toBe(true);

      expect((await api(h).stop(id)).body).toMatchObject({ status: 'ended', endReason: 'stopped' });
      await waitFor(
        async () => h.controller.ingest.status().state,
        (state) => state === 'idle',
      );
      await waitFor(
        () => portInUse(h.port),
        (inUse) => !inUse,
      );
      // Nothing was published; its (empty) cleanup is recorded all the same.
      expect((await waitForStatus(h, id, (s) => s.cleanedAt !== null)).playlist).toBeNull();
    },
    SLOW,
  );

  it(
    'shutting down mid-stream ends it as interrupted, while a waiting stream survives a restart',
    async () => {
      const h = await startHarness();
      const first = (await api(h).start()).body.id;
      await listenerReady(h.controller.ingest);
      startPublisher({ port: h.port, streamKey: STREAM_KEY, seconds: 30 });
      await waitForPlaylist(h, first);

      await h.controller.stop();
      expect((await api(h).get(first)).body).toMatchObject({
        status: 'ended',
        endReason: 'interrupted',
        ingest: { online: false, state: 'offline' },
      });
      expect(parseLivePlaylist((await api(h).playlist(first)).text).ended).toBe(true);
      expect((await api(h).start()).status).toBe(503);

      // A stream created while live ingest runs, and still waiting when it restarts, is picked
      // up again by the next run.
      const controller = await h.restart();
      const second = (await api(h).start()).body.id;
      await waitFor(
        async () => controller.ingest.status(),
        (s) => s.streamId === second && s.state === 'listening',
      );
      await controller.stop();
      expect((await api(h).get(second)).body.status).toBe('waiting');
      const again = await h.restart();
      await waitFor(
        async () => again.ingest.status(),
        (s) => s.streamId === second && s.state === 'listening',
      );
    },
    SLOW,
  );

  it(
    'on start, ends a stream a dead live process left live, and deletes files no stream owns',
    async () => {
      const orphan = randomUUID();
      let ended = '';
      let interrupted = '';
      const h = await startHarness(async (t) => {
        const { liveStreams } = t.app.db;
        // An ended stream whose viewers still have time left: its files stay.
        ended = (await liveStreams.create()).id;
        await liveStreams.end(ended, {
          reason: 'publisher-disconnected',
          cleanupAfter: new Date(Date.now() + 3_600_000).toISOString(),
        });
        await t.app.storage.put(`live/${ended}/live.m3u8`, '#EXTM3U\n#EXT-X-ENDLIST\n');
        // A stream that was live when its live process died: no end in its playlist.
        const live = await liveStreams.create();
        await liveStreams.markLive(live.id);
        interrupted = live.id;
        await t.app.storage.put(
          `live/${live.id}/live.m3u8`,
          '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.000000,\nseg_00000.m4s\n',
        );
        // Files no stream accounts for, such as sessions from before streams were recorded.
        await t.app.storage.put(`live/${orphan}/live.m3u8`, '#EXTM3U\n');
      });

      expect((await api(h).get(interrupted)).body).toMatchObject({
        status: 'ended',
        endReason: 'interrupted',
      });
      const playlist = await api(h).playlist(interrupted);
      expect(parseLivePlaylist(playlist.text)).toMatchObject({
        ended: true,
        segments: ['seg_00000.m4s'],
      });
      expect(await h.t.app.storage.list(`live/${orphan}/`)).toEqual([]);
      expect(await h.t.app.storage.list(`live/${ended}/`)).toHaveLength(1);
      // Nothing is waiting, so nothing listens.
      expect(h.controller.ingest.status().state).toBe('idle');
    },
    SLOW,
  );
});
