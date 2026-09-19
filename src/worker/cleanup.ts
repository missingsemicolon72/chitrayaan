import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type { MinimalLogger } from '../lib/logger.js';

/** Work directories are named `chitrayaan-<job prefix>-<random>`. */
const WORK_DIR_PREFIX = 'chitrayaan-';

/** A directory is only stale once nothing could plausibly still be writing to it. */
export const STALE_WORK_DIR_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Delete work directories left behind by a worker that was killed mid-job. Called at startup,
 * where a directory older than a day cannot belong to a running job.
 */
export async function sweepStaleWorkDirs(
  root: string,
  log: MinimalLogger,
  maxAgeMs = STALE_WORK_DIR_AGE_MS,
): Promise<number> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0; // The work root is created on demand; nothing to sweep yet.
  }

  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(WORK_DIR_PREFIX)) continue;
    const dir = path.join(root, entry.name);
    try {
      if ((await stat(dir)).mtimeMs > cutoff) continue;
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      log.warn({ err, dir }, 'could not remove stale work directory');
    }
  }
  if (removed > 0) log.info({ removed, root }, 'removed stale work directories');
  return removed;
}
