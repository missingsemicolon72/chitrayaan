import { GOP_SECONDS, SEGMENT_SECONDS } from '../transcode/profiles.js';
import type { RenditionPlan } from '../transcode/rendition.js';
import { DASH_MANIFEST, HLS_MASTER } from './layout.js';

export interface LadderEncodeOptions {
  /** libx264 preset. */
  preset: string;
}

/**
 * One FFmpeg invocation that decodes the source once, encodes every rung of the ladder, and
 * packages everything as CMAF (decision #9): fragmented-MP4 segments written once, with both a
 * DASH MPD and HLS playlists (master + one media playlist per stream) generated over them.
 *
 * Output goes to the current working directory, so run with `cwd` = the output dir.
 * Video streams are mapped in the order of `plans`; the audio track (if any) comes last.
 */
export function buildLadderArgs(
  sourcePath: string,
  plans: readonly RenditionPlan[],
  options: LadderEncodeOptions,
): string[] {
  const first = plans[0];
  if (!first) throw new Error('at least one rendition plan is required');
  if (plans.some((p) => p.profile.codec !== 'h264')) {
    throw new Error('only h264 rungs are supported yet (AV1 arrives in Milestone 8)');
  }
  const includeAudio = first.includeAudio;
  const gopFrames = Math.max(1, Math.round(GOP_SECONDS * first.frameRate));

  const scaled = (i: number, plan: RenditionPlan, input: string) =>
    `${input}scale=${plan.width}:${plan.height},format=yuv420p[v${i}]`;
  const graph =
    plans.length === 1
      ? scaled(0, first, '[0:v]')
      : [
          `[0:v]split=${plans.length}${plans.map((_, i) => `[s${i}]`).join('')}`,
          ...plans.map((plan, i) => scaled(i, plan, `[s${i}]`)),
        ].join(';');

  const args = ['-y', '-i', sourcePath, '-filter_complex', graph];
  for (let i = 0; i < plans.length; i += 1) args.push('-map', `[v${i}]`);
  if (includeAudio) args.push('-map', '0:a:0');

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    options.preset,
    '-profile:v',
    'high',
    '-g',
    String(gopFrames),
    '-keyint_min',
    String(gopFrames),
    '-sc_threshold',
    '0',
    '-force_key_frames',
    `expr:gte(t,n_forced*${GOP_SECONDS})`,
  );
  plans.forEach((plan, i) => {
    args.push(
      `-b:v:${i}`,
      `${plan.profile.videoBitrateKbps}k`,
      `-maxrate:v:${i}`,
      `${plan.profile.maxrateKbps}k`,
      `-bufsize:v:${i}`,
      `${plan.profile.bufsizeKbps}k`,
    );
  });

  if (includeAudio) {
    args.push(
      '-c:a',
      'aac',
      '-b:a',
      `${first.profile.audioBitrateKbps}k`,
      '-ar',
      String(first.profile.audioSampleRate),
      '-ac',
      String(first.profile.audioChannels),
    );
  }

  args.push(
    '-f',
    'dash',
    '-seg_duration',
    String(SEGMENT_SECONDS),
    '-use_template',
    '1',
    '-use_timeline',
    '1',
    '-dash_segment_type',
    'mp4',
    '-streaming',
    '0',
    '-window_size',
    '0',
    '-adaptation_sets',
    includeAudio ? 'id=0,streams=v id=1,streams=a' : 'id=0,streams=v',
    '-hls_playlist',
    '1',
    '-hls_master_name',
    HLS_MASTER,
    DASH_MANIFEST,
  );
  return args;
}
