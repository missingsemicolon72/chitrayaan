import type { Readable } from 'node:stream';

export type StorageBackend = 'local' | 's3';

export interface ObjectInfo {
  key: string;
  size: number;
  lastModified: Date;
}

export interface PutOptions {
  /** MIME type to record with the object. S3 stores it; local disk derives it from the key. */
  contentType?: string;
}

export type PutBody = Readable | Buffer | string;

/**
 * Object storage abstraction (decision #6: local disk or S3-compatible, selectable via env).
 *
 * Keys are `/`-separated, relative, and validated (see `keys.ts`). Prefix operations use plain
 * string-prefix semantics like S3, so `videos/abc` matches `videos/abc/x.m4s` and `videos/abcd`.
 */
export interface ObjectStorage {
  readonly backend: StorageBackend;

  /** Write an object. Overwrites. The write is atomic: readers never observe a partial object. */
  put(key: string, body: PutBody, options?: PutOptions): Promise<void>;
  /** Write an object from a local file (e.g. FFmpeg output). Overwrites. */
  putFile(key: string, localPath: string, options?: PutOptions): Promise<void>;

  /** Stream an object's bytes. Rejects with `StorageNotFoundError` if the key does not exist. */
  get(key: string): Promise<Readable>;
  /** Copy an object to a local file (e.g. a transcode work dir). Parent directories are created. */
  downloadToFile(key: string, localPath: string): Promise<void>;

  stat(key: string): Promise<ObjectInfo | null>;
  exists(key: string): Promise<boolean>;

  /** Delete one object. Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Delete every object whose key starts with `prefix`. Returns the number deleted. */
  deletePrefix(prefix: string): Promise<number>;
  /** List objects whose key starts with `prefix` (`''` lists everything), sorted by key. */
  list(prefix: string): Promise<ObjectInfo[]>;
}

export class StorageNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`Object not found: ${key}`);
    this.name = 'StorageNotFoundError';
  }
}

export class InvalidStorageKeyError extends Error {
  constructor(
    public readonly key: string,
    reason: string,
  ) {
    super(`Invalid storage key ${JSON.stringify(key)}: ${reason}`);
    this.name = 'InvalidStorageKeyError';
  }
}
