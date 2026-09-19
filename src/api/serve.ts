import type { FastifyInstance, FastifyReply } from 'fastify';

import { assertValidKey, contentTypeForKey, type ObjectStorage } from '../lib/storage/index.js';

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
  return reply
    .type(contentTypeForKey(key))
    .header('content-length', String(info.size))
    .header('last-modified', info.lastModified.toUTCString())
    .send(await app.storage.get(key));
}

/** Read a small stored text object (a manifest) into a string, or null when it is missing. */
export async function readStoredText(storage: ObjectStorage, key: string): Promise<string | null> {
  if (!(await storage.exists(key))) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of await storage.get(key)) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}
