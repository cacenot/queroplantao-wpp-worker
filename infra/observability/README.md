# Observabilidade — Prometheus + Grafana + Sentry

Stack self-hosted (Prometheus + Grafana) lendo:
- métricas de fila do **LavinMQ** via endpoint `/metrics` nativo (porta `15692`),
- agregações de moderação via **Postgres** (queries SQL na tabela `message_moderations`).

Erros do worker vão pro **Sentry** (SaaS, plano free).

## Estrutura

```
infra/observability/
├── docker-compose.yml
├── prometheus/prometheus.yml
└── grafana/provisioning/
    ├── datasources/
    │   ├── prometheus.yml
    │   └── postgres.yml
    └── dashboards/
        ├── default.yml      # provider
        ├── lavinmq.json     # filas (Prometheus)
        └── moderation.json  # moderação por IA (SQL)
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

Usar essas credenciais em `PG_USER_RO` / `PG_PASS_RO`.

### 2. Garantir networking compartilhado

Prometheus precisa alcançar o LavinMQ na porta `15692`, e Grafana precisa alcançar o Postgres. No Coolify:

- **Opção A (mais simples):** colocar a observabilidade no **mesmo Project** do LavinMQ + Postgres. Coolify expõe DNS interno entre serviços do mesmo project.
- **Opção B:** ajustar o `docker-compose.yml` aqui — trocar `networks.shared` para `external: true` apontando pro network do project do LavinMQ/Postgres.

Verificar o nome DNS interno que o Coolify atribui ao serviço LavinMQ (ex: `lavinmq-xyz123`) e atualizar `prometheus/prometheus.yml` se diferente de `lavinmq:15692`.

### 3. Criar o recurso "Docker Compose" no Coolify

- **Source:** Git Repository, branch `main`, **Base Directory:** `/infra/observability`
- **Compose file:** `docker-compose.yml`
- Definir as envs da tabela acima
- Configurar domínio (ex: `grafana.seu-dominio.com`) → porta `3000` do serviço `grafana`, com TLS automático
- Deploy

### 4. Validar

- `https://grafana.seu-dominio.com` → login com `GF_SECURITY_ADMIN_USER` / `..._PASSWORD`
- **Dashboards** → ver "WPP Moderation" e "LavinMQ Overview" provisionados
- Painéis devem popular se houver dados (worker rodando + mensagens processadas)

Os painéis do dashboard "LavinMQ Overview" usam métricas per-queue (`lavinmq_detailed_queue_*`) que vêm do endpoint `/metrics/detailed`. Se um painel aparecer vazio, validar manualmente com `curl http://<lavinmq-host>:15692/metrics/detailed?family=queue_coarse_metrics` e ajustar o `prometheus.yml` se o nome de alguma família mudou na versão instalada.

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

- `prom-client` no worker pra métricas em tempo real (hoje está tudo no Postgres + LavinMQ).
- Loki + Alloy pra logs centralizados.
- Tempo + OTel pra tracing distribuído.
- Alertas no Grafana (configurar manualmente via UI por enquanto).
