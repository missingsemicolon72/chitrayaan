import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import SQLite from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/lib/db/index.js';
import { describeDatabaseContract } from '../contracts/db.contract.js';

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'chitrayaan-sqlite-'));
}

describeDatabaseContract('sqlite (file)', async () => {
  const dir = await tempDir();
  const db = await createDatabase({
    DB_BACKEND: 'sqlite',
    SQLITE_PATH: path.join(dir, 'db.sqlite'),
  });
  await db.migrate();
  return {
    db,
    teardown: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
});

describeDatabaseContract('sqlite (:memory:)', async () => {
  const db = await createDatabase({ DB_BACKEND: 'sqlite', SQLITE_PATH: ':memory:' });
  await db.migrate();
  return { db, teardown: () => db.close() };
});

describe('SQLite driver specifics', () => {
  it('creates the parent directory, enables WAL, and is shareable by a second process', async () => {
    const dir = await tempDir();
    try {
      const file = path.join(dir, 'deep', 'er', 'meta.sqlite');
      const api = await createDatabase({ DB_BACKEND: 'sqlite', SQLITE_PATH: file });
      await api.migrate();
      const video = await api.videos.create({ title: 'shared' });

      // A second connection (standing in for the worker process) sees the same data and
      // does not need to migrate again.
      const worker = await createDatabase({ DB_BACKEND: 'sqlite', SQLITE_PATH: file });
      await worker.migrate();
      expect((await worker.videos.get(video.id))?.title).toBe('shared');
      await worker.videos.update(video.id, { status: 'ready' });
      expect((await api.videos.get(video.id))?.status).toBe('ready');

      // WAL is persisted in the file header, so any later opener inherits it.
      const raw = new SQLite(file, { readonly: true });
      expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
      raw.close();

      await worker.close();
      await api.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses postgres for now', async () => {
    await expect(
      createDatabase({ DB_BACKEND: 'postgres', SQLITE_PATH: ':memory:' }),
    ).rejects.toThrow(/Milestone 11/);
  });

  it('rejects ping after close', async () => {
    const db = await createDatabase({ DB_BACKEND: 'sqlite', SQLITE_PATH: ':memory:' });
    await db.migrate();
    await db.close();
    await expect(db.ping()).rejects.toThrow();
  });
});
