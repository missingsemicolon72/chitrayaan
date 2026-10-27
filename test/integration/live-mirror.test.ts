import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MinimalLogger } from '../../src/lib/logger.js';
import { LocalDiskStorage, type ObjectStorage } from '../../src/lib/storage/index.js';
import { LiveMirror, type LiveMirrorOptions } from '../../src/live/mirror.js';

const STREAM = '0f0e0d0c-0b0a-4908-8706-050403020100';

/** A playlist in FFmpeg's format listing `segments`. */
function playlist(segments: string[], ended = false): string {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MAP:URI="init.mp4"',
    ...segments.flatMap((s) => ['#EXTINF:2.000000,', s]),
    ...(ended ? ['#EXT-X-ENDLIST'] : []),
    '',
  ].join('\n');
}

/** Local disk storage that also records every write and delete, in order. */
function recording(inner: ObjectStorage, ops: string[]): ObjectStorage {
  return {
    backend: inner.backend,
    put: async (key, body, options) => {
      ops.push(`put ${key}`);
      await inner.put(key, body, options);
    },
    putFile: async (key, localPath, options) => {
      ops.push(`putFile ${key}`);
      await inner.putFile(key, localPath, options);
    },
    get: (key) => inner.get(key),
    downloadToFile: (key, localPath) => inner.downloadToFile(key, localPath),
    stat: (key) => inner.stat(key),
    exists: (key) => inner.exists(key),
    delete: async (key) => {
      ops.push(`delete ${key}`);
      await inner.delete(key);
    },
    deletePrefix: (prefix) => inner.deletePrefix(prefix),
    list: (prefix) => inner.list(prefix),
  };
}

describe('LiveMirror', () => {
  let dir: string;
  let storageRoot: string;
  let ops: string[];
  let warnings: string[];
  let storage: ObjectStorage;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-mirror-work-'));
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-mirror-store-'));
    ops = [];
    warnings = [];
    storage = recording(await LocalDiskStorage.create(storageRoot), ops);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  });

  function mirror(options: Partial<LiveMirrorOptions> = {}): LiveMirror {
    const logger: MinimalLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (...args: unknown[]) => warnings.push(JSON.stringify(args)),
      error: () => undefined,
    };
    // Most cases publish from the first segment; the start threshold has its own tests.
    return new LiveMirror({
      streamId: STREAM,
      dir,
      storage,
      logger,
      startSegments: 1,
      ...options,
    });
  }

  /** Write what FFmpeg would: the named files, then the playlist listing `listed`. */
  async function ffmpegWrites(files: string[], listed: string[], ended = false): Promise<void> {
    for (const file of files) await writeFile(path.join(dir, file), `bytes of ${file}`);
    await writeFile(path.join(dir, 'live.m3u8'), playlist(listed, ended));
  }

  const stored = async () => (await readdir(path.join(storageRoot, 'live', STREAM))).sort();
  const storedPlaylist = () =>
    readFile(path.join(storageRoot, 'live', STREAM, 'live.m3u8'), 'utf8');

  it('waits for FFmpeg to write a playlist', async () => {
    await mirror().sync(false);
    expect(ops).toEqual([]);
  });

  it('stores newly listed segments before the playlist that lists them, each once', async () => {
    const m = mirror();
    await ffmpegWrites(['init.mp4', 'seg_00000.m4s'], ['seg_00000.m4s']);
    await m.sync(false);
    await ffmpegWrites(['seg_00001.m4s'], ['seg_00000.m4s', 'seg_00001.m4s']);
    await m.sync(false);
    await m.sync(false); // unchanged: nothing to do
    expect(ops).toEqual([
      `putFile live/${STREAM}/init.mp4`,
      `putFile live/${STREAM}/seg_00000.m4s`,
      `put live/${STREAM}/live.m3u8`,
      `putFile live/${STREAM}/seg_00001.m4s`,
      `put live/${STREAM}/live.m3u8`,
    ]);
    expect(await storedPlaylist()).toBe(playlist(['seg_00000.m4s', 'seg_00001.m4s']));
  });

  it('holds the first playlist back until players can start behind the live edge', async () => {
    const m = mirror({ startSegments: 3 });
    await ffmpegWrites(
      ['init.mp4', 'seg_00000.m4s', 'seg_00001.m4s'],
      ['seg_00000.m4s', 'seg_00001.m4s'],
    );
    await m.sync(false);
    expect(ops).toEqual([]);

    await ffmpegWrites(['seg_00002.m4s'], ['seg_00000.m4s', 'seg_00001.m4s', 'seg_00002.m4s']);
    await m.sync(false);
    expect(ops).toHaveLength(5); // init, three segments, then the playlist
    expect(ops.at(-1)).toBe(`put live/${STREAM}/live.m3u8`);
  });

  it('publishes a stream too short to reach that threshold once it ends', async () => {
    const m = mirror({ startSegments: 3 });
    await ffmpegWrites(['init.mp4', 'seg_00000.m4s'], ['seg_00000.m4s']);
    await m.sync(false);
    expect(ops).toEqual([]);
    await m.finish();
    expect(await storedPlaylist()).toBe(playlist(['seg_00000.m4s'], true));
  });

  it('keeps a segment that left the window for the retention period, then deletes it', async () => {
    const m = mirror({ retainRemovedMs: 300 });
    await ffmpegWrites(
      ['init.mp4', 'seg_00000.m4s', 'seg_00001.m4s'],
      ['seg_00000.m4s', 'seg_00001.m4s'],
    );
    await m.sync(false);
    await ffmpegWrites(['seg_00002.m4s'], ['seg_00001.m4s', 'seg_00002.m4s']);
    await m.sync(false);
    expect(await stored()).toContain('seg_00000.m4s'); // a player may still want it

    await new Promise((resolve) => setTimeout(resolve, 350));
    await m.sync(false);
    expect(await stored()).toEqual(['init.mp4', 'live.m3u8', 'seg_00001.m4s', 'seg_00002.m4s']);
  });

  it('at the end, marks the playlist ended and keeps only its window', async () => {
    const m = mirror({ retainRemovedMs: 60_000 });
    await ffmpegWrites(
      ['init.mp4', 'seg_00000.m4s', 'seg_00001.m4s'],
      ['seg_00000.m4s', 'seg_00001.m4s'],
    );
    await m.sync(false);
    // FFmpeg died before writing its own end: no ENDLIST.
    await ffmpegWrites(['seg_00002.m4s'], ['seg_00001.m4s', 'seg_00002.m4s']);
    await m.finish();
    expect(await storedPlaylist()).toBe(playlist(['seg_00001.m4s', 'seg_00002.m4s'], true));
    expect(await stored()).toEqual(['init.mp4', 'live.m3u8', 'seg_00001.m4s', 'seg_00002.m4s']);
  });

  it('skips a segment FFmpeg already deleted instead of stalling', async () => {
    const m = mirror();
    await ffmpegWrites(['init.mp4', 'seg_00001.m4s'], ['seg_00000.m4s', 'seg_00001.m4s']);
    await m.sync(false);
    expect(warnings.join()).toContain('seg_00000.m4s');
    expect(await stored()).toEqual(['init.mp4', 'live.m3u8', 'seg_00001.m4s']);
  });

  it('refuses a playlist that names a file outside its work dir', async () => {
    await ffmpegWrites(['init.mp4'], ['../../secret.m4s']);
    await expect(mirror().sync(false)).rejects.toThrow(/unexpected file/);
    expect(ops).toEqual([`putFile live/${STREAM}/init.mp4`]);
  });
});
