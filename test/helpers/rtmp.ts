import { spawn } from 'node:child_process';
import net from 'node:net';

import type { RtmpListener } from '../../src/lib/rtmp/index.js';
import { FFMPEG_PATH } from './ffmpeg.js';
import { waitFor } from './wait.js';

/** A TCP port nothing is listening on at the moment of asking. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** True when something already holds `port` on 127.0.0.1 (binding it fails). */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(false)));
  });
}

/**
 * Wait until the listener has spawned FFmpeg and FFmpeg has had time to bind. FFmpeg prints
 * nothing when it starts listening, and probing the port would use up its single accept, so
 * this allows a fixed grace period after the state change instead.
 */
export async function listenerReady(listener: RtmpListener, graceMs = 750): Promise<void> {
  await waitFor(
    async () => listener.status().state,
    (state) => state === 'listening',
  );
  await new Promise((resolve) => setTimeout(resolve, graceMs));
}

/**
 * FFmpeg's `-re` falls behind real time on Windows (FFmpeg 8 oversleeps between packets: a 12 s
 * clip takes ~20 s), which would make every test stream look slow. `-readrate_catchup` lets it
 * make up the lag; older FFmpeg builds lack the option and go without.
 */
const READRATE_CATCHUP: readonly string[] = await new Promise((resolve) => {
  const probe = spawn(
    FFMPEG_PATH,
    [
      ...['-hide_banner', '-loglevel', 'error', '-re', '-readrate_catchup', '2'],
      ...['-f', 'lavfi', '-i', 'nullsrc', '-t', '0.01', '-f', 'null', '-'],
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  probe.once('error', () => resolve([]));
  probe.once('close', (code) => resolve(code === 0 ? ['-readrate_catchup', '2'] : []));
});

export interface PublishOptions {
  port: number;
  streamKey: string;
  /** RTMP application; the listener only accepts `live`. */
  app?: string;
  seconds: number;
  /** Frame size, `WxH`. Defaults to 640x360. */
  size?: string;
}

export interface Publisher {
  /** Resolves when the publisher exits, with its exit code and the end of its stderr. */
  done: Promise<{ exitCode: number | null; stderr: string }>;
  kill: () => void;
}

/**
 * Publish a synthetic 30 fps H.264 + stereo AAC stream (640x360 unless `size` says otherwise) in
 * real time, the way OBS would.
 */
export function publish(options: PublishOptions): Publisher {
  const url = `rtmp://127.0.0.1:${options.port}/${options.app ?? 'live'}/${options.streamKey}`;
  const child = spawn(
    FFMPEG_PATH,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-re',
      ...READRATE_CATCHUP,
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${options.size ?? '640x360'}:rate=30`,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      String(options.seconds),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-g',
      '60',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-f',
      'flv',
      url,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-2_000);
  });
  const done = new Promise<{ exitCode: number | null; stderr: string }>((resolve) => {
    child.once('close', (exitCode) => resolve({ exitCode, stderr }));
  });
  return { done, kill: () => child.kill('SIGKILL') };
}
