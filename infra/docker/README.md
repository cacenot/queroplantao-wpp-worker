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
docker compose --project-directory . \
  -f infra/docker/compose/dev-deps.yml \
  -f infra/docker/compose/api.yml \
  -f infra/docker/compose/worker-zapi.yml \
  -f infra/docker/compose/worker-moderation.yml \
  up --build
```

`--project-directory .` é necessário porque os composes têm `context: .`
(raiz do repo). É o mesmo setup que o Coolify usa — mantém consistência
entre dev e prod.

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

Cada compose constrói com `context: .` resolvido a partir do `--project-directory`
que Coolify aponta pra raiz do repo — necessário pro build copiar `src/`,
`package.json`, etc.

### Variáveis de ambiente

Os composes referenciam envs via `${VAR}` — Coolify resolve os valores a partir
do painel de cada resource. Pra evitar duplicar valores idênticos nos três
resources, usar **Shared Variables** a nível do Project:

#### 1. Project → Shared Variables

Criar uma entrada com o valor real pra cada uma (painel do Project):

| Shared Variable | Observação |
|---|---|
| `DATABASE_URL` | compartilhado pelos 3 resources |
| `AMQP_URL` | idem |
| `REDIS_URL` | idem |
| `QP_ADMIN_API_URL` | idem |
| `QP_ADMIN_API_TOKEN` | idem |
| `QP_ADMIN_API_SERVICE_TOKEN` | idem |
| `ZAPI_BASE_URL` | api + worker-zapi |
| `ZAPI_CLIENT_TOKEN` | api + worker-zapi |
| `SENTRY_DSN` | 3 resources; opcional (vazio vira no-op) |
| `SENTRY_ENVIRONMENT` | ex.: `production` |
| `SENTRY_TRACES_SAMPLE_RATE` | ex.: `0.1` |
| `SENTRY_PROFILES_SAMPLE_RATE` | ex.: `0` |

#### 2. Resource → Environment Variables

Em cada resource (api / worker-zapi / worker-moderation), declarar o nome da
env (igual ao do compose) apontando pra shared via `{{project.NOME}}`. Vars
específicas do resource (não-compartilhadas) vão com valor literal.

**`messaging-api` (api.yml)** — 3 literais + 12 shared:

```
# literais
HTTP_API_KEY=<valor>
ZAPI_RECEIVED_WEBHOOK_SECRET=<valor>

# shared
DATABASE_URL={{project.DATABASE_URL}}
AMQP_URL={{project.AMQP_URL}}
REDIS_URL={{project.REDIS_URL}}
ZAPI_BASE_URL={{project.ZAPI_BASE_URL}}
ZAPI_CLIENT_TOKEN={{project.ZAPI_CLIENT_TOKEN}}
QP_ADMIN_API_URL={{project.QP_ADMIN_API_URL}}
QP_ADMIN_API_TOKEN={{project.QP_ADMIN_API_TOKEN}}
QP_ADMIN_API_SERVICE_TOKEN={{project.QP_ADMIN_API_SERVICE_TOKEN}}
SENTRY_DSN={{project.SENTRY_DSN}}
SENTRY_ENVIRONMENT={{project.SENTRY_ENVIRONMENT}}
SENTRY_TRACES_SAMPLE_RATE={{project.SENTRY_TRACES_SAMPLE_RATE}}
SENTRY_PROFILES_SAMPLE_RATE={{project.SENTRY_PROFILES_SAMPLE_RATE}}
```

**`wpp-zapi-worker` (worker-zapi.yml)** — só shared:

```
DATABASE_URL={{project.DATABASE_URL}}
AMQP_URL={{project.AMQP_URL}}
REDIS_URL={{project.REDIS_URL}}
ZAPI_BASE_URL={{project.ZAPI_BASE_URL}}
ZAPI_CLIENT_TOKEN={{project.ZAPI_CLIENT_TOKEN}}
QP_ADMIN_API_URL={{project.QP_ADMIN_API_URL}}
QP_ADMIN_API_TOKEN={{project.QP_ADMIN_API_TOKEN}}
QP_ADMIN_API_SERVICE_TOKEN={{project.QP_ADMIN_API_SERVICE_TOKEN}}
SENTRY_DSN={{project.SENTRY_DSN}}
SENTRY_ENVIRONMENT={{project.SENTRY_ENVIRONMENT}}
SENTRY_TRACES_SAMPLE_RATE={{project.SENTRY_TRACES_SAMPLE_RATE}}
SENTRY_PROFILES_SAMPLE_RATE={{project.SENTRY_PROFILES_SAMPLE_RATE}}
```

**`moderation-worker` (worker-moderation.yml)** — 1 literal + 10 shared, **sem ZAPI_***:

```
# literal (ou OPENAI_API_KEY / ANTHROPIC_API_KEY — só o provider ativo)
GOOGLE_GENERATIVE_AI_API_KEY=<valor>

# shared
DATABASE_URL={{project.DATABASE_URL}}
AMQP_URL={{project.AMQP_URL}}
REDIS_URL={{project.REDIS_URL}}
QP_ADMIN_API_URL={{project.QP_ADMIN_API_URL}}
QP_ADMIN_API_TOKEN={{project.QP_ADMIN_API_TOKEN}}
QP_ADMIN_API_SERVICE_TOKEN={{project.QP_ADMIN_API_SERVICE_TOKEN}}
SENTRY_DSN={{project.SENTRY_DSN}}
SENTRY_ENVIRONMENT={{project.SENTRY_ENVIRONMENT}}
SENTRY_TRACES_SAMPLE_RATE={{project.SENTRY_TRACES_SAMPLE_RATE}}
SENTRY_PROFILES_SAMPLE_RATE={{project.SENTRY_PROFILES_SAMPLE_RATE}}
```

#### Sintaxe de shared variables

- `{{project.X}}` — compartilhada no nível do **Project** (usado aqui).
- `{{team.X}}` — nível do Team (cross-project, típico pra DSNs globais).
- `{{environment.X}}` — nível do Environment (production/staging).
- `team`, `project`, `environment` são palavras literais — **não** substituir
  pelo nome real.
- Docs: https://coolify.io/docs/knowledge-base/environment-variables#shared-variables

Tabela completa de envs (incluindo defaults opcionais) em
[`docs/architecture.md`](../../docs/architecture.md#variáveis-de-ambiente).

### Migração do layout antigo

O `Dockerfile` e os `docker-compose.*.yml` da raiz foram removidos. No painel do
Coolify, atualizar o **Dockerfile path** ou **Compose file** dos serviços
existentes pros caminhos novos acima. Imagem e processo continuam funcionalmente
equivalentes — só o path do build muda.
