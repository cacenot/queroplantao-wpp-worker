# Observabilidade — Prometheus + Grafana + Sentry

Stack self-hosted (Prometheus + Grafana) lendo:
- métricas de fila do **LavinMQ** via endpoint `/metrics` nativo (porta `15692`),
- métricas de container via **cAdvisor** (CPU, memória, rede, FS por container),
- métricas do host via **node-exporter** (load, memória, disco, rede do host),
- métricas de **runtime Node.js + jobs** expostas pelos próprios serviços via `/metrics` (`prom-client`),
- agregações de moderação e tasks via **Postgres** (queries SQL).

Erros do worker vão pro **Sentry** (SaaS, plano free).

## Estrutura

```
infra/observability/
├── docker-compose.yml             # prometheus + grafana + cadvisor + node-exporter
├── Dockerfile.grafana             # image custom: grafana base + COPY do provisioning
├── Dockerfile.prometheus          # image custom: prometheus base + COPY do template
├── prometheus/prometheus.yml.tpl  # template; entrypoint faz sed das envs no startup
└── grafana/provisioning/
    ├── datasources/
    │   ├── prometheus.yml
    │   └── postgres.yml
    └── dashboards/
        ├── default.yml                # provider
        ├── lavinmq.json               # filas (Prometheus)
        ├── moderation.json            # moderação por IA (SQL)
        ├── tasks.json                 # tasks (SQL)
        ├── phone_policies.json        # políticas de telefone (SQL)
        └── services_overview.json     # recursos host + containers + app runtime + jobs
```

## Variáveis de ambiente

Definir no painel do Coolify (no recurso "Docker Compose" da observabilidade):

| Variável | Obrigatória | Descrição |
|---|---|---|
| `GF_SECURITY_ADMIN_USER` | sim | Usuário admin do Grafana |
| `GF_SECURITY_ADMIN_PASSWORD` | sim | Senha admin do Grafana |
| `PG_HOST` | sim | Host do Postgres (DNS interno do Coolify, ex: `postgres-abc123`) |
| `PG_PORT` | não | Porta Postgres (default `5432`) |
| `PG_DB` | sim | Nome do banco do worker |
| `PG_USER_RO` | sim | Usuário readonly criado no passo abaixo |
| `PG_PASS_RO` | sim | Senha do usuário readonly |
| `LAVINMQ_HOST` | sim | DNS interno do LavinMQ no Coolify (ex: `lavinmq-abc123`) |
| `API_HOST` | sim | DNS interno do `messaging-api` no Coolify |
| `ZAPI_WORKER_HOST` | sim | DNS interno do `wpp-zapi-worker` no Coolify |
| `MODERATION_WORKER_HOST` | sim | DNS interno do `moderation-worker` no Coolify |

Os 4 últimos são consumidos pelo entrypoint do container `prometheus`, que faz `sed` em `prometheus.yml.tpl` e gera o `prometheus.yml` final no startup. Se um placeholder ficar sem substituir, o container falha logo no boot com mensagem clara.

> **Por que imagens custom (Dockerfile.grafana e Dockerfile.prometheus) em vez de bind mount?** Coolify faz bind mount de um diretório persistente do host (`/data/coolify/applications/<id>/...`) que não é atualizado de forma confiável quando arquivos novos aparecem entre deploys. Embarcando os arquivos nas imagens, cada redeploy faz `docker compose build` e os arquivos refletem o estado atual do git.

> **Como descobrir o DNS interno**: no painel do Coolify, abrir o recurso, aba "Service Settings" / "Network" — o nome geralmente é `<service>-<projectId>`. Alternativa: depois que a obs subir, `docker exec observability-prometheus-1 wget -qO- <hostname>:<porta>/metrics` resolve via DNS interno se o nome estiver certo.

## Passos no Coolify

### 1. Criar usuário Postgres readonly

Conectar no Postgres do worker e executar:

```sql
CREATE ROLE grafana_ro WITH LOGIN PASSWORD 'TROCAR-POR-SENHA-FORTE';
GRANT CONNECT ON DATABASE queroplantao_messaging TO grafana_ro;
GRANT USAGE ON SCHEMA public TO grafana_ro;
-- Cobre todas as tabelas referenciadas pelos dashboards atuais.
GRANT SELECT ON
  message_moderations,
  tasks,
  group_messages,
  phone_policies,
  group_participants,
  group_participant_events,
  zapi_instances,
  zapi_instance_connection_events
TO grafana_ro;
```

> Se o role já existe em produção e foi criado antes desta lista, basta re-rodar
> só o bloco `GRANT SELECT ... TO grafana_ro;` — `GRANT` é idempotente. Sem
> isso, os dashboards `tasks` e `phone_policies` retornam "permission denied"
> silencioso ao serem abertos.

Usar essas credenciais em `PG_USER_RO` / `PG_PASS_RO`.

### 2. Garantir networking compartilhado

Prometheus precisa alcançar LavinMQ + API + workers, e Grafana precisa alcançar o Postgres. No Coolify:

- **Opção A (mais simples):** colocar a observabilidade no **mesmo Project** do LavinMQ + Postgres + API + workers. Coolify expõe DNS interno entre serviços do mesmo project.
- **Opção B:** ajustar o `docker-compose.yml` aqui — `networks.shared.external` aponta pro network do project que hospeda os serviços (já configurado).

O DNS interno geralmente vem com hash (`lavinmq-zpgtt474`, `messaging-api-abc...`). Esses nomes vão nas envs `LAVINMQ_HOST`, `API_HOST`, `ZAPI_WORKER_HOST`, `MODERATION_WORKER_HOST` (ver tabela acima).

### 3. Criar o recurso "Docker Compose" no Coolify

- **Source:** Git Repository, branch `main`, **Base Directory:** `/infra/observability`
- **Compose file:** `docker-compose.yml`
- Definir as envs da tabela acima
- Configurar domínio (ex: `grafana.seu-dominio.com`) → porta `3000` do serviço `grafana`, com TLS automático
- Deploy

### 4. Validar

- `https://grafana.seu-dominio.com` → login com `GF_SECURITY_ADMIN_USER` / `..._PASSWORD`
- **Dashboards** → ver "WPP Moderation", "LavinMQ Overview" e "Services — Resources & App" provisionados
- Painéis devem popular se houver dados (worker rodando + mensagens processadas)

Os painéis do dashboard "LavinMQ Overview" usam métricas per-queue (`lavinmq_detailed_queue_*`) que vêm do endpoint `/metrics/detailed`. Se um painel aparecer vazio, validar manualmente com `curl http://<lavinmq-host>:15692/metrics/detailed?family=queue_coarse_metrics` e ajustar o `prometheus.yml` se o nome de alguma família mudou na versão instalada.

### 5. cAdvisor + node-exporter (métricas de infra)

`cadvisor` e `node-exporter` rodam junto na stack de observabilidade e enxergam todos os containers e o host porque a stack é deployada no mesmo host físico/VM dos demais serviços do Coolify.

- **cAdvisor** requer `privileged: true` + Docker socket — aceitável porque o host é dedicado.
- **node-exporter** requer `pid: host` para enxergar processos do host.
- Ambos só comunicam com o Prometheus via network interna `observability` — não têm portas expostas ao host.

Validar: em `http://localhost:9090/targets` (ou via tunnel), todos os jobs devem aparecer **UP** (`prometheus`, `lavinmq`, `lavinmq_detailed`, `cadvisor`, `node_exporter`, `api`, `workers`).

### 6. Métricas da aplicação (`prom-client`)

A API e cada worker expõem `/metrics` na **mesma porta** já usada para `/health`:

| Serviço | Porta | URL |
|---|---|---|
| `messaging-api` | `HTTP_PORT` (default `3000`) | `/metrics` |
| `wpp-zapi-worker` | `WORKER_ZAPI_HEALTH_PORT` (default `3011`) | `/metrics` |
| `moderation-worker` | `WORKER_MODERATION_HEALTH_PORT` (default `3012`) | `/metrics` |

Métricas custom registradas pelo worker:

- `jobs_processed_total{type, status}` — Counter (success | retry | dlq)
- `job_duration_seconds_bucket{type}` — Histogram (buckets `[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]`)
- `jobs_in_flight{type}` — Gauge
- `jobs_dlq_total{type, reason}` — Counter (max_retries | non_retryable | schema_invalid)

Default metrics do `prom-client` ficam sob o prefixo `app_` (`app_nodejs_heap_size_used_bytes`, `app_nodejs_eventloop_lag_seconds_bucket`, `app_process_resident_memory_bytes`, etc).

O dashboard "Services — Resources & App" combina tudo: host (node-exporter), containers (cAdvisor), runtime Node (`app_*`) e jobs (`jobs_*`/`job_duration_*`).

Os hostnames dos scrape jobs `api`, `workers` e `lavinmq` vêm das envs `API_HOST` / `ZAPI_WORKER_HOST` / `MODERATION_WORKER_HOST` / `LAVINMQ_HOST` (ver tabela de envs acima).

## Sentry no worker

No recurso do **worker** (não da observabilidade), adicionar:

| Variável | Descrição |
|---|---|
| `SENTRY_DSN` | DSN do projeto criado no Sentry |
| `SENTRY_ENVIRONMENT` | `production` (ou `staging`) |
| `SENTRY_RELEASE` | opcional — sha do commit |
| `SENTRY_TRACES_SAMPLE_RATE` | opcional — sample rate de tracing (0.0–1.0, default 0.1) |

Sem `SENTRY_DSN`, o init é no-op (dev local não envia eventos).

## Migração pra Dokploy

A migração é trivial porque tudo aqui é versionado no git:

1. No Dokploy, criar recurso "Docker Compose" apontando pro mesmo repo + path `/infra/observability`.
2. Re-digitar as envs (ou usar o import do Coolify se disponível).
3. Recriar o usuário Postgres readonly se o DB também migrou.
4. Aceitar reset do TSDB do Prometheus (histórico zera) ou copiar volume `prometheus_data` via `rsync` com o stack parado.
5. Dashboards e datasources reaparecem automaticamente via provisioning.

Tempo total: ~30min.

## Não-objetivos (próximas fases)

- Loki + Alloy pra logs centralizados.
- Tempo + OTel pra tracing distribuído.
- Alertas no Grafana (configurar manualmente via UI por enquanto).
- postgres-exporter / redis-exporter (métricas de DB/Redis no nível do servidor — hoje só temos via cAdvisor o consumo do container).
