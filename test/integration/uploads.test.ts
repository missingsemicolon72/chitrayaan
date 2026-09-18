import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Upload as TusClientUpload } from 'tus-js-client';

import { TUS_CONTENT_TYPE } from '../../src/api/routes/uploads.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { redisAvailable } from '../helpers/redis.js';

const REDIS = await redisAvailable();
const TUS_VERSION = '1.0.0';
const MiB = 1024 * 1024;

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('tus resumable uploads', () => {
  let t: TestApp;
  let headers: Record<string, string>;

  const create = async (size: number, metadata?: Record<string, string>) => {
    const res = await fetch(`${t.baseUrl}/api/uploads`, {
      method: 'POST',
      headers: {
        ...headers,
        'Upload-Length': String(size),
        ...(metadata
          ? {
              'Upload-Metadata': Object.entries(metadata)
                .map(([k, v]) => `${k} ${b64(v)}`)
                .join(','),
            }
          : {}),
      },
    });
    const location = res.headers.get('location');
    return {
      status: res.status,
      location,
      url: location ? new URL(location, t.baseUrl).toString() : null,
      id: location?.split('/').pop() ?? null,
    };
  };

  const patch = (url: string, offset: number, chunk: Buffer) =>
    fetch(url, {
      method: 'PATCH',
      headers: { ...headers, 'Upload-Offset': String(offset), 'Content-Type': TUS_CONTENT_TYPE },
      body: chunk,
    });

  const head = async (url: string) => {
    const res = await fetch(url, { method: 'HEAD', headers });
    return { status: res.status, offset: Number(res.headers.get('upload-offset')) };
  };

  beforeAll(async () => {
    t = await createTestApp({ listen: true, env: { TUS_UPLOAD_MAX_SIZE_MB: '8' } });
    headers = { 'Tus-Resumable': TUS_VERSION, 'X-API-Key': t.apiKey };
  });

  afterAll(async () => {
    await t.close();
  });

  it('advertises the protocol on OPTIONS', async () => {
    const res = await fetch(`${t.baseUrl}/api/uploads`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('tus-version')).toContain(TUS_VERSION);
    expect(res.headers.get('tus-extension')).toContain('creation');
    expect(res.headers.get('tus-max-size')).toBe(String(8 * MiB));
  });

  it('requires the API key on every tus request', async () => {
    const res = await fetch(`${t.baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { 'Tus-Resumable': TUS_VERSION, 'Upload-Length': '10' },
    });
    expect(res.status).toBe(401);
    expect((await t.app.db.videos.list()).total).toBe(0);
  });

  it('uploads in two chunks with a resume in between, then records the job', async () => {
    const data = randomBytes(3 * MiB);
    const half = Math.floor(data.length / 2);

    const created = await create(data.length, { filename: 'clip.mp4', filetype: 'video/mp4' });
    expect(created.status).toBe(201);
    expect(created.location).toMatch(/^\/api\/uploads\/[0-9a-f-]{36}$/);
    const id = created.id!;
    const url = created.url!;

    // The upload id is the video id, and the video exists as soon as the upload is created.
    const pending = await t.app.db.videos.get(id);
    expect(pending).toMatchObject({
      status: 'uploading',
      originalFilename: 'clip.mp4',
      title: 'clip.mp4',
      sizeBytes: data.length,
      sourceKey: null,
    });
    expect((await t.app.db.jobs.list({ videoId: id })).total).toBe(0);

    expect(await head(url)).toEqual({ status: 200, offset: 0 });

    const first = await patch(url, 0, data.subarray(0, half));
    expect(first.status).toBe(204);
    expect(Number(first.headers.get('upload-offset'))).toBe(half);
    expect((await t.app.db.videos.get(id))?.status).toBe('uploading');

    // A client that lost its connection asks where to resume from.
    expect(await head(url)).toEqual({ status: 200, offset: half });

    const second = await patch(url, half, data.subarray(half));
    expect(second.status).toBe(204);
    expect(Number(second.headers.get('upload-offset'))).toBe(data.length);

    const done = await t.app.db.videos.get(id);
    expect(done).toMatchObject({
      status: 'uploaded',
      sourceKey: `uploads/${id}`,
      sizeBytes: data.length,
    });

    const jobs = await t.app.db.jobs.list({ videoId: id });
    expect(jobs.total).toBe(1);
    const job = jobs.items[0]!;
    expect(job).toMatchObject({ type: 'transcode', status: 'queued', videoId: id });
    if (REDIS) {
      // The finished upload handed its job to BullMQ under the job's own id.
      expect(job.queueJobId).toBe(job.id);
      expect((await t.queue.getState(job.id))?.state).toBe('waiting');
    } else {
      expect(job.queueJobId).toBeNull();
    }

    // The bytes are readable through the storage abstraction and are intact.
    const stored = await readAll(await t.app.storage.get(`uploads/${id}`));
    expect(stored.equals(data)).toBe(true);
    expect((await t.app.storage.stat(`uploads/${id}`))?.size).toBe(data.length);

    // The API view shows the video with its job.
    const res = await fetch(`${t.baseUrl}/api/videos/${id}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; jobs: { status: string }[] };
    expect(body.status).toBe('uploaded');
    expect(body.jobs).toHaveLength(1);
  });

  it('rejects a PATCH at the wrong offset with 409 and keeps the upload resumable', async () => {
    const data = randomBytes(64 * 1024);
    const { url } = await create(data.length);
    expect((await patch(url!, 0, data.subarray(0, 1024))).status).toBe(204);
    expect((await patch(url!, 0, data.subarray(0, 1024))).status).toBe(409);
    expect((await patch(url!, 4096, data.subarray(4096))).status).toBe(409);
    expect(await head(url!)).toEqual({ status: 200, offset: 1024 });
  });

  it('refuses uploads over TUS_UPLOAD_MAX_SIZE_MB with 413 and records nothing', async () => {
    const before = (await t.app.db.videos.list()).total;
    const created = await create(8 * MiB + 1);
    expect(created.status).toBe(413);
    expect(created.location).toBeNull();
    expect((await t.app.db.videos.list()).total).toBe(before);
  });

  it('terminating an unfinished upload deletes its bytes and video row', async () => {
    const data = randomBytes(32 * 1024);
    const { url, id } = await create(data.length);
    await patch(url!, 0, data.subarray(0, 1024));
    expect(await t.app.db.videos.get(id!)).not.toBeNull();

    const res = await fetch(url!, { method: 'DELETE', headers });
    expect(res.status).toBe(204);
    expect(await t.app.db.videos.get(id!)).toBeNull();
    expect(await t.app.storage.exists(`uploads/${id}`)).toBe(false);
    expect((await head(url!)).status).toBe(404);
  });

  it('refuses to terminate a finished upload (its job may already be running)', async () => {
    const data = randomBytes(16 * 1024);
    const { url, id } = await create(data.length);
    expect((await patch(url!, 0, data)).status).toBe(204);

    const res = await fetch(url!, { method: 'DELETE', headers });
    expect(res.status).toBe(400);
    expect((await t.app.db.videos.get(id!))?.status).toBe('uploaded');
    expect(await t.app.storage.exists(`uploads/${id}`)).toBe(true);
  });

  it('works end to end with the reference tus-js-client in chunked mode', async () => {
    const data = randomBytes(2 * MiB + 12345);
    let uploadUrl: string | null = null;

    await new Promise<void>((resolve, reject) => {
      const upload = new TusClientUpload(data, {
        endpoint: `${t.baseUrl}/api/uploads`,
        chunkSize: 512 * 1024,
        retryDelays: [0, 50, 100],
        headers: { 'X-API-Key': t.apiKey },
        metadata: { filename: 'client.bin', filetype: 'application/octet-stream' },
        storeFingerprintForResuming: false,
        onError: reject,
        onSuccess: () => {
          uploadUrl = upload.url;
          resolve();
        },
      });
      upload.start();
    });

    const id = uploadUrl!.split('/').pop()!;
    const video = await t.app.db.videos.get(id);
    expect(video).toMatchObject({
      status: 'uploaded',
      originalFilename: 'client.bin',
      sizeBytes: data.length,
      sourceKey: `uploads/${id}`,
    });
    expect((await t.app.db.jobs.list({ videoId: id })).total).toBe(1);
    const stored = await readAll(await t.app.storage.get(`uploads/${id}`));
    expect(stored.equals(data)).toBe(true);
  });
});
