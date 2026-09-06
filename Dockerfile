# readm3.com — the static marketing site, built by the package's own renderer.
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
COPY --from=builder --chown=bun:bun /app/site/dist ./site/dist
COPY --from=builder --chown=bun:bun /app/site/server.ts ./site/server.ts

USER bun
EXPOSE 3000
CMD ["bun", "site/server.ts"]
