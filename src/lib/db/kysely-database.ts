import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';

import { migrationProvider } from './migrations.js';
import type { DatabaseSchema, JobsTable, RenditionsTable, VideosTable } from './schema.js';
import {
  DbError,
  RecordNotFoundError,
  type Database,
  type DbBackend,
  type Job,
  type JobListOptions,
  type JobPatch,
  type JobRepository,
  type NewJob,
  type NewRendition,
  type NewVideo,
  type Page,
  type Rendition,
  type RenditionRepository,
  type Video,
  type VideoListOptions,
  type VideoPatch,
  type VideoRepository,
} from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function nowIso(): string {
  return new Date().toISOString();
}

function clampPage(limit: number | undefined, offset: number | undefined) {
  return {
    limit: Math.min(Math.max(Math.trunc(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT),
    offset: Math.max(Math.trunc(offset ?? 0), 0),
  };
}

/** Drop `undefined` entries so a patch never overwrites a column with NULL by accident. */
function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function toVideo(row: VideosTable): Video {
  return {
    ...row,
    // Postgres returns bigint columns as strings; SQLite returns numbers. Normalize.
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
  };
}

function toJob(row: JobsTable): Job {
  return { ...row, progress: Number(row.progress), attempts: Number(row.attempts) };
}

function toRendition(row: RenditionsTable): Rendition {
  return {
    ...row,
    width: Number(row.width),
    height: Number(row.height),
    videoBitrateKbps: Number(row.videoBitrateKbps),
    audioBitrateKbps: row.audioBitrateKbps === null ? null : Number(row.audioBitrateKbps),
    segmentCount: Number(row.segmentCount),
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
  };
}

class KyselyRenditionRepository implements RenditionRepository {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async listForVideo(videoId: string): Promise<Rendition[]> {
    const rows = await this.db
      .selectFrom('renditions')
      .selectAll()
      .where('videoId', '=', videoId)
      .orderBy('height', 'asc')
      .orderBy('name', 'asc')
      .execute();
    return rows.map(toRendition);
  }

  async replaceForVideo(videoId: string, renditions: NewRendition[]): Promise<Rendition[]> {
    const now = nowIso();
    const rows: RenditionsTable[] = renditions.map((r) => ({
      ...r,
      id: randomUUID(),
      videoId,
      createdAt: now,
    }));
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('renditions').where('videoId', '=', videoId).execute();
      if (rows.length > 0) await trx.insertInto('renditions').values(rows).execute();
    });
    return this.listForVideo(videoId);
  }
}

class KyselyVideoRepository implements VideoRepository {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async create(input: NewVideo): Promise<Video> {
    const now = nowIso();
    const row: VideosTable = {
      id: input.id ?? randomUUID(),
      title: input.title ?? null,
      originalFilename: input.originalFilename ?? null,
      sourceKey: input.sourceKey ?? null,
      sizeBytes: input.sizeBytes ?? null,
      status: input.status ?? 'uploading',
      durationSeconds: null,
      width: null,
      height: null,
      error: null,
      hlsManifestKey: null,
      dashManifestKey: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insertInto('videos').values(row).execute();
    return toVideo(row);
  }

  async get(id: string): Promise<Video | null> {
    const row = await this.db
      .selectFrom('videos')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toVideo(row) : null;
  }

  async list(options: VideoListOptions = {}): Promise<Page<Video>> {
    const { limit, offset } = clampPage(options.limit, options.offset);
    let query = this.db.selectFrom('videos');
    if (options.status) query = query.where('status', '=', options.status);

    const [rows, count] = await Promise.all([
      query
        .selectAll()
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .offset(offset)
        .execute(),
      query.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
    ]);
    return { items: rows.map(toVideo), total: Number(count.count), limit, offset };
  }

  async update(id: string, patch: VideoPatch): Promise<Video | null> {
    const changes = definedOnly(patch);
    if (Object.keys(changes).length > 0) {
      await this.db
        .updateTable('videos')
        .set({ ...changes, updatedAt: nowIso() })
        .where('id', '=', id)
        .execute();
    }
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('videos').where('id', '=', id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}

class KyselyJobRepository implements JobRepository {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async create(input: NewJob): Promise<Job> {
    const video = await this.db
      .selectFrom('videos')
      .select('id')
      .where('id', '=', input.videoId)
      .executeTakeFirst();
    if (!video) throw new RecordNotFoundError('video', input.videoId);

    const now = nowIso();
    const row: JobsTable = {
      id: input.id ?? randomUUID(),
      videoId: input.videoId,
      type: input.type ?? 'transcode',
      status: input.status ?? 'queued',
      progress: 0,
      attempts: 0,
      queueJobId: input.queueJobId ?? null,
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    };
    await this.db.insertInto('jobs').values(row).execute();
    return toJob(row);
  }

  async get(id: string): Promise<Job | null> {
    const row = await this.db
      .selectFrom('jobs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toJob(row) : null;
  }

  async list(options: JobListOptions = {}): Promise<Page<Job>> {
    const { limit, offset } = clampPage(options.limit, options.offset);
    let query = this.db.selectFrom('jobs');
    if (options.videoId) query = query.where('videoId', '=', options.videoId);
    if (options.status) query = query.where('status', '=', options.status);

    const [rows, count] = await Promise.all([
      query
        .selectAll()
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .offset(offset)
        .execute(),
      query.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
    ]);
    return { items: rows.map(toJob), total: Number(count.count), limit, offset };
  }

  async update(id: string, patch: JobPatch): Promise<Job | null> {
    const changes = definedOnly(patch);
    if (Object.keys(changes).length > 0) {
      await this.db
        .updateTable('jobs')
        .set({ ...changes, updatedAt: nowIso() })
        .where('id', '=', id)
        .execute();
    }
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('jobs').where('id', '=', id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}

/** `Database` implementation shared by every backend; only the Kysely dialect differs. */
export class KyselyDatabase implements Database {
  readonly videos: VideoRepository;
  readonly jobs: JobRepository;
  readonly renditions: RenditionRepository;

  constructor(
    readonly backend: DbBackend,
    private readonly db: Kysely<DatabaseSchema>,
  ) {
    this.videos = new KyselyVideoRepository(db);
    this.jobs = new KyselyJobRepository(db);
    this.renditions = new KyselyRenditionRepository(db);
  }

  async migrate(): Promise<void> {
    const migrator = new Migrator({ db: this.db, provider: migrationProvider });
    const { error, results } = await migrator.migrateToLatest();
    if (error) {
      const failed = results?.find((r) => r.status === 'Error')?.migrationName ?? 'unknown';
      throw new DbError(`Migration "${failed}" failed`, { cause: error });
    }
  }

  async ping(): Promise<void> {
    await sql`select 1`.execute(this.db);
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}
