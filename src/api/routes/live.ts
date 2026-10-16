import type { FastifyInstance } from 'fastify';

import { isLiveFileName, LIVE_PLAYLIST, liveKey } from '../../lib/packaging/index.js';
import { notFound, readStoredText, sendStoredObject } from '../serve.js';

/** Session ids are UUIDs minted by the live process. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Live HLS, read from storage where the live process publishes it (decision #21: the API never
 * talks to the live process itself): `/api/live/<session id>/live.m3u8` and the init and media
 * segments it lists.
 */
export async function liveRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string; file: string } }>(
    '/api/live/:id/:file',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, file: { type: 'string' } },
          required: ['id', 'file'],
        },
      },
    },
    async (request, reply) => {
      const { id, file } = request.params;
      if (!SESSION_ID.test(id) || !isLiveFileName(file)) {
        return reply.code(404).send(notFound('no such file'));
      }
      if (file !== LIVE_PLAYLIST) return sendStoredObject(app, reply, liveKey(id, file));

      // The playlist is rewritten every segment, so it is read whole (its length can change
      // between a stat and a read) and must never be cached.
      const playlist = await readStoredText(app.storage, liveKey(id, file));
      if (playlist === null) return reply.code(404).send(notFound('no such live session'));
      return reply
        .type('application/vnd.apple.mpegurl')
        .header('cache-control', 'no-cache')
        .send(playlist);
    },
  );
}
