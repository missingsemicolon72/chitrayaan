import { describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../../src/lib/db/index.js';
import { describeDatabaseContract } from '../contracts/db.contract.js';
import { postgresAvailable, TEST_DATABASE_URL } from '../helpers/cloud.js';

const POSTGRES = await postgresAvailable();

function connect(): Promise<Database> {
  return createDatabase({
    DB_BACKEND: 'postgres',
    SQLITE_PATH: ':memory:',
    DATABASE_URL: TEST_DATABASE_URL,
  });
}

/** Videos cascade to jobs, renditions and subtitles, so this empties the whole schema. */
async function clear(db: Database): Promise<void> {
  for (;;) {
    const page = await db.videos.list({ limit: 200 });
    if (page.items.length === 0) return;
    for (const video of page.items) await db.videos.delete(video.id);
  }
}

/**
 * The same contract SQLite passes, against Postgres: this is what "parity with local mode"
 * means in practice. Skipped when no Postgres is running.
 */
describe.skipIf(!POSTGRES)('postgres parity', () => {
  describeDatabaseContract('postgres', async () => {
    const db = await connect();
    await db.migrate();
    await clear(db);
    return { db, teardown: () => db.close() };
  });

  describe('Postgres driver specifics', () => {
    it('reports its backend and survives a round trip through a second connection', async () => {
      const first = await connect();
      const second = await connect();
      try {
        await first.migrate();
        expect(first.backend).toBe('postgres');
        await clear(first);

        const video = await first.videos.create({ title: 'shared', sizeBytes: 3_000_000_000 });
        // A separate pool (standing in for the worker process) sees the same row.
        const seen = await second.videos.get(video.id);
        expect(seen?.title).toBe('shared');
        // bigint columns come back as strings from pg; the repository normalises them.
        expect(seen?.sizeBytes).toBe(3_000_000_000);
        expect(typeof seen?.sizeBytes).toBe('number');

        await second.videos.update(video.id, { status: 'ready', durationSeconds: 30.526667 });
        const updated = await first.videos.get(video.id);
        expect(updated?.status).toBe('ready');
        // `double precision` keeps the duration exactly; Postgres `real` would have rounded it.
        expect(updated?.durationSeconds).toBe(30.526667);
      } finally {
        await first.close();
        await second.close();
      }
    });

    it('counts and paginates with the same types as SQLite', async () => {
      const db = await connect();
      try {
        await db.migrate();
        await clear(db);
        for (let i = 0; i < 3; i += 1) await db.videos.create({ status: 'ready' });

        const page = await db.videos.list({ limit: 2 });
        expect(page.total).toBe(3);
        expect(typeof page.total).toBe('number');
        expect(page.items).toHaveLength(2);
      } finally {
        await db.close();
      }
    });

    it('rejects a query after close', async () => {
      const db = await connect();
      await db.migrate();
      await db.close();
      await expect(db.ping()).rejects.toThrow();
    });
  });
});
