# Arquitetura

Referência rápida para navegar o código e saber onde mexer. Se você nunca tocou este repositório antes, este é o ponto de partida.

## Visão geral

O projeto é um **worker + API** que executa ações em plataformas de messaging (hoje WhatsApp via Z-API; em breve WhatsMeow, WhatsApp Business API e Telegram). Dois serviços independentes:

- **API** (`src/api/`) — HTTP server (Elysia) que recebe tasks via `POST /tasks`, expõe CRUD de provider instances em `/providers/instances` e publica na fila AMQP. Documentação OpenAPI em `/docs`.
- **Worker** (`src/worker/`) — consumer AMQP que executa cada job contra o provider correto, com rate limiting distribuído via Redis.

Rodam em containers separados (`docker-compose.api.yml` e `docker-compose.worker.yml`), compartilham o mesmo código.

## Fluxos

### Outbound (ação disparada por terceiro)

```
┌──────────┐   POST /tasks    ┌─────┐   publish    ┌────────┐   consume    ┌────────┐
│ cliente  │ ───────────────▶ │ API │ ───────────▶ │ AMQP   │ ───────────▶ │ worker │
└──────────┘                  └─────┘              └────────┘              └───┬────┘
                                                                               │
                                                    validate + route (by type) │
                                                                               ▼
                                                                         ┌──────────┐
                                                                         │  action  │
                                                                         └────┬─────┘
                                                                              │ execute
                                                                              ▼
                                                                 ┌─────────────────────┐
                                                                 │  ProviderGateway<T> │
                                                                 │  (rate limit Redis) │
                                                                 └──────────┬──────────┘
                                                                            │ fn(provider)
                                                                            ▼
                                                                      ┌──────────┐
                                                                      │ provider │ (Z-API)
                                                                      └────┬─────┘
                                                                           │ HTTP
                                                                           ▼
                                                                      WhatsApp
```

### Inbound (webhook recebido do provider)

```
┌──────────┐   POST webhook   ┌─────┐   normalize   ┌─────┐   publish   ┌────────┐
│ provider │ ───────────────▶ │ API │ ────────────▶ │ AMQP│ ──────────▶ │ worker │
└──────────┘  (ex: Z-API)     └─────┘  (to job)     └─────┘             └────────┘
                                  │
                                  └─ src/api/routes/webhooks/{provider}.ts
```

A pasta `src/api/routes/webhooks/` está pronta; os handlers específicos são um próximo PR.

## Camadas e responsabilidades

| Pasta | Dono de | NÃO deve conter |
|---|---|---|
| `src/api/` | Entry point da API (Elysia), plugins compartilhados (auth), swagger em `/docs`. | Regra de negócio, acesso a messaging provider. |
| `src/api/plugins/` | Plugins Elysia reutilizáveis (ex.: `auth.ts`). | Lógica de rota. |
| `src/api/routes/` | Um arquivo por grupo de rotas (`tasks.ts`, `provider-instances.ts`, `webhooks/{provider}.ts`). Validação (Zod para `/tasks`, TypeBox para o restante), publish no AMQP. | Código compartilhado entre rotas (extrair para `src/lib/`). |
| `src/api/schemas/` | Schemas TypeBox reutilizáveis consumidos pelas rotas Elysia. Gera OpenAPI automaticamente. | Validação de domínio (fica em Zod). |
| `src/worker/` | Entry point do worker, consumer AMQP, health check, `handler.ts` (router job → action). | HTTP server, providers. |
| `src/messaging/` | Abstração cross-protocol: interface base, `ProviderGateway<T>`. | Lógica de negócio, conhecimento de jobs/AMQP. |
| `src/messaging/{protocol}/` | Interface do protocolo (`WhatsAppProvider`, `TelegramProvider`) e payloads. | |
| `src/messaging/{protocol}/{impl}/` | Implementação concreta do provider (ex.: `zapi/client.ts`). | |
| `src/actions/{protocol}/` | Lógica de negócio por plataforma. Recebem `Executor` injetado. | Conhecimento de AMQP, HTTP, provider concreto. |
| `src/ai/` | Modelos e classificador LLM. | Lógica de ação. |
| `src/jobs/` | Types e schemas Zod dos jobs que trafegam no AMQP. | Lógica de execução. |
| `src/db/` | Conexão Postgres, schema Drizzle e migrations. | Lógica de domínio e regras de negócio. |
| `src/db/repositories/` | Acesso bruto a tabelas Drizzle. Retorna tipos de DB. Sem regra de negócio. | Regras de negócio, orquestração. |
| `src/services/` | Services de aplicação para leitura/escrita de dados, transações, regras de negócio, DTOs. | Entry points HTTP/AMQP e providers concretos. |
| `src/lib/` | Infra compartilhada: AMQP, Redis, logger, clients HTTP externos. | Lógica de domínio. |
| `src/config/` | `env.ts` — parse e validação de variáveis. | |
| `src/scripts/` | Scripts auxiliares (spam watcher, bulk remove, moderação offline). | |

**Regra geral de dependência:** `api` e `worker` dependem de `actions/messaging/jobs/ai`. `actions` dependem de `messaging` (interface) e `ai` e `db`. `messaging` não depende de `actions` nem de `jobs`. `lib` não depende de nada do domínio.

## Protocolos de messaging — por que interfaces separadas

WhatsApp e Telegram têm conceitos parecidos (mensagens, grupos, participantes) mas primitivas diferentes:

- **WhatsApp**: identificador é telefone (`5511...@s.whatsapp.net`), grupos têm `groupId` específico, Business API tem templates/HSM e janela de 24h.
- **Telegram**: identificador é `chat_id` numérico, bots têm inline queries, arquivos com `file_id`.

Unificar em uma única interface forçaria o menor denominador comum e perderia capacidades nativas. Por isso cada protocolo tem sua própria interface (`WhatsAppProvider`, `TelegramProvider`) que estende a base `MessagingProvider`. As actions também são organizadas por protocolo (`src/actions/whatsapp/`, `src/actions/telegram/`).

O que é **compartilhado**: o rate limiter (`ProviderGateway<T>`), porque o algoritmo (acquire/release com Lua atômico no Redis) funciona para qualquer protocolo — só o `redisKey` muda.

## Provider registry

O bootstrap dos providers começou a migrar de env vars para banco.

- A tabela base `messaging_provider_instances` guarda o que é comum a qualquer provider: protocolo, tipo concreto, nome, habilitação e defaults de execução.
- A tabela `zapi_instances` guarda o que é específico da Z-API por instância: `zapi_instance_id`, `instance_token` e o snapshot atual de conexão/device.
- As tabelas `zapi_instance_connection_events` e `zapi_instance_device_snapshots` são append-only e preservam histórico para futuros webhooks e sincronizações.
- O `Client-Token` da Z-API **não** fica no banco. Ele é um segredo compartilhado por integração e fica em `ZAPI_CLIENT_TOKEN` na env.
- Enquanto a migração não termina, `ZAPI_INSTANCES` continua existindo como fallback legado no worker.
- CRUD via HTTP: `MessagingProviderInstanceService` (`src/services/messaging-provider-instance/`) é o caminho de escrita. `ProviderRegistryReadService` agora delega ao `MessagingProviderInstanceRepository` e continua sendo o caminho de leitura usado pelo worker no bootstrap.
- Mudanças via API só efetivam no worker no próximo restart — ver `docs/provider-gateway.md`.

Detalhes operacionais do gateway e da lease distribuída: `docs/provider-gateway.md`.

## Persistência de tasks

Cada job publicado no AMQP é persistido como uma linha na tabela `tasks` antes do publish. O `TaskService` (`src/services/task/`) centraliza criação e transições de estado, permitindo que qualquer produtor (API, webhooks, scripts) use `taskService.enqueue([...jobs])`.

### Ciclo de vida

```
pending → queued → running → succeeded | failed
                                        ↳ dropped (schema inválido no worker)
```

- **pending**: inserido no DB, ainda não confirmado pelo broker.
- **queued**: `publisher.send` retornou com sucesso (broker ack via `confirm: true`).
- **running**: worker reivindicou a task (`claimForExecution` faz UPDATE atômico com `status IN ('queued','pending')`).
- **succeeded / failed**: terminal. Worker atualiza após executar a action.
- **dropped**: job com schema inválido recebido pelo worker (defensivo).

### Idempotência

- INSERT usa `ON CONFLICT DO NOTHING` — cliente pode re-enviar o mesmo `job.id` sem erro.
- Worker verifica estado antes de executar: se a task já está terminal, faz DROP sem re-executar (protege contra redelivery após crash).

### Robustez

- Escritas de estado no worker são **best-effort**: se o UPDATE falha após a action executar, o job já foi processado; logamos warn e seguimos (evita re-execução).
- Tasks que ficam em `pending` (API crashou entre INSERT e publish) são detectáveis por query: `status = 'pending' AND created_at < now() - interval '5 minutes'`. O reaper automático é um follow-up planejado.

### Limitações atuais

- Sem reaper automático para tasks órfãs em `pending`/`running`.
- Sem retry controlado / DLQ (o campo `attempt` já é incrementado pelo `claimForExecution`; falta o mecanismo de re-publish).
- Endpoints HTTP de leitura (`GET /tasks`, `GET /tasks/:id`) não expostos ainda — repo e service já suportam.

## Como adicionar um novo provider

### WhatsApp (ex.: WhatsMeow)

1. Criar `src/messaging/whatsapp/whatsmeow/types.ts` com o shape de configuração da instância.
2. Criar `src/messaging/whatsapp/whatsmeow/client.ts` com `class WhatsMeowClient implements WhatsAppProvider`. Deve expor `readonly instance: WhatsAppInstance` (com `id` único por instância).
3. Criar `src/messaging/whatsapp/whatsmeow/provider.ts` com um factory (`createWhatsMeowProviders(configs)`).
4. Adicionar a tabela específica do provider em `src/db/schema/` e um service de leitura em `src/services/` para materializar configs habilitadas.
5. Em `src/worker/index.ts`, concatenar os providers no array passado ao `ProviderGateway`:
   ```typescript
   providers: [
     ...createZApiProviders(zapiConfigs),
     ...createWhatsMeowProviders(whatsmeowConfigs),
   ]
   ```

Zero mudança nas actions.

### Telegram (protocolo novo)

1. Criar `src/messaging/telegram/types.ts` com `TelegramProvider` estendendo `MessagingProvider`.
2. Criar `src/messaging/telegram/{impl}/` com a implementação (ex.: `bot-api/`).
3. Instanciar um **segundo** `ProviderGateway<TelegramProvider>` em `src/worker/index.ts` com `redisKey: "messaging:telegram"`.
4. Criar actions em `src/actions/telegram/`.
5. Adicionar novos `type` ao discriminated union em `src/jobs/types.ts` e `src/jobs/schemas.ts` com prefixo `telegram.`. Estender o switch em `src/worker/handler.ts`.

## Rate limiting distribuído

O `ProviderGateway` suporta duas estratégias por provider:

- **Leased**: coordenação distribuída por instância via Redis.
- **Passthrough**: execução direta, sem acquire/release distribuído.

Para providers `leased`, o Redis mantém:

- **Sorted Set**: `messaging:{protocolo}` com score = `available_at`
- **Ownership key**: `messaging:{protocolo}:lease:{providerId}` com token + TTL

O fluxo de lease usa scripts Lua para:

- adquirir a lease com ownership token
- renovar a lease por heartbeat
- liberar a lease com proteção contra stale release

Os detalhes completos estão em `docs/provider-gateway.md`.

### Debug

```bash
redis-cli ZRANGE messaging:whatsapp 0 -1 WITHSCORES
# score <= now   → provider leased disponível
# score > now    → provider leased busy ou em cooldown
```

## Contratos de job

Todos os jobs seguem o formato:

```typescript
{
  id: string;                  // UUID, para logs e futura dedup
  type: "{protocolo}.{ação}";  // ex.: "whatsapp.delete_message"
  createdAt: string;           // ISO-8601 UTC
  payload: { ... };            // específico por type
  attempt?: number;            // opcional, para retry controlado (não implementado ainda)
}
```

### Adicionar um novo tipo de job

1. Adicionar o payload e o type literal em `src/jobs/types.ts`.
2. Adicionar o `z.literal` + payload schema em `src/jobs/schemas.ts` e incluir no `discriminatedUnion`.
3. Adicionar o valor ao `taskTypeEnum` em `src/db/schema/tasks.ts` e gerar migration (`bunx drizzle-kit generate`).
4. Adicionar o case no switch de `src/worker/handler.ts`.
5. Criar a action correspondente em `src/actions/{protocolo}/`.

## Variáveis de ambiente

| Variável | Tipo | Default | Consumidores |
|---|---|---|---|
| `DATABASE_URL` | string | — | Worker |
| `AMQP_URL` | string (URL) | — | API + Worker |
| `AMQP_QUEUE` | string | — | API + Worker |
| `AMQP_PREFETCH` | number | 5 | Worker |
| `ZAPI_BASE_URL` | string (URL) | — | Worker |
| `ZAPI_CLIENT_TOKEN` | string | — | Worker |
| `ZAPI_INSTANCES` | JSON array | — | Worker (fallback legado durante migração) |
| `ZAPI_DELAY_MIN_MS` | number | 500 | Worker |
| `ZAPI_DELAY_MAX_MS` | number | 1800 | Worker |
| `REDIS_URL` | string (URL) | — | Worker |
| `HTTP_PORT` | number | 3000 | API |
| `HTTP_API_KEY` | string | — | API |
| `WORKER_HEALTH_PORT` | number | 3001 | Worker |
| `QP_ADMIN_API_URL` | string (URL) | — | Worker |
| `QP_ADMIN_API_TOKEN` | string | — | Worker |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | string | — | Worker (só o do provider ativo) |
| `AI_MODEL_ANALYZE_MESSAGE` | string | `openai/gpt-4o-mini` | Worker |
| `SPAM_FILTERS` / `SPAM_INTERVAL_MS` | string / number | — / 120000 | scripts |

Schema completo e validação: `src/config/env.ts`.

## Decisões arquiteturais

### Interfaces de messaging separadas por protocolo

WhatsApp e Telegram compartilham conceitos mas não primitivas. Uma interface única teria que aceitar tanto `phone` quanto `chat_id`, expor ou esconder capacidades por feature flag, e vazaria abstração nas actions. Separar evita isso; o que é comum (rate limiter) vive em `ProviderGateway<T>` genérico.

### Elysia como framework HTTP

Antes usávamos `Bun.serve` puro com 2 rotas. Com a adição do CRUD de provider instances passamos para 7+ rotas e precisamos de OpenAPI para o serviço consumidor. Elysia roda nativamente em Bun, gera OpenAPI a partir de schemas TypeBox e tem suporte de `@elysiajs/swagger` em `/docs` sem overhead significativo. Rotas ficam em arquivos separados (`src/api/routes/*.ts`), cada um exportando uma função que retorna um `new Elysia()` plugável via `.use(...)` no `src/api/server.ts`.

### Validação: Zod para domínio, TypeBox para I/O HTTP

Zod continua sendo a ferramenta padrão para validação de domínio (`src/jobs/schemas.ts`, `src/services/provider-registry/zod.ts`, `src/config/env.ts`). Para as novas rotas Elysia usamos TypeBox (`import { t } from "elysia"`) porque é o que alimenta a geração automática do OpenAPI. A rota `POST /tasks` mantém Zod por hora — a complexidade do `discriminatedUnion` dos jobs não compensa a migração para TypeBox só para OpenAPI dessa rota específica.

### Webhooks inbound como rotas HTTP, não módulo à parte

São endpoints HTTP que validam assinatura, normalizam o evento e publicam no AMQP. Não justifica um módulo separado hoje. Se a normalização de um provider específico crescer muito (vários arquivos), extrai para seu próprio módulo na hora.

### Rate limiting no Redis, não em processo

Múltiplos workers precisam compartilhar o estado de disponibilidade das instâncias. Lua scripts no Redis garantem atomicidade entre processos. O `safetyTtlMs` cobre worker crashado no meio da execução.

### Prefixo de protocolo no `type` do job

Permite ter `delete_message` tanto para WhatsApp quanto Telegram no futuro sem colisão. O router em `handler.ts` usa o discriminated union do Zod para despachar type-safe.

### Sem retry/DLQ implementado ainda

Política atual: job com schema inválido ou que lance erro → `ConsumerStatus.DROP` (descarta). TODO em `src/worker/handler.ts` marca o ponto de implementar retry controlado com incremento de `attempt` e DLQ. Aceitável enquanto o projeto está em desenvolvimento.
