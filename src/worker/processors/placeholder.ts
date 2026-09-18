import type { TranscodeProcessor } from '../types.js';

/**
 * Milestone 4 stand-in for the real transcode (Milestone 5). It proves the plumbing: the worker
 * received the job, can reach the source object through storage, and reports progress. It
 * produces no renditions, so a video marked `ready` by this processor has nothing to play yet.
 */
export const placeholderProcessor: TranscodeProcessor = async ({
  video,
  storage,
  log,
  reportProgress,
}) => {
  if (!video.sourceKey) throw new Error(`video ${video.id} has no source file recorded`);
  const source = await storage.stat(video.sourceKey);
  if (!source) throw new Error(`source object ${video.sourceKey} not found in storage`);

  await reportProgress(50);
  log.info(
    { sourceKey: video.sourceKey, sizeBytes: source.size },
    'placeholder processor: source verified; FFmpeg transcode arrives in Milestone 5',
  );
  await reportProgress(100);
};
