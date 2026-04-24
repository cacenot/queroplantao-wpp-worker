# Infra — Docker / Compose

Imagens e composes dos serviços da aplicação (API + dois workers). Para a stack de
observabilidade (Prometheus + Grafana), ver [`infra/observability/`](../observability/README.md).

## Estrutura

```
infra/docker/
├── api.Dockerfile               # messaging-api         — porta 3000
├── worker-zapi.Dockerfile       # wpp-zapi-worker       — health 3011
├── worker-moderation.Dockerfile # moderation-worker     — health 3012
└── compose/
    ├── dev-deps.yml             # LavinMQ + Redis + Postgres (uso local)
    ├── api.yml
    ├── worker-zapi.yml
    └── worker-moderation.yml
```

Cada serviço tem o próprio Dockerfile. A stage `deps` é idêntica nos três (mesmo
`bun install --frozen-lockfile --production`) — o cache do Docker reaproveita a
camada quando o `package.json`/`bun.lockb` não muda.

## Portas

| Serviço | Porta | Uso |
|---|---|---|
| `messaging-api` | `3000` | HTTP público |
| `wpp-zapi-worker` | `3011` | health check (Coolify / Docker `HEALTHCHECK`) |
| `moderation-worker` | `3012` | health check |

Defaults configuráveis via env (`HTTP_PORT`, `WORKER_ZAPI_HEALTH_PORT`,
`WORKER_MODERATION_HEALTH_PORT`). Workers expõem `GET /health` retornando `200`
quando o consumer AMQP está conectado e sem erros recentes, `503` caso contrário.

## Filas AMQP por worker

| Worker | Fila principal | Tipos de job | Prefetch | Priority |
|---|---|---|---|---|
| `wpp-zapi-worker` | `messaging.zapi` | `whatsapp.delete_message`, `whatsapp.remove_participant` | 1 (serial) | `x-max-priority=10` |
| `moderation-worker` | `messaging.moderation` | `whatsapp.moderate_group_message`, `whatsapp.ingest_participant_event` | 5 | — |

Cada fila tem suas próprias `.retry` (TTL+DLX) e `.dlq`. O roteamento por `job.type`
é decidido em [`src/jobs/routing.ts`](../../src/jobs/routing.ts).

Ambos os workers declaram **as duas** topologies no boot (idempotente) — a API
também declara, garantindo que a fila exista antes de qualquer publish.

## Uso local

Subir as dependências (LavinMQ + Redis + Postgres):

```bash
docker compose -f infra/docker/compose/dev-deps.yml up -d
```

Para rodar API e workers fora do Docker (mais ágil em dev), usar os scripts do
`package.json`:

```bash
bun run dev:api
bun run dev:worker:zapi
bun run dev:worker:moderation
```

Para subir tudo via Docker (smoke test do build):

```bash
docker compose \
  -f infra/docker/compose/dev-deps.yml \
  -f infra/docker/compose/api.yml \
  -f infra/docker/compose/worker-zapi.yml \
  -f infra/docker/compose/worker-moderation.yml \
  up --build
```

## Coolify (produção)

Cada serviço é um recurso "Application" (ou "Docker Compose") separado no Coolify.

### Opção A — Application apontando direto pro Dockerfile

- **Build pack:** Dockerfile
- **Dockerfile path:**
  - API → `infra/docker/api.Dockerfile`
  - Zapi worker → `infra/docker/worker-zapi.Dockerfile`
  - Moderation worker → `infra/docker/worker-moderation.Dockerfile`
- **Port:** `3000` (api), `3011` (zapi worker), `3012` (moderation worker)
- **Healthcheck path:** `/health`

### Opção B — Docker Compose

- **Base Directory:** `/`
- **Compose file:**
  - `infra/docker/compose/api.yml`
  - `infra/docker/compose/worker-zapi.yml`
  - `infra/docker/compose/worker-moderation.yml`

Cada compose constrói com `context: ../../..` (raiz do repo) — necessário pro
build copiar `src/`, `package.json`, etc.

### Variáveis de ambiente

Definir no painel de cada serviço — ver tabela completa em
[`docs/architecture.md`](../../docs/architecture.md#variáveis-de-ambiente).

Mínimo por serviço:

- **API** (`messaging-api`): `DATABASE_URL`, `AMQP_URL`, `REDIS_URL`, `HTTP_API_KEY`,
  `ZAPI_*`, `QP_ADMIN_API_*`, `ZAPI_RECEIVED_WEBHOOK_SECRET`.
- **Zapi worker**: as mesmas, exceto `HTTP_API_KEY` e `ZAPI_RECEIVED_WEBHOOK_*`.
- **Moderation worker**: as mesmas + chave do provider de IA ativo
  (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`).

### Migração do layout antigo

O `Dockerfile` e os `docker-compose.*.yml` da raiz foram removidos. No painel do
Coolify, atualizar o **Dockerfile path** ou **Compose file** dos serviços
existentes pros caminhos novos acima. Imagem e processo continuam funcionalmente
equivalentes — só o path do build muda.
