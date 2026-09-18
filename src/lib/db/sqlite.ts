import { mkdirSync } from 'node:fs';
import path from 'node:path';

import SQLite from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';

import type { DatabaseSchema } from './schema.js';

/**
 * SQLite driver. The API and the worker are separate processes sharing one file, so the
 * connection is configured for that: WAL mode lets readers proceed while the other process
 * writes, and `busy_timeout` makes writers wait instead of failing with SQLITE_BUSY.
 *
 * `:memory:` is accepted for tests (each connection gets its own private database).
 */
export function createSqliteKysely(sqlitePath: string): Kysely<DatabaseSchema> {
  const isMemory = sqlitePath === ':memory:';
  const file = isMemory ? sqlitePath : path.resolve(sqlitePath);
  if (!isMemory) mkdirSync(path.dirname(file), { recursive: true });

  const sqlite = new SQLite(file);
  if (!isMemory) sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');

  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: sqlite }),
    plugins: [new CamelCasePlugin()],
  });
}
