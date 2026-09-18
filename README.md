# Chitrayaan

Video ingestion, transcoding, and adaptive-bitrate streaming backend. See `CLAUDE.md` for the
design decisions, architecture, and milestone plan — that file is the source of truth.

## Prerequisites

- Node.js 22+ (see `.nvmrc`)
- FFmpeg on `PATH` (needed from Milestone 5 onward)
- Redis (needed from Milestone 4 onward)

## Setup

```sh
npm install
cp .env.example .env   # then set API_KEY to a long random string
```

## Scripts

| Command                | What it does                                             |
| ---------------------- | -------------------------------------------------------- |
| `npm run dev`          | Start the API with hot reload (`tsx watch`)              |
| `npm run build`        | Compile `src/` to `dist/`                                |
| `npm start`            | Run the compiled API                                     |
| `npm run typecheck`    | `tsc --noEmit`                                           |
| `npm run lint`         | ESLint (type-aware rules on)                             |
| `npm run format:check` | Prettier check (`npm run format` to write)               |
| `npm test`             | Vitest, single run (`npm run test:watch` for watch mode) |
| `npm run check`        | typecheck + lint + format check + tests, in that order   |

## Configuration

All settings come from environment variables and are validated at startup by `src/config/env.ts`.
`.env.example` documents every variable with its default. The process exits with a list of every
problem if the config is invalid.

## Layout

```
src/api        Fastify app, routes, auth
src/worker     BullMQ worker (transcode jobs)
src/lib        storage, db, transcode, packaging, rtmp, features
src/config     env schema + loader
test/unit      pure unit tests
test/integration  app-level tests (Fastify inject, no network)
test/fixtures  generated synthetic clips (not committed)
test/samples   your own real clips (gitignored)
player         static hls.js + dash.js test page
```
