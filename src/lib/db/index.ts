import type { AppConfig } from '../../config/index.js';
import { KyselyDatabase } from './kysely-database.js';
import { createSqliteKysely } from './sqlite.js';
import type { Database } from './types.js';

export { KyselyDatabase } from './kysely-database.js';
export {
  CODECS,
  DbError,
  RecordNotFoundError,
  JOB_STATUSES,
  JOB_TYPES,
  VIDEO_STATUSES,
  type Codec,
  type Database,
  type DbBackend,
  type Job,
  type JobListOptions,
  type JobPatch,
  type JobRepository,
  type JobStatus,
  type JobType,
  type ListOptions,
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
  type VideoStatus,
} from './types.js';

export type DatabaseConfig = Pick<AppConfig, 'DB_BACKEND' | 'SQLITE_PATH'>;

/** Open the database selected by `DB_BACKEND`. Call `migrate()` before use. */
export async function createDatabase(config: DatabaseConfig): Promise<Database> {
  switch (config.DB_BACKEND) {
    case 'sqlite':
      return Promise.resolve(new KyselyDatabase('sqlite', createSqliteKysely(config.SQLITE_PATH)));
    case 'postgres':
      throw new Error('DB_BACKEND=postgres is not available yet (planned for Milestone 11)');
  }
}
