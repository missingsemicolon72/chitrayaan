import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InvalidStorageKeyError,
  StorageNotFoundError,
  type ObjectStorage,
} from '../../src/lib/storage/index.js';

export interface StorageFixture {
  storage: ObjectStorage;
  teardown: () => Promise<void>;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Behavioural contract every `ObjectStorage` driver must satisfy. Milestone 11 runs this same
 * suite against the S3 driver, which is how "parity with local mode" gets verified.
 * `setup` must return an empty, isolated store for each test.
 */
export function describeStorageContract(name: string, setup: () => Promise<StorageFixture>): void {
  describe(`ObjectStorage contract: ${name}`, () => {
    let storage: ObjectStorage;
    let teardown: () => Promise<void>;
    let scratch: string;

    beforeEach(async () => {
      ({ storage, teardown } = await setup());
      scratch = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-scratch-'));
    });

    afterEach(async () => {
      await teardown();
      await rm(scratch, { recursive: true, force: true });
    });

    it('round-trips a Buffer, a string and a stream', async () => {
      await storage.put('a/buffer.bin', Buffer.from('buffer-bytes'));
      await storage.put('a/string.txt', 'string-bytes');
      await storage.put('a/stream.txt', Readable.from(['stream-', 'bytes']));

      expect(await readAll(await storage.get('a/buffer.bin'))).toBe('buffer-bytes');
      expect(await readAll(await storage.get('a/string.txt'))).toBe('string-bytes');
      expect(await readAll(await storage.get('a/stream.txt'))).toBe('stream-bytes');
    });

    it('overwrites an existing object', async () => {
      await storage.put('k.txt', 'first');
      await storage.put('k.txt', 'second, longer');
      expect(await readAll(await storage.get('k.txt'))).toBe('second, longer');
      expect((await storage.stat('k.txt'))?.size).toBe('second, longer'.length);
    });

    it('reports stat/exists, and null/false for missing keys', async () => {
      const before = Date.now() - 5000;
      await storage.put('videos/v1/seg.m4s', Buffer.alloc(1234, 1));

      const info = await storage.stat('videos/v1/seg.m4s');
      expect(info).not.toBeNull();
      expect(info?.key).toBe('videos/v1/seg.m4s');
      expect(info?.size).toBe(1234);
      expect(info?.lastModified.getTime()).toBeGreaterThanOrEqual(before);
      expect(await storage.exists('videos/v1/seg.m4s')).toBe(true);

      expect(await storage.stat('videos/v1/missing.m4s')).toBeNull();
      expect(await storage.exists('videos/v1/missing.m4s')).toBe(false);
      // A directory-like key is not an object either.
      expect(await storage.stat('videos/v1')).toBeNull();
    });

    it('rejects get/download of a missing key with StorageNotFoundError', async () => {
      await expect(storage.get('nope.txt')).rejects.toBeInstanceOf(StorageNotFoundError);
      await expect(storage.downloadToFile('nope.txt', path.join(scratch, 'x'))).rejects.toThrow(
        StorageNotFoundError,
      );
    });

    it('putFile and downloadToFile move bytes between local files and storage', async () => {
      const src = path.join(scratch, 'source.bin');
      await writeFile(src, Buffer.from('from-a-local-file'));
      await storage.putFile('uploads/u1/source.bin', src);
      expect(await readAll(await storage.get('uploads/u1/source.bin'))).toBe('from-a-local-file');

      const dest = path.join(scratch, 'nested', 'dir', 'copy.bin');
      await storage.downloadToFile('uploads/u1/source.bin', dest);
      expect(await readFile(dest, 'utf8')).toBe('from-a-local-file');
    });

    it('delete removes the object and is idempotent', async () => {
      await storage.put('d.txt', 'x');
      await storage.delete('d.txt');
      expect(await storage.exists('d.txt')).toBe(false);
      await expect(storage.delete('d.txt')).resolves.toBeUndefined();
    });

    it('lists by string prefix, sorted by key, with sizes', async () => {
      await storage.put('videos/abc/master.m3u8', '#EXTM3U');
      await storage.put('videos/abc/h264_720p/seg_001.m4s', Buffer.alloc(10));
      await storage.put('videos/abc/h264_720p/seg_002.m4s', Buffer.alloc(20));
      await storage.put('videos/abcd/master.m3u8', '#EXTM3U');
      await storage.put('other/file.txt', 'x');

      const under = await storage.list('videos/abc/');
      expect(under.map((o) => o.key)).toEqual([
        'videos/abc/h264_720p/seg_001.m4s',
        'videos/abc/h264_720p/seg_002.m4s',
        'videos/abc/master.m3u8',
      ]);
      expect(under.map((o) => o.size)).toEqual([10, 20, 7]);

      // Plain string-prefix semantics: no implicit directory boundary.
      expect((await storage.list('videos/abc')).map((o) => o.key)).toEqual([
        'videos/abc/h264_720p/seg_001.m4s',
        'videos/abc/h264_720p/seg_002.m4s',
        'videos/abc/master.m3u8',
        'videos/abcd/master.m3u8',
      ]);
      expect((await storage.list('videos/abc/h264_720p/seg_002')).map((o) => o.key)).toEqual([
        'videos/abc/h264_720p/seg_002.m4s',
      ]);
      expect((await storage.list('')).length).toBe(5);
      expect(await storage.list('videos/zzz/')).toEqual([]);
    });

    it('deletePrefix removes only matching objects and returns the count', async () => {
      await storage.put('videos/v1/a.m4s', 'a');
      await storage.put('videos/v1/r/b.m4s', 'b');
      await storage.put('videos/v10/c.m4s', 'c');
      await storage.put('videos/v2/d.m4s', 'd');

      expect(await storage.deletePrefix('videos/v1/')).toBe(2);
      expect((await storage.list('videos/')).map((o) => o.key)).toEqual([
        'videos/v10/c.m4s',
        'videos/v2/d.m4s',
      ]);
      expect(await storage.deletePrefix('videos/v1/')).toBe(0);
    });

    it('rejects unsafe or malformed keys', async () => {
      const bad = [
        '',
        '/abs/path.txt',
        'trailing/',
        'a//b.txt',
        '../escape.txt',
        'a/../../escape.txt',
        'a/./b.txt',
        'back\\slash.txt',
        'sp ace.txt',
        'tilde~.txt',
        'q?.txt',
      ];
      for (const key of bad) {
        await expect(storage.put(key, 'x'), key).rejects.toBeInstanceOf(InvalidStorageKeyError);
        await expect(storage.get(key), key).rejects.toBeInstanceOf(InvalidStorageKeyError);
        await expect(storage.stat(key), key).rejects.toBeInstanceOf(InvalidStorageKeyError);
        await expect(storage.delete(key), key).rejects.toBeInstanceOf(InvalidStorageKeyError);
      }
      await expect(storage.list('/abs')).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.list('a/../b')).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.list('a//b')).rejects.toBeInstanceOf(InvalidStorageKeyError);
    });

    it('handles concurrent writes to distinct keys', async () => {
      const keys = Array.from(
        { length: 25 },
        (_, i) => `bulk/seg_${String(i).padStart(3, '0')}.m4s`,
      );
      await Promise.all(keys.map((key, i) => storage.put(key, Buffer.alloc(i + 1, i))));
      const listed = await storage.list('bulk/');
      expect(listed.map((o) => o.key)).toEqual(keys);
      expect(listed.map((o) => o.size)).toEqual(keys.map((_, i) => i + 1));
    });
  });
}
