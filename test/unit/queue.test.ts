import { describe, expect, it } from 'vitest';

import { normalizeFailedReason, withTimeout } from '../../src/lib/queue/index.js';

describe('normalizeFailedReason', () => {
  it('passes an ordinary message through', () => {
    expect(normalizeFailedReason('source object uploads/x not found in storage')).toBe(
      'source object uploads/x not found in storage',
    );
  });

  it('treats nothing-at-all as null', () => {
    for (const empty of [null, undefined, '']) {
      expect(normalizeFailedReason(empty)).toBeNull();
    }
  });

  it('decodes the JSON-encoded form BullMQ sometimes stores', () => {
    expect(normalizeFailedReason('"ffmpeg exited with code 1"')).toBe('ffmpeg exited with code 1');
    expect(normalizeFailedReason('{"message":"source file is unusable","stack":"..."}')).toBe(
      'source file is unusable',
    );
  });

  it('pulls the message out of a structured error', () => {
    expect(normalizeFailedReason({ message: 'disk is full', stack: 'at x' })).toBe('disk is full');
    expect(normalizeFailedReason(new Error('boom'))).toBe('boom');
  });

  it('never returns a non-string for an odd value', () => {
    expect(normalizeFailedReason({ code: 42 })).toBe('{"code":42}');
    expect(normalizeFailedReason(42)).toBe('42');
    expect(normalizeFailedReason(['a', 'b'])).toBe('["a","b"]');
  });

  it('leaves a message that merely looks like JSON alone', () => {
    expect(normalizeFailedReason('{not really json')).toBe('{not really json');
    expect(normalizeFailedReason('"unterminated')).toBe('"unterminated');
  });
});

describe('withTimeout', () => {
  it('resolves when the work finishes in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1_000, 'work')).resolves.toBe('ok');
  });

  it('rejects with the operation name when it does not', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5_000));
    await expect(withTimeout(slow, 20, 'redis ping')).rejects.toThrow(
      'redis ping timed out after 20ms',
    );
  });

  it('passes a rejection straight through', async () => {
    await expect(withTimeout(Promise.reject(new Error('nope')), 1_000, 'work')).rejects.toThrow(
      'nope',
    );
  });
});
