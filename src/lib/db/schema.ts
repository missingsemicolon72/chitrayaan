import type { Codec, JobStatus, JobType, VideoStatus } from './types.js';

/**
 * Kysely table types. Property names are camelCase; `CamelCasePlugin` maps them to the
 * snake_case column names created in `migrations.ts`.
 */
export interface VideosTable {
  id: string;
  title: string | null;
  originalFilename: string | null;
  sourceKey: string | null;
  sizeBytes: number | null;
  status: VideoStatus;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  error: string | null;
  hlsManifestKey: string | null;
  dashManifestKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobsTable {
  id: string;
  videoId: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  attempts: number;
  queueJobId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface RenditionsTable {
  id: string;
  videoId: string;
  name: string;
  codec: Codec;
  width: number;
  height: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number | null;
  playlistKey: string;
  segmentCount: number;
  sizeBytes: number | null;
  durationSeconds: number | null;
  createdAt: string;
}

export interface DatabaseSchema {
  videos: VideosTable;
  jobs: JobsTable;
  renditions: RenditionsTable;
}
