import type { Kysely } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely/migration';

/**
 * Schema migrations, written once with Kysely's dialect-agnostic schema builder so the same
 * list runs on SQLite (Milestone 2) and Postgres (Milestone 11). Column names are snake_case
 * here; application code sees them as camelCase via `CamelCasePlugin`.
 *
 * Timestamps are ISO 8601 UTC strings in TEXT columns on every backend: portable, sortable,
 * and free of timezone surprises between drivers.
 *
 * Keys are applied in lexicographic order, so keep the numeric prefix zero-padded.
 */
const migrations: Record<string, Migration> = {
  '0001_initial': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('videos')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('title', 'text')
        .addColumn('original_filename', 'text')
        .addColumn('source_key', 'text')
        .addColumn('size_bytes', 'bigint')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('duration_seconds', 'real')
        .addColumn('width', 'integer')
        .addColumn('height', 'integer')
        .addColumn('error', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('videos_status_created_at_idx')
        .on('videos')
        .columns(['status', 'created_at'])
        .execute();

      await db.schema
        .createTable('jobs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('video_id', 'text', (c) =>
          c.notNull().references('videos.id').onDelete('cascade'),
        )
        .addColumn('type', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('progress', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('queue_job_id', 'text')
        .addColumn('error', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('started_at', 'text')
        .addColumn('finished_at', 'text')
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('jobs_video_id_idx').on('jobs').column('video_id').execute();
      await db.schema
        .createIndex('jobs_status_created_at_idx')
        .on('jobs')
        .columns(['status', 'created_at'])
        .execute();
    },
    async down(db: Kysely<unknown>) {
      await db.schema.dropTable('jobs').execute();
      await db.schema.dropTable('videos').execute();
    },
  },
};

export const migrationProvider: MigrationProvider = {
  getMigrations: () => Promise.resolve(migrations),
};
