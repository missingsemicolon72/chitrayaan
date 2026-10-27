import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { MinimalLogger } from '../../src/lib/logger.js';
import {
  isLiveFileName,
  LIVE_WINDOW_SEGMENTS,
  parseLivePlaylist,
} from '../../src/lib/packaging/index.js';
import type { EndedSession, LiveSession } from '../../src/lib/rtmp/index.js';
import { LocalDiskStorage } from '../../src/lib/storage/index.js';
import { LiveIngest } from '../../src/live/ingest.js';
import { FFMPEG_PATH, FFPROBE_PATH, ffmpegAvailable } from '../helpers/ffmpeg.js';
import { freePort, listenerReady, portInUse, publish } from '../helpers/rtmp.js';
import { waitFor } from '../helpers/wait.js';

const FFMPEG = await ffmpegAvailable();
const STREAM_KEY = 'test-stream-key-0123456789';
const SLOW = 60_000;
const execFileAsync = promisify(execFile);

interface Harness {
  ingest: LiveIngest;
  storageRoot: string;
  workRoot: string;
  port: number;
  started: { streamId: string; session: LiveSession }[];
  ended: { streamId: string; session: EndedSession }[];
  logs: string[];
}

const cleanups: (() => Promise<void>)[] = [];

async function startIngest(): Promise<Harness> {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-live-store-'));
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-live-work-'));
  const workRoot = path.join(scratch, 'live');
  const port = await freePort();
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
  const started: Harness['started'] = [];
  const ended: Harness['ended'] = [];
  const ingest = new LiveIngest({
    ffmpegPath: FFMPEG_PATH,
    host: '127.0.0.1',
    port,
    streamKey: STREAM_KEY,
    storage: await LocalDiskStorage.create(storageRoot),
    workRoot,
    logger,
    idleTimeoutSeconds: 2,
    pollMs: 100,
    hooks: {
      started: (streamId, session) => {
        started.push({ streamId, session });
      },
      ended: (streamId, session) => {
        ended.push({ streamId, session });
      },
    },
  });
  cleanups.push(async () => {
    await ingest.stop();
    await rm(storageRoot, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });
  await ingest.start();
  return { ingest, storageRoot, workRoot, port, started, ended, logs };
}

/** Arm the ingest for a new stream and wait until its listener can take a publisher. */
async function armStream(h: Harness): Promise<string> {
  const streamId = randomUUID();
  h.ingest.arm(streamId);
  await listenerReady(h.ingest);
  return streamId;
}

function streamDir(h: Harness, id: string): string {
  return path.join(h.storageRoot, 'live', id);
}

async function storedPlaylist(h: Harness, id: string): Promise<string> {
  return readFile(path.join(streamDir(h, id), 'live.m3u8'), 'utf8').catch(() => '');
}

/** Published files, ignoring the storage driver's in-flight temp files. */
async function storedFiles(h: Harness, id: string): Promise<string[]> {
  return (await readdir(streamDir(h, id))).filter(isLiveFileName).sort();
}

describe.skipIf(!FFMPEG)('live transcode to rolling HLS (LiveIngest)', () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it(
    'publishes a sliding window of 720p CMAF segments while live, a complete one at the end, and then closes the port',
    async () => {
      const h = await startIngest();
      const id = await armStream(h);
      const publisher = publish({
        port: h.port,
        streamKey: STREAM_KEY,
        seconds: 16,
        size: '1920x1080',
      });

      // While live: the playlist is open-ended and everything it lists is already stored.
      const live = await waitFor(
        () => storedPlaylist(h, id),
        (text) => parseLivePlaylist(text).segments.length >= 3,
        { timeoutMs: 20_000 },
      );
      expect(h.started.map((s) => s.streamId)).toEqual([id]);
      expect(h.ingest.status()).toMatchObject({ state: 'live', streamId: id, error: null });
      const during = parseLivePlaylist(live);
      expect(during.ended).toBe(false);
      expect(during.initSegment).toBe('init.mp4');
      const files = await storedFiles(h, id);
      for (const file of ['init.mp4', ...during.segments]) expect(files).toContain(file);
      // Each segment carries its wall-clock time, which players use to place the live edge.
      // (Latency itself depends on the machine keeping up, so it is checked end to end instead.)
      expect(live.match(/^#EXT-X-PROGRAM-DATE-TIME:/gm)).toHaveLength(during.segments.length);

      expect((await publisher.done).exitCode).toBe(0);
      await waitFor(
        async () => h.ended.length,
        (n) => n === 1,
        { timeoutMs: 15_000 },
      );
      expect(h.ended[0]).toMatchObject({
        streamId: id,
        session: { reason: 'publisher-disconnected' },
      });
      expect(h.logs.some((line) => line.includes('live stream published in full'))).toBe(true);

      // The end: an ended playlist over the last window; older segments already deleted.
      const final = parseLivePlaylist(await storedPlaylist(h, id));
      expect(final.ended).toBe(true);
      expect(final.segments).toHaveLength(LIVE_WINDOW_SEGMENTS);
      expect(final.segments).not.toContain('seg_00000.m4s');
      expect(await storedFiles(h, id)).toEqual(['init.mp4', 'live.m3u8', ...final.segments].sort());

      // The one rung: 1080p in, 720p H.264 High + 48 kHz stereo AAC out.
      const { stdout } = await execFileAsync(FFPROBE_PATH, [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name,profile,width,height,sample_rate,channels',
        '-of',
        'json',
        path.join(streamDir(h, id), 'live.m3u8'),
      ]);
      const streams = (JSON.parse(stdout) as { streams: Record<string, unknown>[] }).streams;
      expect(streams).toContainEqual(
        expect.objectContaining({ codec_name: 'h264', profile: 'High', width: 1280, height: 720 }),
      );
      expect(streams).toContainEqual(
        expect.objectContaining({ codec_name: 'aac', sample_rate: '48000', channels: 2 }),
      );

      // One publish per stream: the ingest is idle, nothing listens, no scratch files remain.
      await waitFor(
        async () => h.ingest.status().state,
        (state) => state === 'idle',
      );
      expect(h.ingest.currentStreamId).toBeNull();
      expect(await portInUse(h.port)).toBe(false);
      expect(await readdir(h.workRoot)).toEqual([]);
      expect(h.logs.join('\n')).not.toContain(STREAM_KEY);
    },
    SLOW,
  );

  it(
    'ends the playlist when disarmed mid-stream, and leaves no scratch files',
    async () => {
      const h = await startIngest();
      const id = await armStream(h);
      const publisher = publish({ port: h.port, streamKey: STREAM_KEY, seconds: 30 });
      await waitFor(
        () => storedPlaylist(h, id),
        (text) => parseLivePlaylist(text).segments.length >= 2,
        { timeoutMs: 20_000 },
      );

      await h.ingest.disarm();
      // The end hook ran before disarm() resolved.
      expect(h.ended).toMatchObject([{ streamId: id, session: { reason: 'stopped' } }]);
      expect((await publisher.done).exitCode).not.toBe(0);
      expect(parseLivePlaylist(await storedPlaylist(h, id)).ended).toBe(true);
      expect(h.ingest.status()).toEqual({ state: 'idle', streamId: null, error: null });
      expect(await readdir(h.workRoot)).toEqual([]);
    },
    SLOW,
  );

  it(
    'keeps listening past a rejected publisher, and disarming before a publisher frees everything',
    async () => {
      const h = await startIngest();
      const id = await armStream(h);
      const rejected = publish({
        port: h.port,
        streamKey: 'wrong-stream-key-0123456789',
        seconds: 3,
      });
      expect((await rejected.done).exitCode).not.toBe(0);
      await listenerReady(h.ingest);

      // The listener re-armed for the same stream, in a fresh (empty) directory.
      expect(h.ingest.status()).toMatchObject({ state: 'listening', streamId: id });
      expect(await readdir(h.workRoot)).toEqual([id]);
      expect(await readdir(path.join(h.workRoot, id))).toEqual([]);
      expect(() => h.ingest.arm(randomUUID())).toThrow(/already serving/);

      await h.ingest.disarm();
      expect(h.started).toEqual([]);
      expect(h.ended).toEqual([]);
      expect(await readdir(h.workRoot)).toEqual([]);
      expect(await readdir(h.storageRoot)).toEqual([]);
      expect(await portInUse(h.port)).toBe(false);
    },
    SLOW,
  );
});
