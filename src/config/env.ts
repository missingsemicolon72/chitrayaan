import { z } from 'zod';

/**
 * Environment schema for Chitrayaan.
 *
 * Every variable listed in CLAUDE.md's "Environment variables" table is declared here.
 * Cross-field rules (e.g. S3 credentials are required only when STORAGE_BACKEND=s3) live in
 * the `superRefine` block at the bottom so a misconfigured deployment fails at startup with a
 * readable list of problems instead of at first use.
 */

const port = z.coerce.number().int().min(1).max(65535);

/** "true" / "false" strings from the environment -> boolean. Anything else is rejected. */
const envBoolean = (defaultValue: boolean) =>
  z
    .enum(['true', 'false'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true');

/** Comma-separated list -> de-duplicated array restricted to `allowed` values. */
const commaList = <const T extends readonly [string, ...string[]]>(
  allowed: T,
  defaultValue: string,
) =>
  z
    .string()
    .default(defaultValue)
    .transform((raw) =>
      Array.from(
        new Set(
          raw
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s.length > 0),
        ),
      ),
    )
    .pipe(z.array(z.enum(allowed)).min(1));

export const PACKAGE_FORMATS = ['hls', 'dash'] as const;
/**
 * H.264 is always on; AV1 is opt-in. H.265/HEVC is permanently excluded (CLAUDE.md decision #11)
 * and is deliberately absent from this list so it cannot be enabled by configuration.
 */
export const CODECS = ['h264', 'av1'] as const;
export const WATERMARK_POSITIONS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // API server
    PORT: port.default(3000),
    HOST: z.string().min(1).default('127.0.0.1'),
    API_KEY: z
      .string({ error: 'API_KEY is required (shared secret for the X-API-Key header)' })
      .min(16, 'API_KEY must be at least 16 characters (it is the only auth on the API)'),

    // Storage (decision #6: local disk or S3-compatible, selectable)
    STORAGE_BACKEND: z.enum(['local', 's3']).default('local'),
    LOCAL_STORAGE_PATH: z.string().min(1).default('./data/storage'),
    S3_ENDPOINT: z.url().optional(),
    S3_BUCKET: z.string().min(1).optional(),
    S3_ACCESS_KEY: z.string().min(1).optional(),
    S3_SECRET_KEY: z.string().min(1).optional(),
    S3_REGION: z.string().min(1).optional(),

    // Metadata DB (decision #7: SQLite for local mode, Postgres for cloud mode)
    DB_BACKEND: z.enum(['sqlite', 'postgres']).default('sqlite'),
    SQLITE_PATH: z.string().min(1).default('./data/chitrayaan.sqlite'),
    DATABASE_URL: z.string().min(1).optional(),

    // Job queue (decision #5: BullMQ + Redis)
    REDIS_URL: z.url().default('redis://127.0.0.1:6379'),
    /** Transcode jobs one worker process runs at once. FFmpeg is CPU-bound, so keep this low. */
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),

    // Transcoding (FFmpeg does the real work; these locate and tune it)
    FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
    FFPROBE_PATH: z.string().min(1).default('ffprobe'),
    /** libx264 speed/quality trade-off. `medium` is x264's default; faster presets cost bitrate. */
    FFMPEG_PRESET: z
      .enum([
        'ultrafast',
        'superfast',
        'veryfast',
        'faster',
        'fast',
        'medium',
        'slow',
        'slower',
        'veryslow',
      ])
      .default('medium'),
    /** SVT-AV1 preset, 0 (slowest, best) to 13 (fastest). Only used when CODEC_LADDER has av1. */
    AV1_PRESET: z.coerce.number().int().min(0).max(13).default(8),
    /** Scratch space for per-job work directories. Defaults to the OS temp directory. */
    WORK_DIR: z.string().min(1).optional(),

    // Packaging + codec ladder (decisions #9, #10, #11)
    PACKAGE_FORMATS: commaList(PACKAGE_FORMATS, 'hls,dash'),
    CODEC_LADDER: commaList(CODECS, 'h264').refine((codecs) => codecs.includes('h264'), {
      message: 'CODEC_LADDER must include h264 (H.264/AAC is always on; AV1 is an addition)',
    }),

    // Optional features (decision #13: all opt-in, off by default)
    FEATURE_THUMBNAILS: envBoolean(false),
    FEATURE_SUBTITLES: envBoolean(false),
    FEATURE_WATERMARK: envBoolean(false),
    WATERMARK_IMAGE_PATH: z.string().min(1).optional(),
    WATERMARK_POSITION: z.enum(WATERMARK_POSITIONS).default('bottom-right'),
    WATERMARK_OPACITY: z.coerce.number().min(0).max(1).default(1),

    // Upload (decision #14: tus resumable upload)
    TUS_UPLOAD_MAX_SIZE_MB: z.coerce.number().int().positive().default(4096),

    // Live ingest (phase 2)
    RTMP_LISTEN_PORT: port.default(1935),
    RTMP_STREAM_KEY: z.string().min(1).optional(),

    // Testing
    TEST_SAMPLES_DIR: z.string().min(1).default('./test/samples'),
  })
  .superRefine((env, ctx) => {
    const requireWhen = (condition: boolean, keys: readonly (keyof typeof env)[], why: string) => {
      if (!condition) return;
      for (const key of keys) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when ${why}` });
        }
      }
    };

    requireWhen(
      env.STORAGE_BACKEND === 's3',
      ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_REGION'],
      'STORAGE_BACKEND=s3',
    );
    requireWhen(env.DB_BACKEND === 'postgres', ['DATABASE_URL'], 'DB_BACKEND=postgres');
    requireWhen(env.FEATURE_WATERMARK, ['WATERMARK_IMAGE_PATH'], 'FEATURE_WATERMARK=true');
  });

export type AppConfig = z.infer<typeof envSchema>;
export type EnvInput = z.input<typeof envSchema>;

/** Thrown when the environment fails validation. `issues` is one human-readable line per problem. */
export class ConfigError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validate an environment-shaped object (defaults to `process.env`) into a typed `AppConfig`.
 * Empty-string values are treated as unset, matching how docker-compose and CI usually pass
 * "no value" for a variable.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }

  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${key}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }
  return result.data;
}
