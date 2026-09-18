# Chitrayaan

Video ingestion, transcoding, and adaptive-bitrate streaming backend. See `CLAUDE.md` for the
design decisions, architecture, and milestone plan — that file is the source of truth.

## Prerequisites

- Node.js 22+ (see `.nvmrc`)
- FFmpeg on `PATH` (needed from Milestone 5 onward)
- Redis reachable at `REDIS_URL` (a Redis inside WSL works from Windows via
  `redis://127.0.0.1:6379` as long as the WSL distro is running)

## Setup

```sh
npm install
cp .env.example .env   # then set API_KEY to a long random string
```

## Scripts

| Command                | What it does                                             |
| ---------------------- | -------------------------------------------------------- |
| `npm run dev`          | Start the API with hot reload (`tsx watch`)              |
| `npm run dev:worker`   | Start the transcode worker with hot reload               |
| `npm run build`        | Compile `src/` to `dist/`                                |
| `npm start`            | Run the compiled API                                     |
| `npm run start:worker` | Run the compiled worker                                  |
| `npm run typecheck`    | `tsc --noEmit`                                           |
| `npm run lint`         | ESLint (type-aware rules on)                             |
| `npm run format:check` | Prettier check (`npm run format` to write)               |
| `npm test`             | Vitest, single run (`npm run test:watch` for watch mode) |
| `npm run check`        | typecheck + lint + format check + tests, in that order   |

## Configuration

All settings come from environment variables and are validated at startup by `src/config/env.ts`.
`.env.example` documents every variable with its default. The process exits with a list of every
problem if the config is invalid.

Local mode (`STORAGE_BACKEND=local`, `DB_BACKEND=sqlite`) needs no external services: the storage
directory and the SQLite file's parent directory are created on first start, and schema migrations
run automatically. `SQLITE_PATH=:memory:` gives a throwaway database for tests.

## Uploading a video

Every route except `/healthz` needs the `X-API-Key` header. Uploads use the
[tus](https://tus.io) resumable protocol at `/api/uploads`; any tus client works
(`tus-js-client`, the `tus` CLI, Uppy). The upload id returned in `Location` is also the video id.

```sh
# 1. Create the upload (metadata values are base64)
curl -si -X POST http://127.0.0.1:3000/api/uploads \
  -H "X-API-Key: $API_KEY" -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: $(stat -c %s clip.mp4)" \
  -H "Upload-Metadata: filename $(echo -n clip.mp4 | base64)"
#    -> 201, Location: /api/uploads/<id>

# 2. Send the bytes (repeat with the offset from a HEAD request to resume)
curl -si -X PATCH http://127.0.0.1:3000/api/uploads/<id> \
  -H "X-API-Key: $API_KEY" -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Offset: 0" -H "Content-Type: application/offset+octet-stream" \
  --data-binary @clip.mp4
#    -> 204 when complete; the video is now `uploaded` with a queued transcode job

# 3. Inspect the video (includes its jobs) or a job directly
curl -s -H "X-API-Key: $API_KEY" http://127.0.0.1:3000/api/videos/<id>
curl -s -H "X-API-Key: $API_KEY" http://127.0.0.1:3000/api/jobs/<jobId>
curl -s -H "X-API-Key: $API_KEY" "http://127.0.0.1:3000/api/jobs?status=queued"
```

## Processing

A finished upload records a `transcode` job and hands it to BullMQ. Run at least one worker
(`npm run dev:worker`) to consume the queue; it shares the API's database and storage. Job rows
in the database are the source of truth for status and progress; `GET /api/jobs/:id` also shows
BullMQ's live view under `queue` when Redis is reachable.

If Redis is down when an upload finishes, the upload still succeeds and the job stays `queued`
in the database; the API enqueues such jobs again the next time it starts. `/healthz` reports
`redis: error` (HTTP 503) in the meantime.

## Layout

```
src/api        Fastify app, routes, auth
src/worker     worker entrypoint, job runner (status bookkeeping), processors
src/lib        storage, db, queue, transcode, packaging, rtmp, features
src/config     env schema + loader
test/unit      pure unit tests
test/contracts reusable behavioural suites every storage / db driver must pass
test/integration  driver + app-level tests (Fastify inject, no network)
test/fixtures  generated synthetic clips (not committed)
test/samples   your own real clips (gitignored)
player         static hls.js + dash.js test page
```
