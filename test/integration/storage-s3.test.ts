import { randomUUID } from 'node:crypto';

import { DeleteBucketCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, describe, expect, it } from 'vitest';

import { createStorage, S3Storage } from '../../src/lib/storage/index.js';
import { describeStorageContract } from '../contracts/storage.contract.js';
import { s3Available, TEST_S3 } from '../helpers/cloud.js';

const S3 = await s3Available();

const newBucketName = () => `chitrayaan-test-${randomUUID().slice(0, 12)}`;

/**
 * One bucket for the whole suite, emptied between tests. Creating a bucket per test is wasteful
 * against any S3 server and outright fails on some (SeaweedFS gives each bucket its own volume
 * collection), and the contract only needs an empty store.
 */
let shared: S3Storage | undefined;

async function sharedStorage(): Promise<S3Storage> {
  shared ??= await S3Storage.create({ ...TEST_S3, bucket: newBucketName() });
  return shared;
}

async function dropBucket(storage: S3Storage): Promise<void> {
  await storage.deletePrefix('');
  await storage.client.send(new DeleteBucketCommand({ Bucket: storage.bucket }));
  storage.client.destroy();
}

/**
 * The same contract the local-disk driver passes, against an S3-compatible server: this is
 * what "parity with local mode" means in practice. Skipped when no server is running.
 */
describe.skipIf(!S3)('s3 parity', () => {
  afterAll(async () => {
    if (shared) await dropBucket(shared);
    shared = undefined;
  });

  describeStorageContract('s3', async () => {
    const storage = await sharedStorage();
    await storage.deletePrefix('');
    return { storage, teardown: () => storage.deletePrefix('').then(() => undefined) };
  });

  describe('S3 driver specifics', () => {
    it('creates its bucket on demand, like the disk driver creates its root', async () => {
      const bucket = newBucketName();
      const storage = await S3Storage.create({ ...TEST_S3, bucket });
      try {
        expect(storage.backend).toBe('s3');
        expect(storage.bucket).toBe(bucket);

        // Opening the same bucket again is fine, and both handles see the same objects.
        const again = await S3Storage.create({ ...TEST_S3, bucket });
        await again.put('hello.txt', 'hi');
        expect(await storage.exists('hello.txt')).toBe(true);
        again.client.destroy();
      } finally {
        await dropBucket(storage);
      }
    });

    it('stores a content type derived from the key, and honours an explicit one', async () => {
      const storage = await sharedStorage();
      await storage.deletePrefix('');
      await storage.put('videos/v1/master.m3u8', '#EXTM3U');
      await storage.put('videos/v1/odd.bin', 'x', { contentType: 'text/vtt' });

      const playlist = await storage.client.send(
        new HeadObjectCommand({ Bucket: storage.bucket, Key: 'videos/v1/master.m3u8' }),
      );
      expect(playlist.ContentType).toBe('application/vnd.apple.mpegurl');

      const explicit = await storage.client.send(
        new HeadObjectCommand({ Bucket: storage.bucket, Key: 'videos/v1/odd.bin' }),
      );
      expect(explicit.ContentType).toBe('text/vtt');
    });

    it('pages through a large listing in key order', async () => {
      const storage = await sharedStorage();
      await storage.deletePrefix('');
      const keys = Array.from(
        { length: 120 },
        (_, i) => `bulk/seg_${String(i).padStart(4, '0')}.m4s`,
      );
      await Promise.all(keys.map((key) => storage.put(key, 'x')));

      const listed = await storage.list('bulk/');
      expect(listed).toHaveLength(120);
      expect(listed.map((o) => o.key)).toEqual(keys);
      expect(await storage.deletePrefix('bulk/')).toBe(120);
      expect(await storage.list('bulk/')).toEqual([]);
    }, 120_000);

    it('createStorage builds the S3 driver from config', async () => {
      const shared_ = await sharedStorage();
      const storage = (await createStorage({
        STORAGE_BACKEND: 's3',
        LOCAL_STORAGE_PATH: './unused',
        S3_ENDPOINT: TEST_S3.endpoint,
        S3_BUCKET: shared_.bucket,
        S3_ACCESS_KEY: TEST_S3.accessKeyId,
        S3_SECRET_KEY: TEST_S3.secretAccessKey,
        S3_REGION: TEST_S3.region,
        S3_FORCE_PATH_STYLE: true,
      })) as S3Storage;
      try {
        expect(storage.backend).toBe('s3');
        await storage.put('from-config.txt', 'hello');
        expect((await storage.stat('from-config.txt'))?.size).toBe(5);
      } finally {
        await storage.deletePrefix('');
        storage.client.destroy();
      }
    });
  });
});
