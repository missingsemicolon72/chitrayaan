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
| `npm run fixtures`     | Generate the synthetic test clips (also done by `test`)  |

Tests that need Redis or FFmpeg skip themselves (with a console warning) when those are missing.
To validate against your own clips, drop them in `test/samples/` (gitignored) and run
`RUN_SAMPLE_TESTS=1 npm test -- samples`; this is slow by design and not part of `check`.

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

The worker probes the source with ffprobe, then runs one FFmpeg pass that encodes the whole
H.264/AAC ladder (360p, 480p, 720p, 1080p; rungs above the source resolution are dropped, never
upscaled) and packages it as CMAF: fragmented-MP4 segments (4 s, keyframes every 2 s, aligned
across rungs) written once, with a DASH manifest and HLS playlists generated over the same files.
Everything lands flat under `videos/<id>/`:

| File                      | What it is                                    |
| ------------------------- | --------------------------------------------- |
| `master.mpd`              | DASH manifest (video + audio adaptation sets) |
| `master.m3u8`             | HLS master playlist (one variant per rung)    |
| `media_N.m3u8`            | HLS media playlist for stream N               |
| `init-streamN.m4s`        | CMAF init segment for stream N                |
| `chunk-streamN-NNNNN.m4s` | CMAF media segments for stream N              |

Stream numbering: H.264 rungs first (ascending), then AV1 rungs if enabled, then the single
shared audio track. Renditions are recorded in the `renditions` table; the manifest keys on the
video. `PACKAGE_FORMATS` controls which master manifests are published (`hls`, `dash`, or both).

### AV1 (opt-in)

`CODEC_LADDER=h264,av1` adds an AV1 copy of every rung (SVT-AV1, `AV1_PRESET` 0-13) in the same
FFmpeg pass. H.264 is always present so every player has something to play; AV1 lands in its
own DASH adaptation set and as extra HLS variants (`CODECS="av01..."`), and clients that decode
AV1 (Chrome, Firefox, Edge, recent Android) can pick it. Expect encoding to take roughly two to
three times longer than H.264 alone. H.265/HEVC is deliberately not available (CLAUDE.md #11).

```sh
curl -s -H "X-API-Key: $API_KEY" http://127.0.0.1:3000/api/videos/<id>        # manifests.{hls,dash}, renditions[]
curl -s -H "X-API-Key: $API_KEY" http://127.0.0.1:3000/api/videos/<id>/master.m3u8
curl -s -H "X-API-Key: $API_KEY" http://127.0.0.1:3000/api/videos/<id>/master.mpd
```

`FFMPEG_PRESET` trades encode speed for bitrate efficiency (`veryfast` is a good dev setting).

If Redis is down when an upload finishes, the upload still succeeds and the job stays `queued`
in the database; the API enqueues such jobs again the next time it starts. `/healthz` reports
`redis: error` (HTTP 503) in the meantime.

## Optional features

Three extras, each independently toggleable and **off by default** (decision #13). Turning a
flag off hides the feature everywhere, including in served manifests, without deleting anything
already produced.

### Thumbnails (`FEATURE_THUMBNAILS=true`)

The worker samples one preview every few seconds (2 s, stretching for long videos so a video
yields at most ~200), tiles them into sprite sheets, and writes a WebVTT track whose cues carry
`#xywh=` sprite coordinates, the format players use for hover previews. Output lands in
`videos/<id>/thumbs/` and the video detail response gains `thumbnails.trackUrl`.

### Subtitles (`FEATURE_SUBTITLES=true`)

WebVTT tracks are uploaded per language; there is no auto-captioning (out of scope). Tracks are
stored at `videos/<id>/subtitles/<lang>.vtt`, survive a re-transcode, and are woven into the HLS
master and DASH manifest when those are served, so adding one takes effect immediately.

```sh
curl -X PUT "http://127.0.0.1:3000/api/videos/<id>/subtitles/en?label=English&default=true" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: text/vtt" --data-binary @captions.en.vtt
curl -s -H "X-API-Key: $API_KEY" http://127.0.0.1:3000/api/videos/<id>/subtitles
curl -X DELETE -H "X-API-Key: $API_KEY" http://127.0.0.1:3000/api/videos/<id>/subtitles/en
```

Uploads are validated (WebVTT header, cue timings, 5 MiB cap) and rejected with 400 if malformed.
HLS also needs a media playlist per track; the API generates `subtitles/<lang>.m3u8` on request.

### Watermark (`FEATURE_WATERMARK=true`)

`WATERMARK_IMAGE_PATH` is composited once onto the decoded source, before the ladder split, so
every rung carries it at a consistent relative size. `WATERMARK_POSITION` picks a corner (2%
inset) and `WATERMARK_OPACITY` multiplies into the image's own alpha, so transparent PNGs stay
transparent. The image is used at its native size, so scale it for your top rung. The worker
refuses to start if the file is unreadable.

## Failure handling

- **Retries.** A job is tried `JOB_ATTEMPTS` times with exponential backoff from
  `JOB_BACKOFF_MS`. Anything that will never succeed, an unreadable source, a file FFmpeg cannot
  decode, a transcode that hit its timeout, fails immediately instead: the job record says why,
  and the video is marked `failed` with the same message.
- **Broken input.** Files that are not media, have no video stream, report no duration, or
  decode part-way and then fall apart are all rejected on the first attempt. FFmpeg's own
  complaint is quoted in the error, so `GET /api/jobs/:id` says what was wrong with the file.
- **Oversized uploads.** Anything larger than `TUS_UPLOAD_MAX_SIZE_MB` is refused with 413,
  before bytes are stored, as is a chunk that would push an upload past its declared length.
- **Hung transcodes.** `TRANSCODE_TIMEOUT_MINUTES` bounds a job; FFmpeg is killed when it
  expires and the job fails without retrying.
- **Housekeeping.** The API reconciles jobs that never reached Redis and deletes uploads
  abandoned for `UPLOAD_EXPIRY_HOURS`, at startup and every 15 minutes. A finished upload's
  source is never swept, however old, and a partial upload that is still being written to is
  left alone. Workers delete scratch directories left by a previous crash at startup.
- **Errors.** Responses of 500 and above carry a generic message; details go to the log only.

## Test player

With the API running, open `http://127.0.0.1:3000/player/` in a browser. Enter the API key,
pick a ready video, and play it through hls.js (HLS) and dash.js (DASH) side by side. The page
shows the ladder, the active rendition, buffer level and an event log, and lets you pin a
quality. When the optional features are on it also lists subtitle tracks and gives a scrub bar
that previews the thumbnail sprites. The page and the player libraries are served without a key (a browser cannot attach
custom headers to a page load); every manifest and segment request it makes carries the key.
The key is remembered in the browser's local storage for convenience. Deep links work too:
`/player/?key=<API_KEY>&video=<id>&autoplay=1` connects, loads that video and starts both
players (the key is moved into local storage and removed from the address bar on load).

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
