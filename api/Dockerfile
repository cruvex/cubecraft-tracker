# Build context is the repo root, shared by every service; nothing outside api/ is copied here.
FROM oven/bun:1-alpine
WORKDIR /app

# api/ is flattened onto /app, so package.json's own scripts resolve and
# migrate.ts finds ../migrations relative to /app/src.
COPY api/package.json api/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY api/src src

# Ships as files because migrate.ts readdir()s them at runtime rather than
# importing them -- a bundler would leave the .sql behind.
COPY api/migrations migrations
COPY api/games.json games.json

USER bun
CMD ["bun", "src/index.ts"]
