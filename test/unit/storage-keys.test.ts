import { describe, expect, it } from 'vitest';

import {
  assertValidKey,
  assertValidPrefix,
  contentTypeForKey,
  InvalidStorageKeyError,
} from '../../src/lib/storage/index.js';

describe('assertValidKey', () => {
  it('accepts well-formed relative keys', () => {
    for (const key of [
      'file.mp4',
      'videos/abc-123/h264_720p/seg_001.m4s',
      'uploads/0f3a.bin',
      '.hidden',
      'a/b/c/d/e/f',
      'UPPER_case-mix.99',
    ]) {
      expect(() => assertValidKey(key), key).not.toThrow();
    }
  });

  it('rejects traversal, absolute paths, and unsafe characters', () => {
    const cases: [string, RegExp][] = [
      ['', /empty/],
      ['/etc/passwd', /start with/],
      ['dir/', /end with/],
      ['a//b', /empty segments/],
      ['..', /"\." or "\.\."/],
      ['../x', /"\." or "\.\."/],
      ['a/../b', /"\." or "\.\."/],
      ['a/./b', /"\." or "\.\."/],
      ['a\\b', /letters, digits/],
      ['a b', /letters, digits/],
      ['a~b', /letters, digits/],
      ['a:b', /letters, digits/],
      ['ü.mp4', /letters, digits/],
      ['a'.repeat(1025), /at most 1024/],
    ];
    for (const [key, message] of cases) {
      expect(() => assertValidKey(key), key).toThrow(InvalidStorageKeyError);
      expect(() => assertValidKey(key), key).toThrow(message);
    }
  });
});

describe('assertValidPrefix', () => {
  it('accepts empty, trailing-slash, and partial prefixes', () => {
    for (const prefix of ['', 'videos/', 'videos/ab', 'videos/abc/h264', 'v']) {
      expect(() => assertValidPrefix(prefix), prefix).not.toThrow();
    }
  });

  it('rejects traversal and absolute prefixes', () => {
    for (const prefix of ['/videos', 'a/../b', 'a//b', '..', 'a\\b', 'a~']) {
      expect(() => assertValidPrefix(prefix), prefix).toThrow(InvalidStorageKeyError);
    }
  });
});

describe('contentTypeForKey', () => {
  it('maps streaming and media extensions, case-insensitively', () => {
    expect(contentTypeForKey('videos/v/master.m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(contentTypeForKey('videos/v/master.mpd')).toBe('application/dash+xml');
    expect(contentTypeForKey('videos/v/r/seg_001.m4s')).toBe('video/iso.segment');
    expect(contentTypeForKey('videos/v/r/init.mp4')).toBe('video/mp4');
    expect(contentTypeForKey('subs/en.vtt')).toBe('text/vtt');
    expect(contentTypeForKey('thumbs/sprite.JPG')).toBe('image/jpeg');
  });

  it('falls back to octet-stream for unknown or missing extensions', () => {
    expect(contentTypeForKey('blob')).toBe('application/octet-stream');
    expect(contentTypeForKey('mp4')).toBe('application/octet-stream');
    expect(contentTypeForKey('archive.xyz')).toBe('application/octet-stream');
  });
});
