import path from 'node:path';

import { InvalidStorageKeyError } from './types.js';

const MAX_KEY_LENGTH = 1024;
/** One path segment of a key. Deliberately strict so keys map 1:1 onto safe filesystem paths. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

function checkSegment(key: string, segment: string): void {
  if (segment === '.' || segment === '..') {
    throw new InvalidStorageKeyError(key, 'must not contain "." or ".." segments');
  }
  if (!SEGMENT.test(segment)) {
    throw new InvalidStorageKeyError(
      key,
      'segments may only contain letters, digits, ".", "_" and "-"',
    );
  }
}

/** Throws `InvalidStorageKeyError` unless `key` is a safe, relative, `/`-separated object key. */
export function assertValidKey(key: string): void {
  if (key.length === 0) throw new InvalidStorageKeyError(key, 'must not be empty');
  if (key.length > MAX_KEY_LENGTH) {
    throw new InvalidStorageKeyError(key, `must be at most ${MAX_KEY_LENGTH} characters`);
  }
  if (key.startsWith('/')) throw new InvalidStorageKeyError(key, 'must not start with "/"');
  if (key.endsWith('/')) throw new InvalidStorageKeyError(key, 'must not end with "/"');
  for (const segment of key.split('/')) {
    if (segment === '') throw new InvalidStorageKeyError(key, 'must not contain empty segments');
    checkSegment(key, segment);
  }
}

/**
 * Like `assertValidKey` but for list/delete prefixes: `''` is allowed, and so are a trailing `/`
 * and a partial final segment (`videos/ab`).
 */
export function assertValidPrefix(prefix: string): void {
  if (prefix === '') return;
  if (prefix.length > MAX_KEY_LENGTH) {
    throw new InvalidStorageKeyError(prefix, `must be at most ${MAX_KEY_LENGTH} characters`);
  }
  if (prefix.startsWith('/')) throw new InvalidStorageKeyError(prefix, 'must not start with "/"');
  const segments = prefix.split('/');
  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    if (segment === '') {
      if (isLast) return; // trailing slash is fine for a prefix
      throw new InvalidStorageKeyError(prefix, 'must not contain empty segments');
    }
    checkSegment(prefix, segment);
  });
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  // Streaming manifests + segments
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.ts': 'video/mp2t',
  // Source containers
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  // Subtitles, thumbnails, misc
  '.vtt': 'text/vtt',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

/** Best-effort MIME type from a key's extension; `application/octet-stream` when unknown. */
export function contentTypeForKey(key: string): string {
  const ext = path.posix.extname(key).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}
