# ──────────────────────────────────────────────────────────────
# messaging-api — HTTP API + publisher de jobs
# ──────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS deps

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# ──────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS runner

WORKDIR /app

RUN addgroup --system --gid 1001 appgroup \
 && adduser  --system --uid 1001 --ingroup appgroup appuser

COPY --from=deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup src        ./src
COPY --chown=appuser:appgroup package.json tsconfig.json ./

USER appuser

ENV NODE_ENV=production
ENV SERVICE_NAME=messaging-api

EXPOSE 3000

# Sinalização de saída tratada em src/api/index.ts (SIGTERM / SIGINT)
CMD ["bun", "run", "src/api/index.ts"]
