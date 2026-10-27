import { StorageNotFoundError, type ObjectStorage } from './types.js';

/** Read a small stored text object (a manifest) into a string, or null when it is missing. */
export async function readStoredText(storage: ObjectStorage, key: string): Promise<string | null> {
  if (!(await storage.exists(key))) return null;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of await storage.get(key)) chunks.push(Buffer.from(chunk as Buffer));
  } catch (err) {
    if (err instanceof StorageNotFoundError) return null;
    throw err;
  }
  return Buffer.concat(chunks).toString('utf8');
}
