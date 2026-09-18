import type { AppConfig } from '../../config/index.js';
import { LocalDiskStorage } from './local-disk.js';
import type { ObjectStorage } from './types.js';

export { LocalDiskStorage } from './local-disk.js';
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

export type StorageConfig = Pick<AppConfig, 'STORAGE_BACKEND' | 'LOCAL_STORAGE_PATH'>;

/** Build the storage driver selected by `STORAGE_BACKEND`. */
export async function createStorage(config: StorageConfig): Promise<ObjectStorage> {
  switch (config.STORAGE_BACKEND) {
    case 'local':
      return LocalDiskStorage.create(config.LOCAL_STORAGE_PATH);
    case 's3':
      throw new Error('STORAGE_BACKEND=s3 is not available yet (planned for Milestone 11)');
  }
}
