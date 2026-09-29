import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { FileStore } from '@tus/file-store';
import { S3Store } from '@tus/s3-store';
import type { DataStore } from '@tus/utils';

import { LocalDiskStorage } from './local-disk.js';
import { S3Storage } from './s3.js';
import type { ObjectStorage } from './types.js';

/**
 * Uploaded source files live inside the configured storage backend, so the worker can read them
 * through the same `ObjectStorage` interface as everything else and no copy is needed once an
 * upload completes. The tus upload id doubles as the video id.
 */
export const UPLOADS_PREFIX = 'uploads';

export interface TusIntegration {
  datastore: DataStore;
  /**
   * Storage key holding a finished upload's bytes. The two stores lay them out differently:
   * `@tus/file-store` is rooted at a directory (so `uploads/<id>`), while `@tus/s3-store` keys
   * objects by upload id at the bucket root (so `<id>`).
   */
  sourceKeyFor: (uploadId: string) => string;
}

/** tus datastore matching the active storage backend, plus where it puts finished uploads. */
export function createTusIntegration(storage: ObjectStorage): TusIntegration {
  if (storage instanceof LocalDiskStorage) {
    const directory = path.join(storage.rootDir, UPLOADS_PREFIX);
    mkdirSync(directory, { recursive: true });
    return {
      // tus's own expiration is deliberately left off: `FileStore.write` does not persist the
      // new offset, so its `deleteExpired` treats finished uploads as incomplete and would
      // delete the sources of transcoded videos. Abandoned uploads are swept in `uploadRoutes`.
      datastore: new FileStore({ directory }),
      sourceKeyFor: (uploadId) => `${UPLOADS_PREFIX}/${uploadId}`,
    };
  }

  if (storage instanceof S3Storage) {
    return {
      datastore: new S3Store({
        s3ClientConfig: { ...storage.clientConfig, bucket: storage.bucket },
      }),
      sourceKeyFor: (uploadId) => uploadId,
    };
  }

  throw new Error(`no tus datastore for storage backend "${storage.backend}"`);
}
