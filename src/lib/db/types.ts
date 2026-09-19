export type DbBackend = 'sqlite' | 'postgres';

export const VIDEO_STATUSES = ['uploading', 'uploaded', 'processing', 'ready', 'failed'] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export const JOB_TYPES = ['transcode'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['queued', 'active', 'completed', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Decision #10/#11: H.264 always, AV1 opt-in, HEVC never. */
export const CODECS = ['h264', 'av1'] as const;
export type Codec = (typeof CODECS)[number];

/** A video asset: one uploaded source file and everything derived from it. */
export interface Video {
  id: string;
  title: string | null;
  originalFilename: string | null;
  /** Storage key of the uploaded source file; null until the upload completes. */
  sourceKey: string | null;
  sizeBytes: number | null;
  status: VideoStatus;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  error: string | null;
  /** Storage keys of the packaged manifests; set when a transcode completes. */
  hlsManifestKey: string | null;
  dashManifestKey: string | null;
  /** Storage key of the WebVTT scrubbing-thumbnail track (FEATURE_THUMBNAILS). */
  thumbnailTrackKey: string | null;
  thumbnailSpriteCount: number | null;
  /** ISO 8601 UTC timestamps. */
  createdAt: string;
  updatedAt: string;
}

export interface NewVideo {
  id?: string;
  title?: string | null;
  originalFilename?: string | null;
  sourceKey?: string | null;
  sizeBytes?: number | null;
  /** Defaults to `uploading`. */
  status?: VideoStatus;
}

export type VideoPatch = Partial<
  Pick<
    Video,
    | 'title'
    | 'originalFilename'
    | 'sourceKey'
    | 'sizeBytes'
    | 'status'
    | 'durationSeconds'
    | 'width'
    | 'height'
    | 'error'
    | 'hlsManifestKey'
    | 'dashManifestKey'
    | 'thumbnailTrackKey'
    | 'thumbnailSpriteCount'
  >
>;

/** Durable record of a processing job. The live queue state lives in BullMQ (Milestone 4). */
export interface Job {
  id: string;
  videoId: string;
  type: JobType;
  status: JobStatus;
  /** 0-100. */
  progress: number;
  attempts: number;
  /** BullMQ job id once enqueued. */
  queueJobId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface NewJob {
  id?: string;
  videoId: string;
  /** Defaults to `transcode`. */
  type?: JobType;
  /** Defaults to `queued`. */
  status?: JobStatus;
  queueJobId?: string | null;
}

export type JobPatch = Partial<
  Pick<
    Job,
    'status' | 'progress' | 'attempts' | 'queueJobId' | 'error' | 'startedAt' | 'finishedAt'
  >
>;

/** One encoded, packaged output of a video: a rung of the ladder in one codec. */
export interface Rendition {
  id: string;
  videoId: string;
  /** e.g. `h264_720p`; also the directory under `videos/<id>/`. */
  name: string;
  codec: Codec;
  width: number;
  height: number;
  videoBitrateKbps: number;
  /** Null when the source had no audio. */
  audioBitrateKbps: number | null;
  /** Storage key of this rendition's HLS media playlist. */
  playlistKey: string;
  segmentCount: number;
  sizeBytes: number | null;
  durationSeconds: number | null;
  createdAt: string;
}

export type NewRendition = Omit<Rendition, 'id' | 'createdAt'>;

/** A manually uploaded WebVTT subtitle track (decision #13; no auto-captioning). */
export interface Subtitle {
  id: string;
  videoId: string;
  /** BCP-47 tag, lower-cased primary subtag, e.g. `en` or `pt-BR`. */
  language: string;
  /** Human-readable name shown in a player's track menu. */
  label: string;
  storageKey: string;
  /** At most one default track per video. */
  isDefault: boolean;
  cueCount: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewSubtitle {
  videoId: string;
  language: string;
  label: string;
  storageKey: string;
  isDefault?: boolean;
  cueCount: number;
  sizeBytes: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListOptions {
  /** 1-200, default 50. */
  limit?: number;
  /** Default 0. */
  offset?: number;
}

export interface VideoListOptions extends ListOptions {
  status?: VideoStatus;
}

export interface JobListOptions extends ListOptions {
  videoId?: string;
  status?: JobStatus;
}

/** Lists are ordered newest first (`createdAt` desc, then `id` desc as a tiebreaker). */
export interface VideoRepository {
  create(input: NewVideo): Promise<Video>;
  get(id: string): Promise<Video | null>;
  list(options?: VideoListOptions): Promise<Page<Video>>;
  /** Returns the updated record, or null if no such id. An empty patch is a no-op read. */
  update(id: string, patch: VideoPatch): Promise<Video | null>;
  /** Deletes the video and (cascade) its jobs. Returns false if no such id. */
  delete(id: string): Promise<boolean>;
}

export interface JobRepository {
  /** Rejects with `RecordNotFoundError` if `videoId` does not exist. */
  create(input: NewJob): Promise<Job>;
  get(id: string): Promise<Job | null>;
  list(options?: JobListOptions): Promise<Page<Job>>;
  update(id: string, patch: JobPatch): Promise<Job | null>;
  delete(id: string): Promise<boolean>;
}

export interface RenditionRepository {
  listForVideo(videoId: string): Promise<Rendition[]>;
  /** Atomically replace the video's renditions (a re-transcode discards the old set). */
  replaceForVideo(videoId: string, renditions: NewRendition[]): Promise<Rendition[]>;
}

/** Subtitle tracks, keyed by (video, language). Ordered by language. */
export interface SubtitleRepository {
  listForVideo(videoId: string): Promise<Subtitle[]>;
  get(videoId: string, language: string): Promise<Subtitle | null>;
  /**
   * Insert or replace the track for this (video, language). Setting `isDefault` clears the
   * flag on the video's other tracks. Rejects with `RecordNotFoundError` for an unknown video.
   */
  upsert(input: NewSubtitle): Promise<Subtitle>;
  delete(videoId: string, language: string): Promise<boolean>;
}

/** Metadata database abstraction (decision #7: SQLite for local mode, Postgres for cloud mode). */
export interface Database {
  readonly backend: DbBackend;
  readonly videos: VideoRepository;
  readonly jobs: JobRepository;
  readonly renditions: RenditionRepository;
  readonly subtitles: SubtitleRepository;
  /** Apply any pending schema migrations. Safe to call on every startup. */
  migrate(): Promise<void>;
  /** Cheap round-trip used by `/healthz`. Rejects if the database is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export class DbError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DbError';
  }
}

export class RecordNotFoundError extends DbError {
  constructor(
    public readonly entity: string,
    public readonly id: string,
  ) {
    super(`${entity} not found: ${id}`);
    this.name = 'RecordNotFoundError';
  }
}
