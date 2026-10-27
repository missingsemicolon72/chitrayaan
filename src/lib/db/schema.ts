import type {
  Codec,
  JobStatus,
  JobType,
  LiveEndReason,
  LiveStreamStatus,
  VideoStatus,
} from './types.js';

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
  thumbnailTrackKey: string | null;
  thumbnailSpriteCount: number | null;
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

export interface SubtitlesTable {
  id: string;
  videoId: string;
  language: string;
  label: string;
  storageKey: string;
  /** 0/1 rather than a boolean, so the same column type works on SQLite and Postgres. */
  isDefault: number;
  cueCount: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface LiveStreamsTable {
  id: string;
  status: LiveStreamStatus;
  /** 1 while waiting or live, NULL once ended (see the 0005 migration). */
  active: number | null;
  endReason: LiveEndReason | null;
  stopRequestedAt: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  cleanupAfter: string | null;
  cleanedAt: string | null;
  updatedAt: string;
}

export interface LiveIngestTable {
  id: string;
  state: string;
  error: string | null;
  reportedAt: string;
}

export interface DatabaseSchema {
  videos: VideosTable;
  jobs: JobsTable;
  renditions: RenditionsTable;
  subtitles: SubtitlesTable;
  liveStreams: LiveStreamsTable;
  liveIngest: LiveIngestTable;
}
