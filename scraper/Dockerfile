# The Minecraft version the scraper logs in as. The runtime pins the same one
# (MC_VERSION in src/cubecraft/connection.ts), and only its protocol data ships.
ARG MC_VERSION=26.1

# Stage 1: bundle the scraper into one file.
# Bun transpiles every module it imports at startup, and zod's module graph is
# a large part of that. Bundling ahead of time hands the runtime one
# tree-shaken file instead. mineflayer stays out: it loads protocol data by
# version at runtime, and bundled it drags in every version (a 300MB bundle).
FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY scraper/package.json scraper/bun.lock ./
RUN bun install --frozen-lockfile

COPY scraper/src src
# --sourcemap=inline because --minify mangles stack traces, and report.ts posts
# error.stack to Discord -- the only visibility into a process that now runs
# unattended rather than one cron invocation at a time.
RUN bun build src/index.ts --target=bun --minify --sourcemap=inline --external mineflayer --outfile=scraper.js

# Stage 2: mineflayer's dependency tree for the runtime, with minecraft-data
# cut down from every version (~430MB) to the one in use.
FROM oven/bun:1-alpine AS runtime-deps
ARG MC_VERSION
WORKDIR /app
COPY scraper/package.json scraper/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY scraper/scripts/prune-minecraft-data.ts .
RUN bun prune-minecraft-data.ts "$MC_VERSION"

# Stage 3: the bundle plus the pruned node_modules it needs for mineflayer.
FROM oven/bun:1-alpine
ARG MC_VERSION
ENV MC_VERSION=$MC_VERSION
WORKDIR /app
COPY --from=runtime-deps /app/node_modules node_modules
COPY --from=builder /app/scraper.js .
USER bun
CMD ["bun", "scraper.js"]
