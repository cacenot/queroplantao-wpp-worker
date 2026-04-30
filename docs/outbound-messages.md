# Envio de mensagens (outbound)

Pipeline de envio de mensagens via Z-API com observabilidade rica em DB próprio. Cobre 6 tipos de conteúdo: texto, imagem, vídeo, link, localização e botões de ação. Targets suportados: grupos e contatos diretos.

## Motivação

A tabela `tasks` é uma fila genérica de jobs com lifecycle interno (pending/queued/running/...). Para envios precisamos de mais: histórico das mensagens enviadas, qual instância usou, qual destino, conteúdo enviado, ID retornado pelo provider, e pontos de observação para dashboards (Grafana e in-app). Por isso o envio tem **tabela própria** (`outbound_messages`) que espelha o lifecycle das `tasks` mas mantém os dados de domínio do envio.

A tabela também já carrega campos `batch_id` e `scheduled_for` reservados — bulk send e schedule estão fora de escopo agora, mas a estrutura suporta.

## Pipeline

```
caller ──POST /tasks──┐
                      │
                      ▼
        ┌─────────────────────────┐    INSERT pending
        │ OutboundMessagesService │ ───────────────────► outbound_messages
        │      .send(input)       │                            ▲
        └─────────────┬───────────┘                            │
                      │ taskService.enqueue([job])             │
                      ▼                                        │ UPDATE
                ┌──────────┐   AMQP   ┌──────────┐             │
                │  tasks   │ ───────► │ zapi-    │             │
                └──────────┘          │ worker   │             │
                                      └────┬─────┘             │
                                           │                   │
                                           ▼                   │
                                  ┌──────────────────┐         │
                                  │ sendMessage      │         │
                                  │ action           ├─────────┘
                                  │ switch on kind   │ status: sending → sent | failed
                                  └────┬─────────────┘
                                       │ executor.execute(p => p.sendX())
                                       ▼
                                  ┌──────────┐
                                  │ ZApiClient│  POST /send-{text|image|...}
                                  └──────────┘
```

O `OutboundMessagesService.send` ([src/services/outbound-messages](../src/services/outbound-messages)) é o entry point. Cria a row em `outbound_messages` e enfileira um job `whatsapp.send_message` via `TaskService` ([src/services/task](../src/services/task)). O zapi-worker consome, executa via `ZApiClient` ([src/gateways/whatsapp/zapi/client.ts](../src/gateways/whatsapp/zapi/client.ts)) e atualiza o lifecycle.

Sincronia entre `tasks.status` e `outbound_messages.status` é mantida via:
- **Action** (`sendMessage`) atualiza `sending` → `sent` no caminho feliz e `sending` → `failed` em 4xx Z-API (pré-DLQ).
- **Hook `onTerminalFailure`** no `handler-base` ([src/workers/shared/handler-base.ts](../src/workers/shared/handler-base.ts)) cobre o caso de retries esgotados — antes de publicar na DLQ, marca `outbound_messages` como `failed`. Sem o hook, o estado terminal só apareceria em `tasks` (boa observabilidade exige espelho).

## Tipos de conteúdo

Todos os tipos compartilham o payload base do job:

```ts
{
  providerInstanceId: string,
  outboundMessageId: string,
  target: { kind: "group" | "contact", externalId: string },
  content: { kind: "text" | "image" | "video" | "link" | "location" | "buttons", ... }
}
```

O switch por `content.kind` está em [src/actions/whatsapp/send-message.ts](../src/actions/whatsapp/send-message.ts). Cada kind mapeia 1:1 para um método do `WhatsAppProvider` e um endpoint Z-API:

| kind | endpoint Z-API | campos | restrições |
|---|---|---|---|
| `text` | `POST /send-text` | `message` | — |
| `image` | `POST /send-image` | `imageUrl`, `caption?` | URL pública (Z-API recusa privadas) |
| `video` | `POST /send-video` | `videoUrl`, `caption?` | URL pública |
| `link` | `POST /send-link` | `message`, `linkUrl`, `title?`, `linkDescription?`, `image?` | preview (link unfurl) |
| `location` | `POST /send-location` | `latitude`, `longitude`, `title?`, `address?` | lat ∈ [-90,90], lng ∈ [-180,180] |
| `buttons` | `POST /send-button-actions` | `message`, `buttons[]`, `title?`, `footer?` | máx **3 botões** (limite WhatsApp). Tipo fixo `REPLY` |

**Validação de URL**: apenas formato (`z.url()`) na fronteira do schema. Acessibilidade real é decidida pela Z-API — 4xx vira `NonRetryableError` e a row vai pra `failed`.

## Targets

| kind | `externalId` | observação |
|---|---|---|
| `group` | groupId no formato do provider (`120363...@g.us`) | passa direto no campo `phone` da Z-API (campo polimórfico) |
| `contact` | E.164 (ex.: `+5547997490248`) | normalizado pelo service via `toE164` ([src/lib/phone.ts](../src/lib/phone.ts)). Z-API recebe digits puros via `toZapiDigits` (só dentro do `ZApiClient`, conforme regra do CLAUDE.md). |

`target_external_id` carrega o E.164 quando `target_kind=contact` e o groupId quando `target_kind=group` — queries "por phone" usam `WHERE target_external_id = $phone AND target_kind = 'contact'` (índice `(target_external_id, created_at)` cobre).

Quando `target.kind === "group"`, o service tenta resolver `messaging_group_id` via `messagingGroupsRepo.findByExternalId(externalId, protocol)`. Se o grupo não estiver cadastrado, segue com `NULL` — não bloqueia o envio.

> **Broadcast lists** ainda não são suportadas. Adicionar `"broadcast"` ao enum + endpoint Z-API correspondente quando necessário.

## Modelo de dados

Schema completo em [src/db/schema/outbound-messages.ts](../src/db/schema/outbound-messages.ts).

**Enums novos**:
- `outbound_message_status`: `pending | queued | sending | sent | failed | dropped`
- `outbound_message_target_kind`: `group | contact`
- `outbound_message_content_kind`: `text | image | video | link | location | buttons`

**Reusados**: `messaging_protocol`, `messaging_provider_kind` (de `provider-registry`).

**Colunas chave**:

| coluna | uso |
|---|---|
| `id` | UUID PK — referenciado no payload do job |
| `protocol`, `provider_kind`, `provider_instance_id` | qual instância enviou |
| `target_kind`, `target_external_id` | destino |
| `messaging_group_id` | FK → `messaging_groups` (nullable) |
| `content_kind`, `content` (jsonb) | payload completo do envio |
| `external_message_id` | ID retornado pela Z-API (`messageId`/`zaapId`/`id`) |
| `status`, `attempt`, `error` | lifecycle e diagnóstico |
| `task_id` | FK → `tasks` (rastreio bidirecional) |
| `idempotency_key` | UNIQUE (parcial, `WHERE NOT NULL`) — dedup explícito |
| `batch_id` | reservado para bulk send (sem FK ainda) |
| `scheduled_for` | reservado para schedule (`NULL` = imediato) |
| `requested_by` | quem disparou (api-key id, `"internal"`, etc.) |
| `created_at`, `updated_at`, `queued_at`, `sent_at`, `failed_at` | timestamps de cada transição |

**Índices**:
- `(status, created_at)` — dashboards "envios por status"
- `(provider_instance_id, created_at)` — observabilidade por instância
- `(target_external_id, created_at)` — histórico por grupo/contato
- `(content_kind, created_at)` — distribuição de tipos
- `(idempotency_key)` UNIQUE parcial
- `(batch_id, status)` — queries de bulk no futuro

## Lifecycle

```
                              ┌──────────────┐
                              │   pending    │  INSERT pelo service
                              └──────┬───────┘
                                     │ taskService.enqueue → setTaskId
                                     ▼
                              ┌──────────────┐
                              │   queued     │  task publicada na fila
                              └──────┬───────┘
                                     │ worker consume + action.markSending
                                     ▼
                              ┌──────────────┐
                              │   sending    │  attempt += 1
                              └──┬───────┬───┘
                       success   │       │   error
                                 ▼       ▼
                          ┌────────┐  ┌──────────────────┐
                          │  sent  │  │ retry transitório│
                          └────────┘  └────────┬─────────┘
                                              │ próxima tentativa volta a sending
                                              │ (até maxRetries)
                                              ▼
                                    ┌──────────────────┐
                                    │   failed (DLQ)   │  via onTerminalFailure
                                    └──────────────────┘
```

- **`pending`**: row criada, ainda não foi enfileirada (raro — só se `setTaskId` falhar).
- **`queued`**: `setTaskId` confirmou que a task entrou no AMQP.
- **`sending`**: worker reivindicou e está executando (incrementa `attempt`).
- **`sent`**: terminal — Z-API respondeu com `messageId`. Preenche `external_message_id` e `sent_at`.
- **`failed`**: terminal — DLQ. Causa em `error` (jsonb com `{ message, name?, stack? }`).
- **`dropped`**: schema inválido. Não esperado em fluxo normal — só se algo bypassar o schema Zod.

> Em retries transitórios (timeout/5xx), a row permanece em `sending` entre tentativas. Entre o esgotamento de retries e o `onTerminalFailure` não há janela de inconsistência relevante — ambos rodam no mesmo handler antes do `publishOrRequeue` da DLQ.

## Idempotência

Duas camadas distintas:

1. **`job.id` (UUID, no enqueue)** — `tasks.insertMany` usa `ON CONFLICT DO NOTHING` em `tasks.id`. Re-publish do mesmo job é seguro.
2. **`idempotency_key` (no service)** — UNIQUE parcial em `outbound_messages.idempotency_key WHERE IS NOT NULL`. Caller passa essa chave para garantir que duas chamadas ao `send()` com a mesma chave retornem a row original sem novo enqueue.

A idempotência por chave é mais alta na cadeia: protege contra retry de **request** (cliente HTTP que não recebeu resposta e refaz a chamada), antes mesmo do job chegar no AMQP.

## Erros e classificação

`sendMessage` action ([src/actions/whatsapp/send-message.ts](../src/actions/whatsapp/send-message.ts)) classifica:

| Erro | Tratamento | Outbound | Task |
|---|---|---|---|
| `ZApiTimeoutError` | propaga (retryable) | permanece `sending` | retry queue |
| `ZApiError` 4xx (≠ timeout) | wrap em `NonRetryableError` | `failed` (action) | DLQ direto |
| `ZApiError` 5xx | propaga (retryable) | permanece `sending` | retry queue |
| Demais (rede, parse, etc.) | propaga (retryable) | permanece `sending` | retry queue |
| Retries esgotados | DLQ | `failed` (via hook) | `failed` |

**4xx Z-API → DLQ direto** porque cobre: payload inválido, número inexistente, instância desconectada. Re-tentar não muda nada e gasta cota.

**5xx → retry** porque pode ser instabilidade temporária do provider.

## Como chamar

Sem endpoint HTTP novo nesta fase. Há duas formas:

1. **Direto via service** (em scripts ou outros services internos):

   ```ts
   const outcome = await outboundMessagesService.send({
     providerInstanceId: "...",
     target: { kind: "contact", phone: "5547997490248" },
     content: { kind: "text", message: "olá" },
     idempotencyKey: "my-unique-key", // opcional
   });
   // outcome: { outboundMessageId, taskId, status: "queued" | "deduplicated" }
   ```

2. **Via `POST /tasks` existente**: o job `whatsapp.send_message` faz parte do `discriminatedUnion` em [src/jobs/schemas.ts](../src/jobs/schemas.ts) e é aceito automaticamente pela rota. Mas o caller precisa criar a row em `outbound_messages` primeiro (com o `outboundMessageId` que vai no payload). Por isso, na prática, **sempre passe pelo service** — o caminho `POST /tasks` direto deixa a row em `pending` órfã e perde a idempotência.

Quando precisar de endpoint HTTP, criar `src/api/modules/outbound-messages/` com TypeBox seguindo o padrão de `provider-instances`.

## Como adicionar um novo `content.kind`

1. Adicionar literal ao `outboundMessageContentKindEnum` em [src/db/schema/outbound-messages.ts](../src/db/schema/outbound-messages.ts) e gerar migration (`bun run db:generate`).
2. Adicionar variante ao `outboundContentSchema` em [src/jobs/schemas.ts](../src/jobs/schemas.ts).
3. Adicionar tipo `SendXPayload` e método `sendX` na interface `WhatsAppProvider` em [src/gateways/whatsapp/types.ts](../src/gateways/whatsapp/types.ts).
4. Implementar `sendX` no [`ZApiClient`](../src/gateways/whatsapp/zapi/client.ts) usando o helper `postSend`.
5. Adicionar case ao `dispatchSend` em [src/actions/whatsapp/send-message.ts](../src/actions/whatsapp/send-message.ts).
6. Adicionar testes (unit no client + schema + dispatch).

Adicionar um novo provider WhatsApp (WhatsMeow, Business API): a action é agnóstica — só estender a interface e implementar lá. A ação já existe e roteia certo.

## Observabilidade — queries SQL prontas

```sql
-- Envios por status nas últimas 24h
SELECT status, count(*) FROM outbound_messages
WHERE created_at > now() - interval '24 hours'
GROUP BY status;

-- Latência média e p95 por instância (último 7 dias)
SELECT
  provider_instance_id,
  count(*) AS total,
  avg(extract(epoch from sent_at - created_at)) AS avg_s,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch from sent_at - created_at)) AS p95_s
FROM outbound_messages
WHERE status = 'sent' AND created_at > now() - interval '7 days'
GROUP BY provider_instance_id;

-- Taxa de falha por content_kind (último 24h)
SELECT
  content_kind,
  count(*) FILTER (WHERE status = 'failed') AS failed,
  count(*) FILTER (WHERE status = 'sent') AS sent,
  round(
    100.0 * count(*) FILTER (WHERE status = 'failed')::numeric / nullif(count(*), 0),
    2
  ) AS failure_rate_pct
FROM outbound_messages
WHERE created_at > now() - interval '24 hours'
GROUP BY content_kind
ORDER BY content_kind;

-- Top 20 destinos com mais envios (último 7 dias)
SELECT target_external_id, count(*) AS envios
FROM outbound_messages
WHERE created_at > now() - interval '7 days'
GROUP BY target_external_id
ORDER BY envios DESC LIMIT 20;
```

Tasks órfãs em `sending` (worker crashou no meio): `WHERE status = 'sending' AND updated_at < now() - interval '5 minutes'`. Reaper futuro pode varrer e marcar como `failed`.

## Variáveis de ambiente

Nada novo. Reusa `ZAPI_BASE_URL`, `ZAPI_CLIENT_TOKEN`, `ZAPI_REQUEST_TIMEOUT_MS` do client e `AMQP_*` do publisher/worker.

## Roadmap

Fora de escopo agora, mas a estrutura suporta:

- **Bulk send**: campo `batch_id` reservado. Próxima iteração: tabela `outbound_message_batches` + service que cria N rows com mesmo `batch_id` em uma única transação, depois `taskService.enqueue([...])` em batch.
- **Schedule**: campo `scheduled_for` reservado. Solução com fila atrasada (`x-message-ttl` no AMQP) ou worker scheduler que move `pending`+`scheduled_for <= now()` para enqueue.
- **Broadcast lists**: adicionar `"broadcast"` ao `outbound_message_target_kind` e implementar endpoint Z-API correspondente.
- **Endpoint HTTP dedicado**: `POST /outbound-messages` em `src/api/modules/outbound-messages/` quando passar a ser exposto a callers externos.
- **Reaper**: já listado em `docs/architecture.md` como follow-up; sincroniza outbound em `sending` órfão com a fonte de verdade (DLQ).
