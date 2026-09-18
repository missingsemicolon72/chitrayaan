import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { NewRendition } from '../../lib/db/index.js';
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
  H264_LADDER,
  planLadder,
  probe,
  ProbeError,
  runFfmpeg,
  type RenditionProfile,
} from '../../lib/transcode/index.js';
import type { TranscodeProcessor } from '../types.js';

export interface TranscodeProcessorOptions {
  ffmpegPath: string;
  ffprobePath: string;
  /** libx264 preset. */
  preset: string;
  /** Parent directory for per-job scratch space; defaults to the OS temp dir. */
  workDir?: string;
  /** Rungs to encode (capped at the source resolution). Defaults to the full H.264 ladder. */
  ladder?: readonly RenditionProfile[];
  /** Which master manifests to publish. Defaults to both. */
  formats?: readonly PackageFormat[];
}

/** Progress budget: probe 0-2, encoding 2-90, upload 90-99, bookkeeping 100. */
const ENCODE_START = 2;
const ENCODE_END = 90;
const UPLOAD_END = 99;

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
 * The real transcode: probe the source, encode the whole ladder in one FFmpeg pass packaged as
 * CMAF (shared fMP4 segments + DASH MPD + HLS playlists), upload everything under
 * `videos/<id>/`, and record the renditions and manifest keys.
 * Input problems (missing source, unreadable file, no video stream) are `UnrecoverableError`s
 * so the queue never retries them; encoder failures are ordinary errors.
 */
export function createTranscodeProcessor(options: TranscodeProcessorOptions): TranscodeProcessor {
  const ladder = options.ladder ?? H264_LADDER;
  const formats = options.formats ?? ['hls', 'dash'];

  return async ({ job, video, db, storage, log, reportProgress }) => {
    if (!video.sourceKey) throw new UnrecoverableError(`video ${video.id} has no source file`);
    const sourceKey = video.sourceKey;

    const workRoot = options.workDir ?? os.tmpdir();
    await mkdir(workRoot, { recursive: true });
    const workDir = await mkdtemp(path.join(workRoot, `chitrayaan-${job.id.slice(0, 8)}-`));
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

      const plans = planLadder(ladder, info);
      const outDir = path.join(workDir, 'out');
      await mkdir(outDir);
      const args = buildLadderArgs(sourcePath, plans, { preset: options.preset });
      log.info(
        {
          rungs: plans.map((p) => `${p.profile.name}@${p.width}x${p.height}`),
          audio: plans[0]?.includeAudio ?? false,
          preset: options.preset,
        },
        'encoding ladder',
      );

      const started = Date.now();
      const { stderrTail } = await runFfmpeg(args, {
        ffmpegPath: options.ffmpegPath,
        cwd: outDir,
        durationSeconds: info.durationSeconds,
        onProgress: (p) => {
          if (p.percent === null) return;
          const pct = ENCODE_START + ((ENCODE_END - ENCODE_START) * p.percent) / 100;
          reportProgress(pct).catch((err: unknown) => log.warn({ err }, 'progress update failed'));
        },
      });
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

      // A re-transcode must not leave stale files from a previous run behind.
      const prefix = `videos/${video.id}`;
      await storage.deletePrefix(`${prefix}/`);

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
      await db.videos.update(video.id, {
        hlsManifestKey: uploads.hlsMaster ? `${prefix}/${uploads.hlsMaster}` : null,
        dashManifestKey: uploads.dashManifest ? `${prefix}/${uploads.dashManifest}` : null,
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
        },
        'ladder stored',
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };
}
