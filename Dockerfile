# ──────────────────────────────────────────────────────────────
# Stage 1: instalar dependências de produção
# ──────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS deps

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# ──────────────────────────────────────────────────────────────
# Stage 2: imagem de runtime
# ──────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS runner

WORKDIR /app

# Usuário não-root para execução segura em produção
RUN addgroup --system --gid 1001 appgroup \
 && adduser  --system --uid 1001 --ingroup appgroup appuser

# Apenas o necessário para rodar — sem devDeps, sem código de ferramentas
COPY --from=deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup src        ./src
COPY --chown=appuser:appgroup package.json tsconfig.json ./

USER appuser

# Bun executa TypeScript nativamente — sem etapa de compilação
ENV NODE_ENV=production

EXPOSE 3000

# Sinalização de saída é tratada em src/index.ts (SIGTERM / SIGINT)
CMD ["bun", "run", "src/worker.ts"]
