# readm3.com — Markdown editor, public site, and document API.
FROM oven/bun:1.4 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build imports src/markdown.ts directly, so there is nothing to compile
# first: whatever the reader renders today is what the page shows.
RUN bun run site:build

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV READM3_DB=/data/readm3.sqlite
ENV READM3_URL=https://readm3.com
COPY --from=builder --chown=bun:bun /app/site/dist ./site/dist
COPY --from=builder --chown=bun:bun /app/site/server.ts ./site/server.ts
COPY --from=builder --chown=bun:bun /app/server ./server
RUN mkdir -p /data && chown bun:bun /data

USER bun
EXPOSE 3000
CMD ["bun", "site/server.ts"]
