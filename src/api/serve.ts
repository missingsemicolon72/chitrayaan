import type { FastifyInstance, FastifyReply } from 'fastify';

import { assertValidKey, contentTypeForKey, StorageNotFoundError } from '../lib/storage/index.js';

export { readStoredText } from '../lib/storage/index.js';

export const notFound = (message: string) => ({
  statusCode: 404,
  error: 'Not Found',
  message,
});

/** Stream a stored object with the right headers, or answer 404. */
export async function sendStoredObject(
  app: FastifyInstance,
  reply: FastifyReply,
  key: string,
): Promise<FastifyReply> {
  try {
    assertValidKey(key);
  } catch {
    return reply.code(404).send(notFound('no such file'));
  }
  const info = await app.storage.stat(key);
  if (!info) return reply.code(404).send(notFound('no such file'));
  let body;
  try {
    body = await app.storage.get(key);
  } catch (err) {
    // Deleted since the stat: a live segment leaving the window, say.
    if (err instanceof StorageNotFoundError) return reply.code(404).send(notFound('no such file'));
    throw err;
  }
  return reply
    .type(contentTypeForKey(key))
    .header('content-length', String(info.size))
    .header('last-modified', info.lastModified.toUTCString())
    .send(body);
}
