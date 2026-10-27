# Chitrayaan

Video ingestion, transcoding, and adaptive-bitrate streaming backend. See `CLAUDE.md` for the
design decisions, architecture, and milestone plan — that file is the source of truth.

## Prerequisites

Either Docker (see below), or, to run it directly:

- Node.js 22+ (see `.nvmrc`)
- FFmpeg on `PATH`
- Redis reachable at `REDIS_URL` (a Redis inside WSL works from Windows via
  `redis://127.0.0.1:6379` as long as the WSL distro is running)

## Setup

```sh
npm install
cp .env.example .env   # then set API_KEY to a long random string
```

## Running with Docker

The compose file brings up the whole stack, so nothing needs installing but Docker:

```sh
docker compose up --build
```

That starts Redis, Postgres, an S3-compatible server, the API on
[http://127.0.0.1:3000](http://127.0.0.1:3000) and one worker, wired together in cloud mode.
Live ingest is a separate service you add with the `live` profile.
The test player is at `/player/` and the API key defaults to `chitrayaan-development-key`.
**Change it** before this is reachable by anything but you, by putting `API_KEY=...` in a `.env`
file next to the compose file.

| Task                     | Command                                                     |
| ------------------------ | ----------------------------------------------------------- |
| Watch a transcode        | `docker compose logs -f worker`                             |
| Run more workers at once | `WORKER_REPLICAS=3 docker compose up -d`                    |
| Turn a feature on        | `FEATURE_THUMBNAILS=true docker compose up -d`              |
| Add live ingest          | `RTMP_STREAM_KEY=<key> docker compose --profile live up -d` |
| Watch live ingest        | `docker compose logs -f live`                               |
| Stop, keeping data       | `docker compose --profile live down`                        |
| Stop and wipe data       | `docker compose --profile live down -v`                     |

Without `--profile live`, `down` leaves a running live ingest container behind. All three
processes run from one image, so they can never drift apart; only the command differs.
Redis and Postgres are not published to the host, so they cannot collide with instances you
already run. The API, RTMP ingest and the S3 server are, on `API_PORT`, `RTMP_PORT` and `S3_PORT`
(3000, 1935 and 9000), bound to `127.0.0.1` only.

MinIO withdrew its public images and binaries, so the S3 service is SeaweedFS, which speaks the
same API. Any S3-compatible server works: point `S3_ENDPOINT` elsewhere and drop the service.

## Scripts

| Command                | What it does                                             |
| ---------------------- | -------------------------------------------------------- |
| `npm run dev`          | Start the API with hot reload (`tsx watch`)              |
| `npm run dev:worker`   | Start the transcode worker with hot reload               |
| `npm run dev:live`     | Start the live ingest process (no hot reload)            |
| `npm run build`        | Compile `src/` to `dist/`                                |
| `npm start`            | Run the compiled API                                     |
| `npm run start:worker` | Run the compiled worker                                  |
| `npm run start:live`   | Run the compiled live ingest process                     |
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

## Storage and database backends

Two modes, selected by environment variables and meant to be used in pairs:

| Mode  | `STORAGE_BACKEND` | `DB_BACKEND` | Needs                          |
| ----- | ----------------- | ------------ | ------------------------------ |
| local | `local`           | `sqlite`     | nothing but a directory        |
| cloud | `s3`              | `postgres`   | an S3-compatible server and PG |

Both pairs run the same code: one `ObjectStorage` interface with a disk and an S3 driver, and
one set of repositories over Kysely with a SQLite and a Postgres dialect. Parity is not a claim,
it is enforced: `test/contracts/` holds behavioural suites that every driver must pass, and the
cloud suites run the identical tests against MinIO and Postgres.

```sh
# Cloud mode, with MinIO and Postgres reachable locally
STORAGE_BACKEND=s3 S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=chitrayaan \
S3_ACCESS_KEY=minioadmin S3_SECRET_KEY=minioadmin S3_REGION=us-east-1 \
DB_BACKEND=postgres DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/chitrayaan \
npm run dev
```

The bucket and the schema are created on demand, as the local mode creates its directory and
SQLite file. One layout difference is worth knowing: on disk the tus library stores an upload at
`uploads/<id>`, while on S3 it keys the object by upload id at the bucket root. The video record
stores whichever key applies, so nothing downstream cares.

The parity suites skip themselves unless the services are running. They expect Postgres at
`postgres://chitrayaan:chitrayaan@127.0.0.1:5432/chitrayaan_test` and an S3 server at
`http://127.0.0.1:9000` with the usual dev credentials; override with `TEST_DATABASE_URL`,
`TEST_S3_ENDPOINT`, `TEST_S3_ACCESS_KEY` and `TEST_S3_SECRET_KEY`.

```sh
psql -U postgres -c "CREATE ROLE chitrayaan LOGIN PASSWORD 'chitrayaan' CREATEDB;"
psql -U postgres -c "CREATE DATABASE chitrayaan_test OWNER chitrayaan;"
```

Any S3-compatible server works. MinIO no longer publishes prebuilt binaries, so these were last
verified against SeaweedFS (`weed server -s3 -s3.port=9000 -s3.config=<identities.json>`).

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
players (the key is moved into local storage and removed from the address bar on load). Live
streams play in the HLS player only (see below).

## Live ingest (RTMP)

Live ingest is its own process, so restarting or redeploying the API never cuts a stream. Set
`RTMP_STREAM_KEY` and start it alongside the API and worker; it shares their database and
storage:

```sh
npm run dev:live
```

It refuses to start without a key. There is deliberately no hot reload (see Restarts below).

Start a stream through the API. The live process then listens on `RTMP_LISTEN_PORT` (1935),
bound to `HOST`, for that stream's publisher:

```sh
curl -s -X POST -H "X-API-Key: $API_KEY" http://127.0.0.1:3000/api/live/streams
```

The answer gives the stream's `id`, its `status` (`waiting`) and its `playlist`. In OBS, set the
server to `rtmp://127.0.0.1:1935/live` and the stream key to `RTMP_STREAM_KEY`. With FFmpeg:

```sh
ffmpeg -re -i clip.mp4 -c:v libx264 -preset veryfast -g 60 -c:a aac \
  -f flv rtmp://127.0.0.1:1935/live/<RTMP_STREAM_KEY>
```

With FFmpeg 8 on Windows, add `-readrate_catchup 2` after `-re`: plain `-re` falls behind real
time there (a 12 s clip takes about 20 s to send), and the stream with it.

Once the publisher connects, the stream is `live`. It is transcoded in real time to one rung,
720p H.264/AAC at 2.8 Mbps (smaller sources are not upscaled), and published as live HLS at its
`playlist`, `/api/live/<id>/live.m3u8`. To watch it, use the test player's Live box (which can
also start and stop streams), or open `/player/?key=<API_KEY>&live=<id>&autoplay=1`.

The stream ends when its publisher stops, or when you stop it:

```sh
curl -s -X DELETE -H "X-API-Key: $API_KEY" http://127.0.0.1:3000/api/live/streams/<id>
```

| Endpoint                       | What it does                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `POST /api/live/streams`       | Start a stream. 409 while another is waiting or live, 503 while live ingest is not running          |
| `GET /api/live/streams/:id`    | The stream, plus whether live ingest is running and what it is doing (`ingest`)                     |
| `GET /api/live/streams`        | Streams, newest first (`status`, `limit`, `offset`)                                                 |
| `DELETE /api/live/streams/:id` | Stop it: cuts off the publisher and closes the playlist. 202 if live ingest has not done so in 10 s |
| `GET /api/live/:id/live.m3u8`  | The live playlist, and the segments it lists                                                        |

A stream goes `waiting`, `live`, `ended`, and records why it ended (`endReason`):
`publisher-disconnected`, `stopped` (through the API), `failed` (FFmpeg failed) or
`interrupted` (the live process stopped or died mid-stream). `LIVE_CLEANUP_DELAY_SECONDS` (60)
after it ends, its files are deleted from storage, `cleanedAt` is set and `playlist` becomes null.

- **Rolling window.** Segments are 2 seconds of CMAF (fragmented MP4), and the playlist lists
  the latest 6. It goes up once it has 3, because players start three segments behind the live
  edge, so expect 6 to 8 seconds of latency. A segment that leaves the window is deleted from
  storage 14 seconds later, once no player can still want it.
- **End of stream.** The playlist is closed (`#EXT-X-ENDLIST`), even if FFmpeg crashed or the
  live process died, and only its last window stays in storage until the cleanup delay is up, so
  viewers can play to the end.
- **One publish per stream.** When the publisher disconnects, the stream is over and the RTMP
  port closes; to go live again, start a new stream. An encoder that reconnects by itself (OBS
  does after a network drop) is refused, and the new stream gets a new id and playlist.
- **One stream at a time.** The database allows a single waiting or live stream. FFmpeg's own
  listener does the RTMP work: it accepts one connection and closes its port, so a second
  publisher is refused while a stream is live. Run one live process only.
- **API and live process.** They talk only through the database: the API records streams and
  stop requests, the live process checks for them every second, records what happens, and
  reports its own state every 5 seconds (`ingest` in the API's answers). After 15 seconds without
  a report, the API treats live ingest as not running.
- **Storage.** FFmpeg writes into `WORK_DIR/chitrayaan-live/<stream id>` and the live process
  copies each segment to storage (local disk or S3) under `live/<stream id>/`. The API serves it
  from there.
- **Keeping up.** If a stream runs slower than real time for 10 seconds, the live process logs a
  warning: either the publisher's upload or this machine's CPU cannot keep up.
- **Stream key.** FFmpeg only warns about a wrong key or application name and would accept the
  stream anyway, so the live process drops the connection the moment that warning appears.
  Neither the real key nor the attempted one is ever logged.
- **Dead publishers.** A publisher silent for 10 seconds (a dropped network, a stalled encoder) is
  disconnected, as is a connection that never completes the handshake, so nothing can hold the
  only slot.
- **Port trouble.** If the port is taken, the live process retries the listener with backoff (up
  to 15 seconds), logging the failure once and reporting it as `ingest.error`. It exits at
  startup if FFmpeg cannot run.
- **Restarts.** Ctrl+C or SIGTERM ends a live stream as `interrupted` and frees the port; a
  waiting stream stays waiting and the next run listens for it again. If the process is killed
  outright, the next run ends its stream as `interrupted` and closes the playlist, and deletes
  any live files no stream accounts for. A process killed outright (Task Manager, or a
  hot-reload restart on Windows, which is why `dev:live` has none) leaves its FFmpeg behind; an
  idle listener is replaced every 30 seconds, so a leftover gives up within 30 seconds.

## Layout

```
src/api        Fastify app, routes, auth
src/worker     worker entrypoint, job runner (status bookkeeping), processors
src/live       live ingest process: entrypoint, stream controller, RTMP ingest, storage mirror
src/lib        storage, db, queue, transcode, packaging, rtmp, features
src/config     env schema + loader
test/unit      pure unit tests
test/contracts reusable behavioural suites every storage / db driver must pass
test/integration  driver + app-level tests (Fastify inject, no network)
test/fixtures  generated synthetic clips (not committed)
test/samples   your own real clips (gitignored)
player         static hls.js + dash.js test page
```
