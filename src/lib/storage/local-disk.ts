import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { assertValidKey, assertValidPrefix } from './keys.js';
import {
  InvalidStorageKeyError,
  StorageNotFoundError,
  type ObjectInfo,
  type ObjectStorage,
  type PutBody,
} from './types.js';

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Local-disk driver: each key maps to `<rootDir>/<key>`.
 *
 * Writes go to a sibling temp file and are renamed into place, so a concurrent reader (the API
 * serving a segment while the worker is still writing others) never sees a half-written object.
 * Temp files contain `~`, which valid keys cannot, so they are never listed as objects.
 */
export class LocalDiskStorage implements ObjectStorage {
  readonly backend = 'local' as const;
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /** Create the driver and make sure the root directory exists. */
  static async create(rootDir: string): Promise<LocalDiskStorage> {
    const storage = new LocalDiskStorage(rootDir);
    await mkdir(storage.rootDir, { recursive: true });
    return storage;
  }

  /**
   * Absolute filesystem path for a key. Exposed so local-mode fast paths (e.g. letting FFmpeg
   * write straight into storage) can use it; everything else should go through the interface.
   */
  pathFor(key: string): string {
    assertValidKey(key);
    const abs = path.join(this.rootDir, ...key.split('/'));
    // Validated keys cannot escape the root; this is defense in depth.
    if (!abs.startsWith(this.rootDir + path.sep)) {
      throw new InvalidStorageKeyError(key, 'resolves outside the storage root');
    }
    return abs;
  }

  async put(key: string, body: PutBody): Promise<void> {
    const dest = this.pathFor(key);
    await this.writeAtomically(dest, async (tmp) => {
      if (body instanceof Readable) {
        await pipeline(body, createWriteStream(tmp));
      } else {
        await writeFile(tmp, body);
      }
    });
  }

  async putFile(key: string, localPath: string): Promise<void> {
    const dest = this.pathFor(key);
    await this.writeAtomically(dest, (tmp) => copyFile(localPath, tmp));
  }

  async get(key: string): Promise<Readable> {
    const abs = this.pathFor(key);
    await this.requireFile(abs, key);
    return createReadStream(abs);
  }

  async downloadToFile(key: string, localPath: string): Promise<void> {
    const abs = this.pathFor(key);
    await this.requireFile(abs, key);
    await mkdir(path.dirname(path.resolve(localPath)), { recursive: true });
    await copyFile(abs, localPath);
  }

  async stat(key: string): Promise<ObjectInfo | null> {
    const abs = this.pathFor(key);
    try {
      const info = await stat(abs);
      if (!info.isFile()) return null;
      return { key, size: info.size, lastModified: info.mtime };
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    const abs = this.pathFor(key);
    try {
      await unlink(abs);
    } catch (err) {
      if (!isENOENT(err)) throw err;
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const objects = await this.list(prefix);
    for (const object of objects) {
      await this.delete(object.key);
      await this.pruneEmptyDirs(path.dirname(this.pathFor(object.key)));
    }
    return objects.length;
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    assertValidPrefix(prefix);
    // Start walking at the directory that contains the prefix's last (possibly partial) segment.
    const slash = prefix.lastIndexOf('/');
    const dirKey = slash === -1 ? '' : prefix.slice(0, slash);
    const startDir = dirKey === '' ? this.rootDir : path.join(this.rootDir, ...dirKey.split('/'));

    const found: ObjectInfo[] = [];
    await this.walk(startDir, dirKey, found);
    return found
      .filter((object) => object.key.startsWith(prefix))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  private async requireFile(abs: string, key: string): Promise<void> {
    try {
      const info = await stat(abs);
      if (!info.isFile()) throw new StorageNotFoundError(key);
    } catch (err) {
      if (isENOENT(err)) throw new StorageNotFoundError(key);
      throw err;
    }
  }

  private async writeAtomically(
    dest: string,
    write: (tmpPath: string) => Promise<void>,
  ): Promise<void> {
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}~${randomBytes(6).toString('hex')}.tmp`;
    try {
      await write(tmp);
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private async walk(dir: string, keyPrefix: string, out: ObjectInfo[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isENOENT(err)) return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.includes('~')) continue; // in-flight temp file, never a valid key
      const key = keyPrefix === '' ? entry.name : `${keyPrefix}/${entry.name}`;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(abs, key, out);
      } else if (entry.isFile()) {
        const info = await stat(abs);
        out.push({ key, size: info.size, lastModified: info.mtime });
      }
    }
  }

  /** Remove now-empty directories upward from `dir`, stopping at the root. Best effort. */
  private async pruneEmptyDirs(dir: string): Promise<void> {
    let current = dir;
    while (current !== this.rootDir && current.startsWith(this.rootDir + path.sep)) {
      try {
        if ((await readdir(current)).length > 0) return;
        await rmdir(current);
      } catch {
        return;
      }
      current = path.dirname(current);
    }
  }
}
