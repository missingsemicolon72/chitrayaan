import type { Database, Job, Video } from '../lib/db/index.js';
import type { Logger } from '../lib/logger.js';
import type { ObjectStorage } from '../lib/storage/index.js';

export interface ProcessorContext {
  job: Job;
  video: Video;
  db: Database;
  storage: ObjectStorage;
  log: Logger;
  /** 0-100. Persisted to the database and BullMQ; repeated values are cheap no-ops. */
  reportProgress: (percent: number) => Promise<void>;
}

/**
 * The work done for one transcode job. The runner around it owns every status transition
 * (job active/completed/failed, video processing/ready/failed), so a processor only does the
 * media work and throws on failure. Milestone 5 replaces the placeholder with FFmpeg.
 */
export type TranscodeProcessor = (ctx: ProcessorContext) => Promise<void>;
