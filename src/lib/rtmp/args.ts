/** The RTMP application publishers connect to: `rtmp://<host>:<port>/live` plus the stream key. */
export const RTMP_APP = 'live';

/**
 * What FFmpeg does with an accepted stream when the caller asks for nothing else: demux it and
 * throw the packets away. That proves the stream arrives intact and keeps the progress counters
 * honest without producing anything.
 */
export const DISCARD_OUTPUT: readonly string[] = ['-c', 'copy', '-f', 'null', '-'];

export interface ListenerArgsOptions {
  host: string;
  port: number;
  streamKey: string;
  /** Seconds of silence after which FFmpeg drops a publisher, mid-handshake or mid-stream. */
  idleTimeoutSeconds: number;
  /** Seconds FFmpeg waits for a publisher before giving up, so a fresh listener can take over. */
  rearmSeconds: number;
  /** Output arguments: everything after the input. */
  output: readonly string[];
}

/** IPv6 literals need brackets inside a URL. */
function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** The URL FFmpeg listens on. It contains the stream key, so it is never logged. */
export function listenUrl(host: string, port: number, streamKey: string): string {
  return `rtmp://${urlHost(host)}:${port}/${RTMP_APP}/${streamKey}`;
}

/**
 * Arguments for one FFmpeg RTMP listener (decision #8: FFmpeg's own listener, no hand-rolled
 * RTMP). It accepts exactly one connection and exits when that connection ends, so the caller
 * spawns a fresh one to accept the next publisher.
 */
export function buildListenerArgs(options: ListenerArgsOptions): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    // Warnings must reach stderr: FFmpeg reports a wrong stream key or application name only as
    // a warning and accepts the stream anyway, so the caller enforces both by watching for them.
    '-loglevel',
    'level+info',
    '-nostats',
    '-progress',
    'pipe:1',
    // Bounds every read, so a client that connects and then goes quiet cannot hold the single
    // slot forever. It does not apply to the wait for a connection.
    '-rw_timeout',
    String(Math.round(options.idleTimeoutSeconds * 1_000_000)),
    // Bounds the wait for a connection instead. A listener whose parent was killed outright
    // (Task Manager, a watch-mode restart) is orphaned and would otherwise hold the port for
    // good; on Windows it can even share the port with its replacement and take its publishers.
    '-timeout',
    String(Math.max(1, Math.round(options.rearmSeconds))),
    '-f',
    'flv',
    '-listen',
    '1',
    '-i',
    listenUrl(options.host, options.port, options.streamKey),
    ...options.output,
  ];
}
