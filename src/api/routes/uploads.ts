import { randomUUID } from 'node:crypto';

import { Server as TusServer } from '@tus/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createTusDatastore, sourceKeyForUpload } from '../../lib/storage/tus-store.js';

export const UPLOADS_PATH = '/api/uploads';
export const TUS_CONTENT_TYPE = 'application/offset+octet-stream';

/** Paging for the stale-upload sweep, and a ceiling so one pass cannot run away. */
const SWEEP_PAGE = 200;
const MAX_SWEEP_ROWS = 2_000;

export interface UploadSweepResult {
  /** Abandoned partial uploads deleted from storage. */
  uploads: number;
  /** Placeholder video records removed with them. */
  videos: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    sweepExpiredUploads: () => Promise<UploadSweepResult>;
  }
}

/** Thrown from tus hooks; `@tus/server` turns `status_code` + `body` into the client response. */
class UploadRejectedError extends Error {
  constructor(
    public readonly status_code: number,
    public readonly body: string,
  ) {
    super(body);
    this.name = 'UploadRejectedError';
  }
}

/**
 * Resumable uploads via the tus protocol (decision #14), served by `@tus/server` behind Fastify.
 *
 * Lifecycle:
 *  - `POST /api/uploads` creates an upload; we create a `videos` row (status `uploading`) whose id
 *    is the tus upload id, so the `Location` the client gets back is also the video id.
 *  - `PATCH` appends bytes; `HEAD` reports the offset a client should resume from.
 *  - On the final byte we mark the video `uploaded`, point `sourceKey` at the stored file, and
 *    record a queued `transcode` job. Milestone 4 hands that job to BullMQ.
 *  - `DELETE` (tus termination) is allowed only for unfinished uploads and removes the video row.
 */
export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  const { config, db, storage } = app;
  const expiryMs = config.UPLOAD_EXPIRY_HOURS * 60 * 60 * 1000;

  const datastore = createTusDatastore(storage);
  const tus = new TusServer({
    path: UPLOADS_PATH,
    datastore,
    maxSize: config.TUS_UPLOAD_MAX_SIZE_MB * 1024 * 1024,
    relativeLocation: true,
    respectForwardedHeaders: false,
    disableTerminationForFinishedUploads: true,
    namingFunction: () => randomUUID(),

    async onUploadCreate(_req, upload) {
      const metadata = upload.metadata ?? {};
      const filename = metadata.filename ?? null;
      await db.videos.create({
        id: upload.id,
        title: metadata.title ?? filename,
        originalFilename: filename,
        sizeBytes: upload.size ?? null,
        status: 'uploading',
      });
      app.log.info({ videoId: upload.id, sizeBytes: upload.size, filename }, 'upload created');
      return {};
    },

    async onUploadFinish(_req, upload) {
      const sourceKey = sourceKeyForUpload(upload.id);
      const video = await db.videos.update(upload.id, {
        status: 'uploaded',
        sourceKey,
        sizeBytes: upload.size ?? upload.offset,
      });
      if (!video) {
        throw new UploadRejectedError(500, 'video record for this upload no longer exists');
      }
      const job = await db.jobs.create({ videoId: upload.id, type: 'transcode', status: 'queued' });
      app.log.info(
        { videoId: upload.id, jobId: job.id, sourceKey, sizeBytes: video.sizeBytes },
        'upload complete, transcode job recorded',
      );

      // Best effort: if Redis is down the job stays `queued` in the database and startup
      // reconciliation hands it over later. The upload itself has already succeeded.
      try {
        const queueJobId = await app.queue.enqueue(job);
        await db.jobs.update(job.id, { queueJobId });
      } catch (err) {
        app.log.error(
          { err, jobId: job.id },
          'could not enqueue transcode job; left for reconciliation',
        );
      }
      return {};
    },

    onResponseError(_req, err) {
      if (err instanceof Error && !(err instanceof UploadRejectedError)) {
        app.log.error(err, 'tus request failed');
      }
      return undefined;
    },
  });

  /**
   * Drop uploads that were started and abandoned. Only videos still in `uploading` are
   * considered, so an upload that finished keeps its source however old it is, and a partial
   * file that was written to recently is left alone because a client may still be resuming it.
   */
  app.decorate('sweepExpiredUploads', async () => {
    if (expiryMs <= 0) return { uploads: 0, videos: 0 };

    const cutoff = new Date(Date.now() - expiryMs);
    const candidates: string[] = [];
    for (let offset = 0; offset < MAX_SWEEP_ROWS; offset += SWEEP_PAGE) {
      const page = await db.videos.list({ status: 'uploading', limit: SWEEP_PAGE, offset });
      for (const video of page.items) {
        if (new Date(video.createdAt) <= cutoff) candidates.push(video.id);
      }
      if (offset + page.items.length >= page.total) break;
    }

    let uploads = 0;
    let videos = 0;
    for (const id of candidates) {
      const partial = await storage.stat(sourceKeyForUpload(id));
      // Still being written to? The client is mid-upload, however old the record is.
      if (partial && partial.lastModified > cutoff) continue;
      if (partial) {
        try {
          // The usual path: removes the partial payload and tus's sidecar metadata together.
          await datastore.remove(id);
        } catch (err) {
          app.log.debug({ err, videoId: id }, 'tus had no record of this upload; deleting bytes');
        }
        // Belt and braces: the payload must go even if tus lost track of it.
        await storage.delete(sourceKeyForUpload(id));
        await storage.delete(`${sourceKeyForUpload(id)}.json`);
        uploads += 1;
      }
      await db.videos.delete(id);
      videos += 1;
    }
    if (uploads > 0 || videos > 0) app.log.info({ uploads, videos }, 'swept abandoned uploads');
    return { uploads, videos };
  });

  // tus streams the PATCH body itself; tell Fastify not to buffer or parse it.
  app.addContentTypeParser(TUS_CONTENT_TYPE, (_request, _payload, done) => {
    done(null);
  });

  const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.hijack();
    await tus.handle(request.raw, reply.raw);
  };

  app.route({ method: ['POST', 'OPTIONS'], url: UPLOADS_PATH, handler: handle });
  app.route({
    method: ['HEAD', 'PATCH', 'DELETE', 'OPTIONS'],
    url: `${UPLOADS_PATH}/:id`,
    handler: async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      await handle(request, reply);
      // Termination succeeded: the bytes are gone, so drop the placeholder video row too.
      if (request.method === 'DELETE' && reply.raw.statusCode === 204) {
        await db.videos.delete(request.params.id);
        app.log.info({ videoId: request.params.id }, 'upload terminated, video record removed');
      }
    },
  });
}
