import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UnrecoverableError } from '../../src/lib/queue/index.js';
import { createTranscodeProcessor } from '../../src/worker/processors/transcode.js';
import type { ProcessorContext } from '../../src/worker/types.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { FFMPEG_PATH, FFPROBE_PATH, ffmpegAvailable, fixturePath } from '../helpers/ffmpeg.js';

const FFMPEG = await ffmpegAvailable();
const silent = pino({ level: 'silent' });

/**
 * Every way a source file can be unusable. The processor is driven directly (no queue), because
 * what matters here is the kind of error it raises: `UnrecoverableError` tells the queue not to
 * waste retries on input that will never encode.
 */
describe.skipIf(!FFMPEG)('unusable source files', () => {
  let t: TestApp;

  const processor = () =>
    createTranscodeProcessor({
      ffmpegPath: FFMPEG_PATH,
      ffprobePath: FFPROBE_PATH,
      preset: 'ultrafast',
    });

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  /** Store `fixture` as a video's source and run the transcode, returning whatever it threw. */
  async function attempt(
    id: string,
    fixture: string | null,
    overrides: { ffmpegPath?: string } = {},
  ): Promise<unknown> {
    const sourceKey = `uploads/${id}`;
    if (fixture) await t.app.storage.putFile(sourceKey, fixturePath(fixture));
    const video = await t.app.db.videos.create({
      id,
      status: 'uploaded',
      ...(fixture === null ? {} : { sourceKey }),
    });
    const job = await t.app.db.jobs.create({ videoId: video.id });
    const context: ProcessorContext = {
      job,
      video: (await t.app.db.videos.get(video.id))!,
      db: t.app.db,
      storage: t.app.storage,
      log: silent,
      reportProgress: () => Promise.resolve(),
    };
    const run = overrides.ffmpegPath
      ? createTranscodeProcessor({
          ffmpegPath: overrides.ffmpegPath,
          ffprobePath: FFPROBE_PATH,
          preset: 'ultrafast',
        })
      : processor();
    return run(context).then(
      () => new Error('expected the transcode to fail'),
      (err: unknown) => err,
    );
  }

  it('rejects files that are not media at all', async () => {
    for (const [id, fixture] of [
      ['bad-text', 'not-a-video.mp4'],
      ['bad-empty', 'empty.mp4'],
    ] as const) {
      const err = await attempt(id, fixture);
      expect(err, fixture).toBeInstanceOf(UnrecoverableError);
      expect((err as Error).message, fixture).toMatch(/unreadable source/);
    }
  }, 60_000);

  it('rejects a container with no frames and no duration', async () => {
    const err = await attempt('bad-zero-frames', 'zero-frames.mp4');
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toMatch(/duration/);
  }, 60_000);

  it('rejects an audio-only file', async () => {
    const err = await attempt('bad-audio-only', 'audio-only.m4a');
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toMatch(/no video stream/);
  }, 60_000);

  it('rejects a truncated file that probes cleanly but will not decode', async () => {
    // ffprobe reports a full 10s stream; the encode is where it falls apart, so this is the
    // case the stderr classification exists for.
    const err = await attempt('bad-truncated', 'truncated.mp4');
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toMatch(/source file is unusable/i);
    expect((err as Error).message).toMatch(/NAL unit|Invalid data|splitting the input/i);
    // Nothing half-packaged is left behind for a player to find.
    expect(await t.app.storage.list('videos/bad-truncated/')).toEqual([]);
  }, 120_000);

  it('rejects a video whose source object is missing or never recorded', async () => {
    const missing = await attempt('bad-missing-object', null);
    expect(missing).toBeInstanceOf(UnrecoverableError);
    expect((missing as Error).message).toMatch(/has no source file/);

    const gone = await t.app.db.videos.create({
      id: 'bad-deleted-object',
      status: 'uploaded',
      sourceKey: 'uploads/bad-deleted-object',
    });
    const job = await t.app.db.jobs.create({ videoId: gone.id });
    const err = await processor()({
      job,
      video: gone,
      db: t.app.db,
      storage: t.app.storage,
      log: silent,
      reportProgress: () => Promise.resolve(),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toMatch(/not found in storage/);
  }, 60_000);

  it('keeps infrastructure failures retryable rather than calling them bad input', async () => {
    const err = await attempt('bad-no-ffmpeg', '480p-5s.mp4', {
      ffmpegPath: 'definitely-not-ffmpeg-xyz',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toMatch(/could not start ffmpeg/);
  }, 60_000);
});
