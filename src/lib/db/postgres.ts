import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { DatabaseSchema } from './schema.js';

/**
 * Postgres driver, paired with S3 storage for cloud mode (decision #7). It shares every
 * repository with SQLite: only the dialect differs, and the shared database contract suite
 * proves the two behave identically.
 *
 * `pg` returns `bigint` and `count` as strings to avoid losing precision; the repositories
 * already normalise those to numbers, which is what keeps the two backends in step.
 */
export function createPostgresKysely(connectionString: string): Kysely<DatabaseSchema> {
  const pool = new pg.Pool({
    connectionString,
    // The API and each worker open their own pool; a small one is plenty for this workload.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}
