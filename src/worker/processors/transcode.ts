import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Codec, NewRendition } from '../../lib/db/index.js';
import { SUBTITLES_PREFIX } from '../../lib/features/subtitles/index.js';
import {
  generateThumbnails,
  THUMBNAIL_TRACK_FILE,
  THUMBNAILS_PREFIX,
} from '../../lib/features/thumbnails/index.js';
import type { WatermarkConfig } from '../../lib/features/watermark/index.js';
import type { Logger } from '../../lib/logger.js';
import {
  buildLadderArgs,
  chunkSegmentPattern,
  initSegmentName,
  mediaPlaylistName,
  parseMpd,
  selectUploads,
  type PackageFormat,
} from '../../lib/packaging/index.js';
import { UnrecoverableError } from '../../lib/queue/index.js';
import {
  contentTypeForKey,
  LocalDiskStorage,
  type ObjectStorage,
} from '../../lib/storage/index.js';
import {
  corruptInputReason,
  FfmpegError,
  LADDERS,
  planLadder,
  probe,
  ProbeError,
  runFfmpeg,
} from '../../lib/transcode/index.js';
import type { TranscodeProcessor } from '../types.js';

export interface TranscodeProcessorOptions {
  ffmpegPath: string;
  ffprobePath: string;
  /** libx264 preset. */
  preset: string;
  /** SVT-AV1 preset (0-13), used when `codecs` includes av1. Defaults to 8. */
  av1Preset?: number;
  /** Parent directory for per-job scratch space; defaults to the OS temp dir. */
  workDir?: string;
  /**
   * Codec ladders to encode (`CODEC_LADDER`): each codec's full ladder, capped at the source
   * resolution. Defaults to H.264 only.
   */
  codecs?: readonly Codec[];
  /** Which master manifests to publish. Defaults to both. */
  formats?: readonly PackageFormat[];
  /** Burn an overlay into every rung (FEATURE_WATERMARK). Off when omitted. */
  watermark?: WatermarkConfig;
  /** Produce scrubbing-preview sprites and a WebVTT track (FEATURE_THUMBNAILS). */
  thumbnails?: boolean;
  /** Kill FFmpeg and fail the job (without retrying) after this long. Defaults to 2 hours. */
  timeoutMs?: number;
}

/** Progress budget: probe 0-2, encoding 2-85, upload 85-93, thumbnails 93-99, bookkeeping 100. */
const ENCODE_START = 2;
const ENCODE_END = 85;
const UPLOAD_END = 93;
const THUMBNAIL_END = 99;

/**
 * Local storage exposes the source's real path, so the (possibly multi-GB) file is used in
 * place. Any other backend is downloaded into the work dir first.
 */
async function materializeSource(
  storage: ObjectStorage,
  sourceKey: string,
  workDir: string,
  log: Logger,
): Promise<string> {
  if (!(await storage.exists(sourceKey))) {
    throw new UnrecoverableError(`source object ${sourceKey} not found in storage`);
  }
  if (storage instanceof LocalDiskStorage) return storage.pathFor(sourceKey);
  const local = path.join(workDir, 'source');
  log.info({ sourceKey }, 'downloading source to work dir');
  await storage.downloadToFile(sourceKey, local);
  return local;
}

/**
 * Turn an FFmpeg failure into the right kind of error. A timeout or an input FFmpeg cannot read
 * will never succeed on a retry, so both become `UnrecoverableError`; anything else (a full
 * disk, a killed process, a transient fault) stays retryable.
 */
function encodeFailure(err: unknown, timedOut: boolean, timeoutMs: number): Error {
  if (timedOut) {
    const minutes = Math.round(timeoutMs / 60_000);
    return new UnrecoverableError(
      `transcode exceeded the ${minutes} minute limit and was stopped; raise TRANSCODE_TIMEOUT_MINUTES if this source is legitimately that long`,
    );
  }
  if (err instanceof FfmpegError) {
    const reason = corruptInputReason(err.stderrTail);
    if (reason !== null) return new UnrecoverableError(`source file is unusable: ${reason}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Remove a previous run's packaged output while keeping uploaded subtitle tracks, which are
 * independent of transcoding and would otherwise be lost on a re-transcode.
 */
async function clearPackagedOutput(storage: ObjectStorage, prefix: string): Promise<number> {
  const keep = `${prefix}/${SUBTITLES_PREFIX}/`;
  const objects = await storage.list(`${prefix}/`);
  let removed = 0;
  for (const object of objects) {
    if (object.key.startsWith(keep)) continue;
    await storage.delete(object.key);
    removed += 1;
  }
  return removed;
}

/**
 * The real transcode: probe the source, encode the whole ladder in one FFmpeg pass packaged as
 * CMAF (shared fMP4 segments + DASH MPD + HLS playlists), optionally burn in a watermark and
 * generate scrubbing sprites, upload everything under `videos/<id>/`, and record the
 * renditions and manifest keys.
 * Input problems (missing source, unreadable file, no video stream) are `UnrecoverableError`s
 * so the queue never retries them; encoder failures are ordinary errors.
 */
export function createTranscodeProcessor(options: TranscodeProcessorOptions): TranscodeProcessor {
  const codecs = options.codecs ?? ['h264'];
  const formats = options.formats ?? ['hls', 'dash'];
  const av1Preset = options.av1Preset ?? 8;
  const timeoutMs = options.timeoutMs ?? 120 * 60_000;

  return async ({ job, video, db, storage, log, reportProgress }) => {
    if (!video.sourceKey) throw new UnrecoverableError(`video ${video.id} has no source file`);
    const sourceKey = video.sourceKey;

    const workRoot = options.workDir ?? os.tmpdir();
    await mkdir(workRoot, { recursive: true });
    const workDir = await mkdtemp(path.join(workRoot, `chitrayaan-${job.id.slice(0, 8)}-`));
    // One deadline for the whole job: a hung FFmpeg is killed rather than holding the worker.
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      const sourcePath = await materializeSource(storage, sourceKey, workDir, log);

      let info;
      try {
        info = await probe(sourcePath, { ffprobePath: options.ffprobePath });
      } catch (err) {
        if (err instanceof ProbeError) {
          throw new UnrecoverableError(`unreadable source: ${err.message}`);
        }
        throw err;
      }
      if (!info.hasVideo) throw new UnrecoverableError('source has no video stream');
      await db.videos.update(video.id, {
        durationSeconds: info.durationSeconds,
        width: info.width,
        height: info.height,
      });
      log.info(
        {
          format: info.formatName,
          durationSeconds: info.durationSeconds,
          width: info.width,
          height: info.height,
          frameRate: info.frameRate,
          videoCodec: info.videoCodec,
          audioCodec: info.audioCodec,
        },
        'source probed',
      );
      await reportProgress(ENCODE_START);

      // H.264 rungs first, then any opt-in codec's rungs, so stream numbering stays stable.
      const plans = codecs.flatMap((codec) => planLadder(LADDERS[codec], info));
      const outDir = path.join(workDir, 'out');
      await mkdir(outDir);
      const args = buildLadderArgs(sourcePath, plans, {
        preset: options.preset,
        av1Preset,
        ...(options.watermark ? { watermark: options.watermark } : {}),
      });
      log.info(
        {
          rungs: plans.map((p) => `${p.profile.name}@${p.width}x${p.height}`),
          audio: plans[0]?.includeAudio ?? false,
          preset: options.preset,
          ...(codecs.includes('av1') ? { av1Preset } : {}),
          ...(options.watermark
            ? {
                watermark: {
                  position: options.watermark.position,
                  opacity: options.watermark.opacity,
                },
              }
            : {}),
        },
        'encoding ladder',
      );

      const started = Date.now();
      let stderrTail: string;
      try {
        ({ stderrTail } = await runFfmpeg(args, {
          ffmpegPath: options.ffmpegPath,
          cwd: outDir,
          durationSeconds: info.durationSeconds,
          signal: deadline,
          onProgress: (p) => {
            if (p.percent === null) return;
            const pct = ENCODE_START + ((ENCODE_END - ENCODE_START) * p.percent) / 100;
            reportProgress(pct).catch((err: unknown) =>
              log.warn({ err }, 'progress update failed'),
            );
          },
        }));
      } catch (err) {
        throw encodeFailure(err, deadline.aborted, timeoutMs);
      }
      if (stderrTail) log.warn({ stderrTail }, 'ffmpeg warnings');
      log.info({ encodeSeconds: Math.round((Date.now() - started) / 100) / 10 }, 'ladder encoded');

      // Sanity-check the packaging before publishing anything.
      const files = (await readdir(outDir)).sort();
      const mpd = parseMpd(await readFile(path.join(outDir, 'master.mpd'), 'utf8'));
      const videoReps = mpd.representations.filter((r) => r.contentType === 'video');
      if (videoReps.length !== plans.length) {
        throw new Error(
          `packaging produced ${videoReps.length} video representations, expected ${plans.length}`,
        );
      }
      for (const [i] of plans.entries()) {
        for (const required of [initSegmentName(i), mediaPlaylistName(i)]) {
          if (!files.includes(required)) throw new Error(`packaging did not produce ${required}`);
        }
        if (!files.some((f) => chunkSegmentPattern(i).test(f))) {
          throw new Error(`packaging produced no media segments for stream ${i}`);
        }
      }

      // A re-transcode must not leave stale files behind, but uploaded subtitles survive.
      const prefix = `videos/${video.id}`;
      await clearPackagedOutput(storage, prefix);

      const uploads = selectUploads(files, formats);
      const sizes = new Map<string, number>();
      for (const [n, file] of uploads.files.entries()) {
        const local = path.join(outDir, file);
        sizes.set(file, (await stat(local)).size);
        await storage.putFile(`${prefix}/${file}`, local, { contentType: contentTypeForKey(file) });
        if (n % 10 === 0) {
          await reportProgress(ENCODE_END + ((UPLOAD_END - ENCODE_END) * n) / uploads.files.length);
        }
      }

      const renditions: NewRendition[] = plans.map((plan, i) => {
        const own = files.filter((f) => f === initSegmentName(i) || chunkSegmentPattern(i).test(f));
        return {
          videoId: video.id,
          name: plan.profile.name,
          codec: plan.profile.codec,
          width: plan.width,
          height: plan.height,
          videoBitrateKbps: plan.profile.videoBitrateKbps,
          audioBitrateKbps: plan.includeAudio ? plan.profile.audioBitrateKbps : null,
          playlistKey: `${prefix}/${mediaPlaylistName(i)}`,
          segmentCount: own.filter((f) => f !== initSegmentName(i)).length,
          sizeBytes: own.reduce((sum, f) => sum + (sizes.get(f) ?? 0), 0),
          durationSeconds: info.durationSeconds,
        };
      });
      await db.renditions.replaceForVideo(video.id, renditions);
      await reportProgress(UPLOAD_END);

      // Scrubbing previews (FEATURE_THUMBNAILS). A failure here must not lose the transcode,
      // so it is logged and the video still goes ready without a thumbnail track.
      let thumbnailTrackKey: string | null = null;
      let thumbnailSpriteCount: number | null = null;
      if (options.thumbnails) {
        try {
          const thumbs = await generateThumbnails({
            ffmpegPath: options.ffmpegPath,
            ffprobePath: options.ffprobePath,
            sourcePath,
            workDir,
            durationSeconds: info.durationSeconds,
            signal: deadline,
            log,
          });
          for (const file of thumbs.files) {
            await storage.putFile(
              `${prefix}/${THUMBNAILS_PREFIX}/${file}`,
              path.join(thumbs.outputDir, file),
              { contentType: contentTypeForKey(file) },
            );
          }
          thumbnailTrackKey = `${prefix}/${THUMBNAILS_PREFIX}/${THUMBNAIL_TRACK_FILE}`;
          thumbnailSpriteCount = thumbs.spriteCount;
        } catch (err) {
          log.error({ err }, 'thumbnail generation failed; continuing without a preview track');
        }
        await reportProgress(THUMBNAIL_END);
      }

      await db.videos.update(video.id, {
        hlsManifestKey: uploads.hlsMaster ? `${prefix}/${uploads.hlsMaster}` : null,
        dashManifestKey: uploads.dashManifest ? `${prefix}/${uploads.dashManifest}` : null,
        thumbnailTrackKey,
        thumbnailSpriteCount,
      });
      await reportProgress(100);
      log.info(
        {
          renditions: renditions.map(
            (r) => `${r.name} ${r.width}x${r.height} ${r.segmentCount}seg`,
          ),
          files: uploads.files.length,
          hls: uploads.hlsMaster !== null,
          dash: uploads.dashManifest !== null,
          thumbnails: thumbnailSpriteCount,
        },
        'ladder stored',
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };
}
