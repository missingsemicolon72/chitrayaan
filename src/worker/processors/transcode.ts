import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { NewRendition } from '../../lib/db/index.js';
import type { Logger } from '../../lib/logger.js';
import { UnrecoverableError } from '../../lib/queue/index.js';
import {
  contentTypeForKey,
  LocalDiskStorage,
  type ObjectStorage,
} from '../../lib/storage/index.js';
import {
  buildRenditionArgs,
  H264_720P,
  planRendition,
  PLAYLIST_FILE,
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
  /** Renditions to produce. Milestone 5: the single 720p rung. */
  profiles?: readonly RenditionProfile[];
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
 * The real transcode: probe the source, encode each profile as CMAF (fMP4 segments + HLS media
 * playlist), upload the outputs under `videos/<id>/<rendition>/`, and record the renditions.
 * Input problems (missing source, unreadable file, no video stream) are `UnrecoverableError`s
 * so the queue never retries them; encoder failures are ordinary errors.
 */
export function createTranscodeProcessor(options: TranscodeProcessorOptions): TranscodeProcessor {
  const profiles = options.profiles ?? [H264_720P];

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
        if (err instanceof ProbeError)
          throw new UnrecoverableError(`unreadable source: ${err.message}`);
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
          videoCodec: info.videoCodec,
          audioCodec: info.audioCodec,
        },
        'source probed',
      );
      await reportProgress(ENCODE_START);

      // A re-transcode must not leave stale segments from a previous run behind.
      await storage.deletePrefix(`videos/${video.id}/`);

      const renditions: NewRendition[] = [];
      const encodeSpan = (ENCODE_END - ENCODE_START) / profiles.length;
      for (const [index, profile] of profiles.entries()) {
        const outDir = path.join(workDir, profile.name);
        await mkdir(outDir);
        const plan = planRendition(profile, info);
        const args = buildRenditionArgs(sourcePath, plan, { preset: options.preset });
        log.info(
          {
            rendition: profile.name,
            width: plan.width,
            height: plan.height,
            preset: options.preset,
          },
          'encoding rendition',
        );

        const started = Date.now();
        const { stderrTail } = await runFfmpeg(args, {
          ffmpegPath: options.ffmpegPath,
          cwd: outDir,
          durationSeconds: info.durationSeconds,
          onProgress: (p) => {
            if (p.percent === null) return;
            const pct = ENCODE_START + encodeSpan * (index + p.percent / 100);
            reportProgress(pct).catch((err: unknown) =>
              log.warn({ err }, 'progress update failed'),
            );
          },
        });
        if (stderrTail) log.warn({ rendition: profile.name, stderrTail }, 'ffmpeg warnings');
        log.info(
          { rendition: profile.name, encodeSeconds: Math.round((Date.now() - started) / 100) / 10 },
          'rendition encoded',
        );

        const prefix = `videos/${video.id}/${profile.name}`;
        let sizeBytes = 0;
        let segmentCount = 0;
        const files = (await readdir(outDir)).sort();
        for (const file of files) {
          const local = path.join(outDir, file);
          sizeBytes += (await stat(local)).size;
          if (file.endsWith('.m4s')) segmentCount += 1;
          await storage.putFile(`${prefix}/${file}`, local, {
            contentType: contentTypeForKey(file),
          });
        }
        renditions.push({
          videoId: video.id,
          name: profile.name,
          codec: profile.codec,
          width: plan.width,
          height: plan.height,
          videoBitrateKbps: profile.videoBitrateKbps,
          audioBitrateKbps: plan.includeAudio ? profile.audioBitrateKbps : null,
          playlistKey: `${prefix}/${PLAYLIST_FILE}`,
          segmentCount,
          sizeBytes,
          durationSeconds: info.durationSeconds,
        });
        await reportProgress(
          ENCODE_END + ((UPLOAD_END - ENCODE_END) * (index + 1)) / profiles.length,
        );
        log.info({ rendition: profile.name, files: files.length, sizeBytes }, 'rendition stored');
      }

      await db.renditions.replaceForVideo(video.id, renditions);
      await reportProgress(100);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };
}
