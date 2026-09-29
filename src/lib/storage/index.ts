import type { AppConfig } from '../../config/index.js';
import { LocalDiskStorage } from './local-disk.js';
import { S3Storage } from './s3.js';
import type { ObjectStorage } from './types.js';

export { LocalDiskStorage } from './local-disk.js';
export { S3Storage, type S3StorageConfig } from './s3.js';
export { assertValidKey, assertValidPrefix, contentTypeForKey } from './keys.js';
export {
  InvalidStorageKeyError,
  StorageNotFoundError,
  type ObjectInfo,
  type ObjectStorage,
  type PutBody,
  type PutOptions,
  type StorageBackend,
} from './types.js';

export type StorageConfig = Pick<
  AppConfig,
  | 'STORAGE_BACKEND'
  | 'LOCAL_STORAGE_PATH'
  | 'S3_ENDPOINT'
  | 'S3_BUCKET'
  | 'S3_ACCESS_KEY'
  | 'S3_SECRET_KEY'
  | 'S3_REGION'
  | 'S3_FORCE_PATH_STYLE'
>;

/**
 * Build the storage driver selected by `STORAGE_BACKEND`. Config validation already guarantees
 * the S3 settings are present when that backend is chosen.
 */
export async function createStorage(config: StorageConfig): Promise<ObjectStorage> {
  switch (config.STORAGE_BACKEND) {
    case 'local':
      return LocalDiskStorage.create(config.LOCAL_STORAGE_PATH);
    case 's3':
      return S3Storage.create({
        endpoint: config.S3_ENDPOINT!,
        bucket: config.S3_BUCKET!,
        accessKeyId: config.S3_ACCESS_KEY!,
        secretAccessKey: config.S3_SECRET_KEY!,
        region: config.S3_REGION!,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
      });
  }
}
