import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

import { assertValidKey, assertValidPrefix, contentTypeForKey } from './keys.js';
import {
  StorageNotFoundError,
  type ObjectInfo,
  type ObjectStorage,
  type PutBody,
  type PutOptions,
} from './types.js';

export interface S3StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** MinIO and most S3-compatible servers need path-style addressing. */
  forcePathStyle?: boolean;
}

/** S3 answers "no such object" in a few shapes depending on the operation and the server. */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    e.Code === 'NoSuchKey' ||
    e.$metadata?.httpStatusCode === 404
  );
}

/** One delete request can carry this many keys. */
const DELETE_BATCH = 1_000;

/**
 * S3-compatible object storage (decision #6), tested against MinIO. Behaviour matches the
 * local-disk driver exactly, which the shared storage contract suite enforces: same key rules,
 * same prefix semantics, same not-found errors.
 */
export class S3Storage implements ObjectStorage {
  readonly backend = 's3' as const;
  readonly bucket: string;
  readonly client: S3Client;
  /** Client settings, so the tus S3 store can be built against the same bucket. */
  readonly clientConfig: S3ClientConfig;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.clientConfig = {
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: config.forcePathStyle ?? true,
    };
    this.client = new S3Client(this.clientConfig);
  }

  /** Create the driver and make sure the bucket exists, mirroring the disk driver's mkdir. */
  static async create(config: S3StorageConfig): Promise<S3Storage> {
    const storage = new S3Storage(config);
    await storage.ensureBucket();
    return storage;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(key: string, body: PutBody, options: PutOptions = {}): Promise<void> {
    assertValidKey(key);
    const ContentType = options.contentType ?? contentTypeForKey(key);
    if (body instanceof Readable) {
      // A stream has no known length, so upload it in parts.
      await new Upload({
        client: this.client,
        params: { Bucket: this.bucket, Key: key, Body: body, ContentType },
      }).done();
      return;
    }
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType }),
    );
  }

  async putFile(key: string, localPath: string, options: PutOptions = {}): Promise<void> {
    assertValidKey(key);
    await new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(localPath),
        ContentType: options.contentType ?? contentTypeForKey(key),
      },
    }).done();
  }

  async get(key: string): Promise<Readable> {
    assertValidKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) throw new StorageNotFoundError(key);
      return res.Body as Readable;
    } catch (err) {
      if (isNotFound(err)) throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async downloadToFile(key: string, localPath: string): Promise<void> {
    const body = await this.get(key);
    await mkdir(path.dirname(path.resolve(localPath)), { recursive: true });
    await pipeline(body, createWriteStream(localPath));
  }

  async stat(key: string): Promise<ObjectInfo | null> {
    assertValidKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        key,
        size: res.ContentLength ?? 0,
        lastModified: res.LastModified ?? new Date(),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    // S3 treats deleting a missing key as success, like the disk driver's unlink guard.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    const objects = await this.list(prefix);
    for (let i = 0; i < objects.length; i += DELETE_BATCH) {
      const batch = objects.slice(i, i + DELETE_BATCH);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((o) => ({ Key: o.key })), Quiet: true },
        }),
      );
    }
    return objects.length;
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    assertValidPrefix(prefix);
    const found: ObjectInfo[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ...(prefix === '' ? {} : { Prefix: prefix }),
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const item of res.Contents ?? []) {
        if (item.Key === undefined) continue;
        found.push({
          key: item.Key,
          size: item.Size ?? 0,
          lastModified: item.LastModified ?? new Date(),
        });
      }
      continuationToken = res.IsTruncated === true ? res.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);

    return found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}
