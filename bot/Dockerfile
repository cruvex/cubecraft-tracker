# Build context is the repo root, shared by every service; nothing outside bot/ is copied here.
FROM oven/bun:1-alpine
WORKDIR /app

COPY bot/package.json bot/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY bot/src src

USER bun
CMD ["bun", "src/index.ts"]
