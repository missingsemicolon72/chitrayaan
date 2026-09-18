import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createStorage, LocalDiskStorage } from '../../src/lib/storage/index.js';
import { describeStorageContract } from '../contracts/storage.contract.js';

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'chitrayaan-storage-'));
}

describeStorageContract('local disk', async () => {
  const root = await tempRoot();
  const storage = await LocalDiskStorage.create(root);
  return { storage, teardown: () => rm(root, { recursive: true, force: true }) };
});

describe('LocalDiskStorage specifics', () => {
  it('maps keys onto paths under the root and creates the root on demand', async () => {
    const parent = await tempRoot();
    try {
      const root = path.join(parent, 'nested', 'store');
      const storage = await LocalDiskStorage.create(root);
      expect((await stat(root)).isDirectory()).toBe(true);
      expect(storage.pathFor('videos/v1/seg.m4s')).toBe(path.join(root, 'videos', 'v1', 'seg.m4s'));

      await storage.put('videos/v1/seg.m4s', 'bytes');
      expect((await stat(path.join(root, 'videos', 'v1', 'seg.m4s'))).size).toBe(5);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('leaves no temp files behind after writes', async () => {
    const root = await tempRoot();
    try {
      const storage = await LocalDiskStorage.create(root);
      await storage.put('a/one.txt', 'one');
      await storage.put('a/one.txt', 'one again');
      await storage.putFile('a/two.txt', storage.pathFor('a/one.txt'));
      expect((await readdir(path.join(root, 'a'))).sort()).toEqual(['one.txt', 'two.txt']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cleans up a failed stream write', async () => {
    const root = await tempRoot();
    try {
      const storage = await LocalDiskStorage.create(root);
      const { Readable } = await import('node:stream');
      const failing = new Readable({
        read() {
          this.push('partial');
          this.destroy(new Error('upstream broke'));
        },
      });
      await expect(storage.put('broken.bin', failing)).rejects.toThrow('upstream broke');
      expect(await storage.exists('broken.bin')).toBe(false);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deletePrefix prunes emptied directories', async () => {
    const root = await tempRoot();
    try {
      const storage = await LocalDiskStorage.create(root);
      await storage.put('videos/v1/r1/seg.m4s', 'x');
      await storage.put('videos/v2/seg.m4s', 'y');
      await storage.deletePrefix('videos/v1/');
      expect(await readdir(path.join(root, 'videos'))).toEqual(['v2']);
      expect(await storage.exists('videos/v2/seg.m4s')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('createStorage picks the local driver and refuses s3 for now', async () => {
    const root = await tempRoot();
    try {
      const storage = await createStorage({ STORAGE_BACKEND: 'local', LOCAL_STORAGE_PATH: root });
      expect(storage.backend).toBe('local');
      await expect(
        createStorage({ STORAGE_BACKEND: 's3', LOCAL_STORAGE_PATH: root }),
      ).rejects.toThrow(/Milestone 11/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
