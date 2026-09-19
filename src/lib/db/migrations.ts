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

  '0002_renditions': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('renditions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('video_id', 'text', (c) =>
          c.notNull().references('videos.id').onDelete('cascade'),
        )
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('codec', 'text', (c) => c.notNull())
        .addColumn('width', 'integer', (c) => c.notNull())
        .addColumn('height', 'integer', (c) => c.notNull())
        .addColumn('video_bitrate_kbps', 'integer', (c) => c.notNull())
        .addColumn('audio_bitrate_kbps', 'integer')
        .addColumn('playlist_key', 'text', (c) => c.notNull())
        .addColumn('segment_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('size_bytes', 'bigint')
        .addColumn('duration_seconds', 'real')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addUniqueConstraint('renditions_video_id_name_unique', ['video_id', 'name'])
        .execute();
      await db.schema
        .createIndex('renditions_video_id_idx')
        .on('renditions')
        .column('video_id')
        .execute();
    },
    async down(db: Kysely<unknown>) {
      await db.schema.dropTable('renditions').execute();
    },
  },

  '0003_video_manifests': {
    async up(db: Kysely<unknown>) {
      await db.schema.alterTable('videos').addColumn('hls_manifest_key', 'text').execute();
      await db.schema.alterTable('videos').addColumn('dash_manifest_key', 'text').execute();
    },
    async down(db: Kysely<unknown>) {
      await db.schema.alterTable('videos').dropColumn('dash_manifest_key').execute();
      await db.schema.alterTable('videos').dropColumn('hls_manifest_key').execute();
    },
  },

  '0004_optional_features': {
    async up(db: Kysely<unknown>) {
      await db.schema.alterTable('videos').addColumn('thumbnail_track_key', 'text').execute();
      await db.schema.alterTable('videos').addColumn('thumbnail_sprite_count', 'integer').execute();

      await db.schema
        .createTable('subtitles')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('video_id', 'text', (c) =>
          c.notNull().references('videos.id').onDelete('cascade'),
        )
        .addColumn('language', 'text', (c) => c.notNull())
        .addColumn('label', 'text', (c) => c.notNull())
        .addColumn('storage_key', 'text', (c) => c.notNull())
        .addColumn('is_default', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('cue_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('size_bytes', 'bigint', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addUniqueConstraint('subtitles_video_id_language_unique', ['video_id', 'language'])
        .execute();
      await db.schema
        .createIndex('subtitles_video_id_idx')
        .on('subtitles')
        .column('video_id')
        .execute();
    },
    async down(db: Kysely<unknown>) {
      await db.schema.dropTable('subtitles').execute();
      await db.schema.alterTable('videos').dropColumn('thumbnail_sprite_count').execute();
      await db.schema.alterTable('videos').dropColumn('thumbnail_track_key').execute();
    },
  },
};

export const migrationProvider: MigrationProvider = {
  getMigrations: () => Promise.resolve(migrations),
};
