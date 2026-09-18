import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { FileStore } from '@tus/file-store';
import type { DataStore } from '@tus/utils';

import { LocalDiskStorage } from './local-disk.js';
import type { ObjectStorage } from './types.js';

/**
 * Uploaded source files live inside the configured storage backend under this prefix, so the
 * worker can read them through the same `ObjectStorage` interface as everything else and no
 * copy is needed once an upload completes. The tus upload id doubles as the video id.
 */
export const UPLOADS_PREFIX = 'uploads';

export function sourceKeyForUpload(uploadId: string): string {
  return `${UPLOADS_PREFIX}/${uploadId}`;
}

/**
 * tus datastore matching the active storage backend. Local disk -> `@tus/file-store` rooted at
 * `<LOCAL_STORAGE_PATH>/uploads`. S3 -> `@tus/s3-store`, arriving with Milestone 11.
 */
export function createTusDatastore(storage: ObjectStorage): DataStore {
  if (storage instanceof LocalDiskStorage) {
    const directory = path.join(storage.rootDir, UPLOADS_PREFIX);
    mkdirSync(directory, { recursive: true });
    return new FileStore({ directory });
  }
  throw new Error(
    `No tus datastore for storage backend "${storage.backend}" yet (S3 is planned for Milestone 11)`,
  );
}
