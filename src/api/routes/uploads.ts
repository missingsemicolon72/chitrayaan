import { randomUUID } from 'node:crypto';

import { Server as TusServer } from '@tus/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createTusDatastore, sourceKeyForUpload } from '../../lib/storage/tus-store.js';

export const UPLOADS_PATH = '/api/uploads';
export const TUS_CONTENT_TYPE = 'application/offset+octet-stream';

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

  const tus = new TusServer({
    path: UPLOADS_PATH,
    datastore: createTusDatastore(storage),
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
