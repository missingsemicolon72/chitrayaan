import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../src/config/index.js';

/** Smallest env that passes validation: only API_KEY has no default. */
const MINIMAL = { API_KEY: 'a-sufficiently-long-test-key' };

function issuesOf(source: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(source);
  } catch (err) {
    if (err instanceof ConfigError) return [...err.issues];
    throw err;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies documented defaults to a minimal env', () => {
    const config = loadConfig(MINIMAL);

    expect(config).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      HOST: '127.0.0.1',
      STORAGE_BACKEND: 'local',
      LOCAL_STORAGE_PATH: './data/storage',
      DB_BACKEND: 'sqlite',
      SQLITE_PATH: './data/chitrayaan.sqlite',
      REDIS_URL: 'redis://127.0.0.1:6379',
      PACKAGE_FORMATS: ['hls', 'dash'],
      CODEC_LADDER: ['h264'],
      FEATURE_THUMBNAILS: false,
      FEATURE_SUBTITLES: false,
      FEATURE_WATERMARK: false,
      WATERMARK_POSITION: 'bottom-right',
      WATERMARK_OPACITY: 1,
      TUS_UPLOAD_MAX_SIZE_MB: 4096,
      RTMP_LISTEN_PORT: 1935,
      TEST_SAMPLES_DIR: './test/samples',
    });
  });

  it('requires API_KEY and enforces a minimum length', () => {
    expect(issuesOf({})).toEqual([expect.stringMatching(/^API_KEY: /)]);
    expect(issuesOf({ API_KEY: 'short' })).toEqual([expect.stringMatching(/^API_KEY: .*16/)]);
  });

  it('coerces numeric and boolean strings', () => {
    const config = loadConfig({
      ...MINIMAL,
      PORT: '8080',
      FEATURE_THUMBNAILS: 'true',
      WATERMARK_OPACITY: '0.5',
      TUS_UPLOAD_MAX_SIZE_MB: '100',
    });

    expect(config.PORT).toBe(8080);
    expect(config.FEATURE_THUMBNAILS).toBe(true);
    expect(config.WATERMARK_OPACITY).toBe(0.5);
    expect(config.TUS_UPLOAD_MAX_SIZE_MB).toBe(100);
  });

  it('rejects non-boolean feature flags and out-of-range numbers', () => {
    expect(issuesOf({ ...MINIMAL, FEATURE_SUBTITLES: 'yes' })).toEqual([
      expect.stringMatching(/^FEATURE_SUBTITLES: /),
    ]);
    expect(issuesOf({ ...MINIMAL, PORT: '70000' })).toEqual([expect.stringMatching(/^PORT: /)]);
    expect(issuesOf({ ...MINIMAL, WATERMARK_OPACITY: '1.5' })).toEqual([
      expect.stringMatching(/^WATERMARK_OPACITY: /),
    ]);
  });

  it('treats empty-string values as unset so defaults still apply', () => {
    const config = loadConfig({ ...MINIMAL, PORT: '', STORAGE_BACKEND: '' });
    expect(config.PORT).toBe(3000);
    expect(config.STORAGE_BACKEND).toBe('local');
  });

  describe('comma lists', () => {
    it('parses, trims, lower-cases and de-duplicates PACKAGE_FORMATS', () => {
      const config = loadConfig({ ...MINIMAL, PACKAGE_FORMATS: ' HLS, dash ,hls' });
      expect(config.PACKAGE_FORMATS).toEqual(['hls', 'dash']);
    });

    it('rejects unknown package formats', () => {
      expect(issuesOf({ ...MINIMAL, PACKAGE_FORMATS: 'hls,smooth' })).toEqual([
        expect.stringMatching(/^PACKAGE_FORMATS/),
      ]);
    });

    it('allows opting in to av1 alongside h264', () => {
      const config = loadConfig({ ...MINIMAL, CODEC_LADDER: 'h264,av1' });
      expect(config.CODEC_LADDER).toEqual(['h264', 'av1']);
    });

    it('rejects a ladder without h264 (H.264 is always on)', () => {
      expect(issuesOf({ ...MINIMAL, CODEC_LADDER: 'av1' })).toEqual([
        expect.stringMatching(/^CODEC_LADDER: .*h264/),
      ]);
    });

    it('rejects HEVC/H.265 in any spelling (permanently excluded, decision #11)', () => {
      for (const spelling of ['hevc', 'h265', 'h.265', 'x265']) {
        expect(issuesOf({ ...MINIMAL, CODEC_LADDER: `h264,${spelling}` })).toEqual([
          expect.stringMatching(/^CODEC_LADDER/),
        ]);
      }
    });
  });

  describe('cross-field requirements', () => {
    it('requires all S3 settings when STORAGE_BACKEND=s3', () => {
      const issues = issuesOf({ ...MINIMAL, STORAGE_BACKEND: 's3' });
      expect(issues).toEqual([
        'S3_ENDPOINT: S3_ENDPOINT is required when STORAGE_BACKEND=s3',
        'S3_BUCKET: S3_BUCKET is required when STORAGE_BACKEND=s3',
        'S3_ACCESS_KEY: S3_ACCESS_KEY is required when STORAGE_BACKEND=s3',
        'S3_SECRET_KEY: S3_SECRET_KEY is required when STORAGE_BACKEND=s3',
        'S3_REGION: S3_REGION is required when STORAGE_BACKEND=s3',
      ]);
    });

    it('accepts a complete S3 configuration', () => {
      const config = loadConfig({
        ...MINIMAL,
        STORAGE_BACKEND: 's3',
        S3_ENDPOINT: 'http://127.0.0.1:9000',
        S3_BUCKET: 'chitrayaan',
        S3_ACCESS_KEY: 'minioadmin',
        S3_SECRET_KEY: 'minioadmin',
        S3_REGION: 'us-east-1',
      });
      expect(config.STORAGE_BACKEND).toBe('s3');
      expect(config.S3_BUCKET).toBe('chitrayaan');
    });

    it('requires DATABASE_URL when DB_BACKEND=postgres', () => {
      expect(issuesOf({ ...MINIMAL, DB_BACKEND: 'postgres' })).toEqual([
        'DATABASE_URL: DATABASE_URL is required when DB_BACKEND=postgres',
      ]);
    });

    it('requires WATERMARK_IMAGE_PATH when FEATURE_WATERMARK=true', () => {
      expect(issuesOf({ ...MINIMAL, FEATURE_WATERMARK: 'true' })).toEqual([
        'WATERMARK_IMAGE_PATH: WATERMARK_IMAGE_PATH is required when FEATURE_WATERMARK=true',
      ]);
    });

    it('rejects unknown backend modes', () => {
      expect(issuesOf({ ...MINIMAL, STORAGE_BACKEND: 'gcs' })).toEqual([
        expect.stringMatching(/^STORAGE_BACKEND: /),
      ]);
      expect(issuesOf({ ...MINIMAL, DB_BACKEND: 'mysql' })).toEqual([
        expect.stringMatching(/^DB_BACKEND: /),
      ]);
    });
  });

  it('reports every field-level problem at once with a readable message', () => {
    // Cross-field rules (superRefine) only run once field-level validation passes, so a bad
    // DB_BACKEND value here is reported but its DATABASE_URL requirement is not (yet).
    const bad = { API_KEY: 'x', PORT: 'abc', STORAGE_BACKEND: 'gcs' };
    expect(issuesOf(bad).sort()).toEqual([
      expect.stringMatching(/^API_KEY: /),
      expect.stringMatching(/^PORT: /),
      expect.stringMatching(/^STORAGE_BACKEND: /),
    ]);
    expect(() => loadConfig(bad)).toThrow(
      /^Invalid environment configuration:\n {2}- .+\n {2}- .+\n {2}- .+$/,
    );
  });
});
