import { describe, expect, it } from 'vitest';

import {
  buildListenerArgs,
  DISCARD_OUTPUT,
  ListenerOutputParser,
  MAX_RETRY_DELAY_MS,
  redact,
  retryDelayMs,
  type ListenerEvent,
} from '../../src/lib/rtmp/index.js';

function feedAll(lines: readonly string[]): ListenerEvent[] {
  const parser = new ListenerOutputParser();
  return lines.map((line) => parser.feed(line)).filter((event) => event !== null);
}

/** What FFmpeg 8 printed for a real publish to the listener (key already redacted). */
const SESSION_START = [
  "[info] Input #0, flv, from 'rtmp://127.0.0.1:19350/live/***':",
  '[info]   Metadata:',
  '[info]     encoder         : Lavf62.4.101',
  '[info]   Duration: 00:00:04.00, start: 0.000000, bitrate: N/A',
  '[info]   Stream #0:0: Video: h264 (Constrained Baseline), yuv420p(progressive), 640x360 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr, 1k tbn, start 0.021000',
  '[info]   Stream #0:1: Audio: aac (LC), 48000 Hz, mono, fltp, 69 kb/s',
  '[info] Stream mapping:',
  '[info]   Stream #0:0 -> #0:0 (copy)',
  "[info] Output #0, null, to 'pipe:':",
  '[info]   Stream #0:0: Video: mpeg4, yuv420p, 320x240, q=2-31, 25 fps',
];

describe('buildListenerArgs', () => {
  const base = {
    host: '127.0.0.1',
    port: 1935,
    streamKey: 'the-stream-key-123',
    idleTimeoutSeconds: 10,
    rearmSeconds: 30,
    output: DISCARD_OUTPUT,
  };

  it('listens for one FLV publisher on /live/<key> and bounds both reads and the wait', () => {
    const args = buildListenerArgs(base);
    const input = args.indexOf('-i');

    expect(args.slice(input - 4, input + 2)).toEqual([
      '-f',
      'flv',
      '-listen',
      '1',
      '-i',
      'rtmp://127.0.0.1:1935/live/the-stream-key-123',
    ]);
    // rw_timeout is in microseconds; the RTMP listen timeout is in seconds.
    expect(args[args.indexOf('-rw_timeout') + 1]).toBe('10000000');
    expect(args[args.indexOf('-timeout') + 1]).toBe('30');
    expect(args.slice(input + 2)).toEqual([...DISCARD_OUTPUT]);
  });

  it('keeps warnings on stderr, since key and app mismatches are only warnings', () => {
    const args = buildListenerArgs(base);
    expect(args[args.indexOf('-loglevel') + 1]).toBe('level+info');
    expect(args[args.indexOf('-progress') + 1]).toBe('pipe:1');
  });

  it('brackets an IPv6 bind address', () => {
    const args = buildListenerArgs({ ...base, host: '::' });
    expect(args).toContain('rtmp://[::]:1935/live/the-stream-key-123');
  });
});

describe('ListenerOutputParser', () => {
  it('describes the input once its block ends, ignoring the output block', () => {
    expect(feedAll(SESSION_START)).toEqual([
      {
        kind: 'input',
        info: {
          video: { codec: 'h264', width: 640, height: 360, fps: 30 },
          audio: { codec: 'aac', sampleRate: 48000, channels: 'mono' },
        },
      },
    ]);
  });

  it('reads what OBS typically sends', () => {
    const events = feedAll([
      "[info] Input #0, flv, from 'rtmp://0.0.0.0:1935/live/***':",
      '[info]   Metadata:',
      '[info]     encoder         : obs-output module (libobs version 31.0.2)',
      '[info]   Stream #0:0: Video: h264 (High), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 6000 kb/s, 59.94 fps, 59.94 tbr, 1k tbn',
      '[info]   Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp, 160 kb/s',
      '[info] Stream mapping:',
    ]);
    expect(events).toEqual([
      {
        kind: 'input',
        info: {
          video: { codec: 'h264', width: 1920, height: 1080, fps: 59.94 },
          audio: { codec: 'aac', sampleRate: 48000, channels: 'stereo' },
        },
      },
    ]);
  });

  it('reports a stream without video or audio as null rather than guessing', () => {
    const events = feedAll([
      "[info] Input #0, flv, from 'rtmp://0.0.0.0:1935/live/***':",
      '[info]   Stream #0:0: Audio: aac (LC), 44100 Hz, stereo, fltp, 128 kb/s',
      '[info] Stream mapping:',
    ]);
    expect(events).toEqual([
      {
        kind: 'input',
        info: { video: null, audio: { codec: 'aac', sampleRate: 44100, channels: 'stereo' } },
      },
    ]);
  });

  it('flags a wrong stream key and a wrong application', () => {
    expect(
      feedAll(['[rtmp @ 000001a4088a0500] [warning] Unexpected stream WRONG, expecting ***']),
    ).toEqual([{ kind: 'rejected', reason: 'stream-key' }]);
    expect(
      feedAll(["[rtmp @ 0000012bf9e2a180] [warning] App field don't match up: other <-> live"]),
    ).toEqual([{ kind: 'rejected', reason: 'app' }]);
  });

  it('flags a listen that accepted nothing, but not a failed handshake', () => {
    // FFmpeg prints the same line for a port it could not bind and for a wait that timed out.
    expect(
      feedAll([
        '[rtmp @ 0000029f1503ce40] [error] Cannot open connection tcp://127.0.0.1:19350?listen&listen_timeout=30000&tcp_nodelay=0',
      ]),
    ).toEqual([{ kind: 'listen-failed' }]);
    expect(
      feedAll([
        '[rtmp @ 000001949a030780] [error] Unable to read handshake',
        '[in#0 @ 000001949a03ce80] [error] Error opening input: I/O error',
      ]),
    ).toEqual([]);
  });
});

describe('redact', () => {
  it('replaces every occurrence of the secret', () => {
    expect(redact('rtmp://h/live/s3cret and s3cret again', 's3cret')).toBe(
      'rtmp://h/live/*** and *** again',
    );
    expect(redact('nothing here', 's3cret')).toBe('nothing here');
  });
});

describe('retryDelayMs', () => {
  it('retries at once after one failure, then doubles up to a ceiling', () => {
    expect([0, 1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([0, 0, 250, 500, 1000, 2000]);
    expect(retryDelayMs(50)).toBe(MAX_RETRY_DELAY_MS);
  });
});
