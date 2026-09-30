# syntax=docker/dockerfile:1
#
# One image runs both processes: the API (`node dist/api/server.js`, the default) and the worker
# (`node dist/worker/index.js`). They share all their code, so shipping one image keeps the two
# from ever drifting apart.

# Shared base with the toolchain native modules need (better-sqlite3 builds from source when no
# prebuild matches the platform).
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./

# Runtime dependencies only, so the final image carries no compilers or test tooling.
FROM base AS prod-deps
RUN npm ci --omit=dev

# Full install, then compile TypeScript to dist/.
FROM base AS build
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# FFmpeg does the real work; the Debian package carries libx264, AAC, SVT-AV1 and the
# HLS/DASH muxers, which is everything the transcode pipeline asks for.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Served as static files by the API, and read from node_modules at request time.
COPY player ./player
COPY docker/wait-for-http.mjs ./docker/wait-for-http.mjs

# Scratch space for transcodes, owned by the unprivileged user the containers run as.
RUN mkdir -p /var/lib/chitrayaan/work /var/lib/chitrayaan/storage \
  && chown -R node:node /var/lib/chitrayaan
ENV WORK_DIR=/var/lib/chitrayaan/work \
    LOCAL_STORAGE_PATH=/var/lib/chitrayaan/storage

USER node
EXPOSE 3000
CMD ["node", "dist/api/server.js"]
