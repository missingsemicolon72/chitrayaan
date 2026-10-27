import type { FastifyInstance } from 'fastify';

import {
  ActiveLiveStreamError,
  LIVE_STREAM_STATUSES,
  type LiveStream,
  type LiveStreamStatus,
} from '../../lib/db/index.js';
import { isLiveFileName, LIVE_PLAYLIST, liveKey } from '../../lib/packaging/index.js';
import { notFound, readStoredText, sendStoredObject } from '../serve.js';

/** Stream ids are UUIDs minted by the database layer. */
const STREAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The live process reports every 5 s; silence for this long means it is not running. */
export const INGEST_STALE_MS = 15_000;
/** How long a stop waits for the live process to end a live stream before answering 202. */
export const STOP_WAIT_MS = 10_000;

export interface IngestView {
  /** The live process is running and can serve a stream. */
  online: boolean;
  /** Its last reported state (`idle`, `listening`, `live`, `restarting`, `ending`) or `offline`. */
  state: string;
  /** Why it cannot listen for publishers, while that is the case. */
  error: string | null;
  reportedAt: string | null;
}

async function ingestView(app: FastifyInstance): Promise<IngestView> {
  const report = await app.db.liveIngest.get();
  if (report === null) return { online: false, state: 'offline', error: null, reportedAt: null };
  const online =
    report.state !== 'offline' && Date.now() - Date.parse(report.reportedAt) < INGEST_STALE_MS;
  return {
    online,
    state: online ? report.state : 'offline',
    error: online ? report.error : null,
    reportedAt: report.reportedAt,
  };
}

function streamView(stream: LiveStream) {
  return {
    ...stream,
    // Where to watch it, until its files are deleted.
    playlist: stream.cleanedAt === null ? `/api/live/${stream.id}/${LIVE_PLAYLIST}` : null,
  };
}

const streamNotFound = (id: string) => notFound(`live stream ${id} not found`);

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', minLength: 1 } },
  required: ['id'],
} as const;

interface StreamListQuery {
  status?: LiveStreamStatus;
  limit?: number;
  offset?: number;
}

/**
 * Live streams (phase 2). The API never talks to the live process itself (decision #21): it
 * records streams in the database, which the live process watches, and serves the HLS the live
 * process publishes to storage.
 *
 * - `POST /api/live/streams` starts a stream: live ingest listens for its publisher.
 * - `GET /api/live/streams[/:id]` reports streams and whether live ingest is running.
 * - `DELETE /api/live/streams/:id` stops a stream, cutting off its publisher.
 * - `GET /api/live/:id/live.m3u8`, and the segments it lists, play it.
 */
export async function liveRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/live/streams', async (_request, reply) => {
    const ingest = await ingestView(app);
    if (!ingest.online) {
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message:
          'live ingest is not running: start it (npm run dev:live, or the compose live profile) and try again',
      });
    }
    try {
      const stream = await app.db.liveStreams.create();
      return await reply
        .code(201)
        .header('location', `/api/live/streams/${stream.id}`)
        .send({ ...streamView(stream), ingest });
    } catch (err) {
      if (!(err instanceof ActiveLiveStreamError)) throw err;
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: `live stream ${err.active.id} is already ${err.active.status}; stop it first (one live stream at a time)`,
        activeStreamId: err.active.id,
      });
    }
  });

  app.get<{ Querystring: StreamListQuery }>(
    '/api/live/streams',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: [...LIVE_STREAM_STATUSES] },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request) => {
      const page = await app.db.liveStreams.list(request.query);
      return { ...page, items: page.items.map(streamView) };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/live/streams/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      const stream = await app.db.liveStreams.get(request.params.id);
      if (stream === null) return reply.code(404).send(streamNotFound(request.params.id));
      return { ...streamView(stream), ingest: await ingestView(app) };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/live/streams/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      const { id } = request.params;
      const { liveStreams } = app.db;
      let stream = await liveStreams.get(id);
      if (stream === null) return reply.code(404).send(streamNotFound(id));

      if (stream.status === 'waiting') {
        // No publisher yet, so nothing to finish: end it here, and the live process closes the
        // RTMP port when it next looks. It has no files, so they are due for deletion at once.
        const ended = await liveStreams.end(id, {
          reason: 'stopped',
          cleanupAfter: new Date().toISOString(),
        });
        // Otherwise its publisher arrived in the meantime.
        stream = ended ?? (await liveStreams.get(id)) ?? stream;
      }

      const ingest = await ingestView(app);
      if (stream.status === 'live') {
        // Only the live process can cut the publisher off and publish the stream's end.
        await liveStreams.requestStop(id);
        const deadline = Date.now() + (ingest.online ? STOP_WAIT_MS : 0);
        for (;;) {
          stream = (await liveStreams.get(id)) ?? stream;
          if (stream.status === 'ended' || Date.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      return reply
        .code(stream.status === 'ended' ? 200 : 202)
        .send({ ...streamView(stream), ingest });
    },
  );

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
      if (!STREAM_ID.test(id) || !isLiveFileName(file)) {
        return reply.code(404).send(notFound('no such file'));
      }
      if (file !== LIVE_PLAYLIST) return sendStoredObject(app, reply, liveKey(id, file));

      // The playlist is rewritten every segment, so it is read whole (its length can change
      // between a stat and a read) and must never be cached.
      const playlist = await readStoredText(app.storage, liveKey(id, file));
      if (playlist === null) return reply.code(404).send(notFound('no such live stream'));
      return reply
        .type('application/vnd.apple.mpegurl')
        .header('cache-control', 'no-cache')
        .send(playlist);
    },
  );
}
