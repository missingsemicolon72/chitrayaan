/** How far back the real-time check looks. */
export const REALTIME_WINDOW_MS = 10_000;
/** Below this share of real time, a stream is falling behind. */
export const BEHIND_RATIO = 0.9;
/** At or above this again, it has caught up. The gap stops the log flip-flopping. */
export const CAUGHT_UP_RATIO = 0.97;

/**
 * Compares how fast a live stream's media time advances with the wall clock. A publisher sends
 * in real time, so over a window the two match. When media time falls short, either the
 * publisher cannot send fast enough or FFmpeg cannot encode fast enough, and the stream drifts
 * further and further behind its source.
 */
export class RealtimeMonitor {
  private readonly samples: { wallMs: number; mediaSeconds: number }[] = [];

  /** Record a sample. Returns media seconds per wall-clock second once a full window is in. */
  add(wallMs: number, mediaSeconds: number): number | null {
    this.samples.push({ wallMs, mediaSeconds });
    // Drop old samples, keeping one at or before the window start so the window stays full.
    while (
      this.samples.length > 2 &&
      (this.samples[1]?.wallMs ?? 0) <= wallMs - REALTIME_WINDOW_MS
    ) {
      this.samples.shift();
    }
    const first = this.samples[0];
    if (first === undefined || wallMs - first.wallMs < REALTIME_WINDOW_MS) return null;
    return (mediaSeconds - first.mediaSeconds) / ((wallMs - first.wallMs) / 1000);
  }
}
