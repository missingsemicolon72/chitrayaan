import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';

/**
 * Cloud-mode services for the parity suites. Both are optional: when the service is not
 * running the suite skips itself, the same way the Redis and FFmpeg suites do.
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://chitrayaan:chitrayaan@127.0.0.1:5432/chitrayaan_test';

export const TEST_S3 = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  accessKeyId: process.env.TEST_S3_ACCESS_KEY ?? 'minioadmin',
  secretAccessKey: process.env.TEST_S3_SECRET_KEY ?? 'minioadmin',
  region: process.env.TEST_S3_REGION ?? 'us-east-1',
};

let postgresProbe: Promise<boolean> | undefined;
let s3Probe: Promise<boolean> | undefined;

/** True when a Postgres answering at TEST_DATABASE_URL accepts a query. */
export function postgresAvailable(): Promise<boolean> {
  postgresProbe ??= (async () => {
    const pool = new pg.Pool({
      connectionString: TEST_DATABASE_URL,
      connectionTimeoutMillis: 2_000,
    });
    try {
      await pool.query('select 1');
      return true;
    } catch (err) {
      console.warn(
        `[tests] Postgres not reachable at ${TEST_DATABASE_URL.replace(/:[^:@]*@/, ':***@')}; ` +
          `its parity suite is skipped (${(err as Error).message})`,
      );
      return false;
    } finally {
      await pool.end().catch(() => undefined);
    }
  })();
  return postgresProbe;
}

/** True when an S3-compatible server answers at TEST_S3_ENDPOINT. */
export function s3Available(): Promise<boolean> {
  s3Probe ??= (async () => {
    const client = new S3Client({
      endpoint: TEST_S3.endpoint,
      region: TEST_S3.region,
      credentials: {
        accessKeyId: TEST_S3.accessKeyId,
        secretAccessKey: TEST_S3.secretAccessKey,
      },
      forcePathStyle: true,
      requestHandler: { requestTimeout: 3_000, connectionTimeout: 2_000 },
    });
    try {
      await client.send(new ListBucketsCommand({}));
      return true;
    } catch (err) {
      console.warn(
        `[tests] no S3 server at ${TEST_S3.endpoint}; its parity suite is skipped ` +
          `(${(err as Error).message})`,
      );
      return false;
    } finally {
      client.destroy();
    }
  })();
  return s3Probe;
}
