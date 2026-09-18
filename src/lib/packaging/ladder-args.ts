import { GOP_SECONDS, SEGMENT_SECONDS } from '../transcode/profiles.js';
import type { RenditionPlan } from '../transcode/rendition.js';
import { DASH_MANIFEST, HLS_MASTER } from './layout.js';

export interface LadderEncodeOptions {
  /** libx264 preset. */
  preset: string;
  /** SVT-AV1 preset (0-13). Required only when a plan uses the av1 codec; defaults to 8. */
  av1Preset?: number;
}

/** Per-stream encoder flags for one rung. `i` is the output stream index. */
function codecArgs(i: number, plan: RenditionPlan, options: LadderEncodeOptions): string[] {
  const { profile } = plan;
  const kbps = (n: number) => `${n}k`;
  switch (profile.codec) {
    case 'h264':
      return [
        `-c:v:${i}`,
        'libx264',
        `-preset:v:${i}`,
        options.preset,
        `-profile:v:${i}`,
        'high',
        `-sc_threshold:v:${i}`,
        '0',
        `-b:v:${i}`,
        kbps(profile.videoBitrateKbps),
        `-maxrate:v:${i}`,
        kbps(profile.maxrateKbps),
        `-bufsize:v:${i}`,
        kbps(profile.bufsizeKbps),
      ];
    case 'av1':
      // SVT-AV1 (3.x) only accepts a max-bitrate cap in CRF mode and has no CBR for
      // random-access encoding, so AV1 rungs use plain target-bitrate VBR.
      return [
        `-c:v:${i}`,
        'libsvtav1',
        `-preset:v:${i}`,
        String(options.av1Preset ?? 8),
        `-b:v:${i}`,
        kbps(profile.videoBitrateKbps),
      ];
  }
}

/**
 * One FFmpeg invocation that decodes the source once, encodes every rung of every requested
 * codec ladder, and packages everything as CMAF (decision #9): fragmented-MP4 segments written
 * once, with both a DASH MPD and HLS playlists (master + one media playlist per stream)
 * generated over them.
 *
 * Output goes to the current working directory, so run with `cwd` = the output dir.
 * Video streams are mapped in the order of `plans`; the audio track (if any) comes last. Each
 * codec gets its own DASH adaptation set (players never switch codecs mid-stream); all video
 * streams share one keyframe clock so segments align across rungs and codecs.
 */
export function buildLadderArgs(
  sourcePath: string,
  plans: readonly RenditionPlan[],
  options: LadderEncodeOptions,
): string[] {
  const first = plans[0];
  if (!first) throw new Error('at least one rendition plan is required');
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

  // Shared keyframe clock for every video stream.
  args.push(
    '-g',
    String(gopFrames),
    '-keyint_min',
    String(gopFrames),
    '-force_key_frames',
    `expr:gte(t,n_forced*${GOP_SECONDS})`,
  );
  plans.forEach((plan, i) => args.push(...codecArgs(i, plan, options)));

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

  // One adaptation set per codec, in first-seen order, then audio.
  const byCodec = new Map<string, number[]>();
  plans.forEach((plan, i) => {
    const list = byCodec.get(plan.profile.codec) ?? [];
    list.push(i);
    byCodec.set(plan.profile.codec, list);
  });
  const sets = [...byCodec.values()].map((streams, id) => `id=${id},streams=${streams.join(',')}`);
  if (includeAudio) sets.push(`id=${sets.length},streams=${plans.length}`);

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
    sets.join(' '),
    '-hls_playlist',
    '1',
    '-hls_master_name',
    HLS_MASTER,
    DASH_MANIFEST,
  );
  return args;
}
