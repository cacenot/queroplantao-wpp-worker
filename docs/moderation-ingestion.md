# Moderação de mensagens — fluxo ponta a ponta

## Visão geral

```
Z-API webhook
     │
     ▼
POST /webhooks/zapi/on-message-received
     │  validação de secret (timing-safe)
     │  parse Zod (zapiReceivedWebhookSchema)
     ▼
extractZapiGroupMessage()
     │  filtros de descarte (ver lista abaixo)
     │  extração de conteúdo normalizado
     ▼
GroupMessagesService.ingestZapi()
     │  ① isMonitored? → Redis SISMEMBER / fallback Postgres
     │  ② compute ingestionDedupeHash + contentHash
     │  ③ upsertByIngestionHash → isNew?
     │       duplicata → retorna "duplicate", fim
     │  ④ findReusable(contentHash, version, 15d)
     │       hit → cria row "cached", atualiza group_messages → "reused"
     │       miss → cria row "fresh/pending", enfileira job → "queued"
     ▼
AMQP: whatsapp.moderate_group_message { moderationId }
     │
     ▼
moderateGroupMessage()
     │  carrega message_moderations + group_messages por moderationId
     │  verifica status='pending' (guard de idempotência)
     │  chama classifyMessage(normalizedText | caption)
     │  markAnalyzed → atualiza message_moderations
     │  setModerationStatus('analyzed') → atualiza group_messages
     │  em erro: markFailed + setModerationStatus('failed')
```

---

## Filtros de descarte (ordem de avaliação)

| Razão | Condição |
|---|---|
| `newsletter` | `payload.isNewsletter === true` |
| `broadcast` | `payload.broadcast === true` |
| `not-group` | `payload.isGroup !== true` |
| `from-me` | `payload.fromMe === true` |
| `notification` | `payload.notification` é string não-vazia |
| `status-reply` | `type === "ReplyMessage"` e `status === "STATUS"` |
| `waiting-message` | `payload.waitingMessage === true` |
| `audio` | `payload.audio` presente |
| `sticker` | `payload.sticker` presente |
| `reaction` | `payload.reaction` presente |
| `gif` | mime type de image ou video contém "gif" |
| `missing-identifiers` | `phone` ou `messageId` ausentes; ou `participantPhone` e `participantLid` ausentes |
| `group-not-monitored` | grupo não encontrado no cache Redis nem no Postgres local |
| `unsupported-content` | tipo de mensagem não reconhecido |
| `no-text-content` | `hasText === false` e `caption === null` |

---

## Estratégia de dois hashes

### `ingestion_dedupe_hash` (unique em `group_messages`)

**Propósito**: colapsar cópias do mesmo evento chegando de múltiplas instâncias Z-API redundantes (tipicamente 3+ instâncias recebem o mesmo webhook em poucos segundos).

**Fórmula**:
```
sha256(
  protocol + ":" +
  groupExternalId + ":" +
  (senderPhone ?? senderExternalId ?? "unknown") + ":" +
  (normalizedText ?? mediaUrl ?? "") + ":" +
  floor(sentAt.getTime() / INGESTION_DEDUPE_WINDOW_MS)
)
```

**Janela**: `INGESTION_DEDUPE_WINDOW_MS` (default 60 000 ms = 1 minuto).

**Preservação de mensagens distintas**: mesma fórmula para mensagem de outro usuário, outro grupo ou fora da janela → hash diferente → linha nova.

### `content_hash` (index não-unique em `group_messages` e em `message_moderations`)

**Propósito**: detectar conteúdo idêntico e reaproveitar análise de moderação sem chamar o LLM novamente.

**Fórmula**:
```
sha256(normalizedText ?? mediaUrl ?? "")
```

Sem grupo, sem remetente, sem timestamp. Puro conteúdo.

**Janela de reuso**: `MODERATION_REUSE_WINDOW_MS` (default 15 dias). Respeita a evolução das regras (bump de `MODERATION_VERSION` invalida o cache automaticamente porque a versão entra no filtro de lookup).

---

## Schema das tabelas

### `group_messages`

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `ingestion_dedupe_hash` | text UNIQUE NOT NULL | sha256 dedup de ingestão |
| `content_hash` | text NOT NULL | sha256 de conteúdo, indexed |
| `protocol` | enum `messaging_protocol` | `whatsapp` / `telegram` |
| `provider_kind` | enum `messaging_provider_kind` | `whatsapp_zapi` / `telegram_bot` / `whatsapp_whatsmeow` |
| `provider_instance_id` | uuid FK nullable | FK → `messaging_provider_instances.id` |
| `group_external_id` | text NOT NULL | ID do grupo no provider |
| `messaging_group_id` | uuid FK nullable | FK → `messaging_groups.id` |
| `sender_phone` | text nullable | E.164 |
| `sender_external_id` | text nullable | LID no WhatsApp, `from.id` no Telegram |
| `sender_name` | text nullable | |
| `external_message_id` | text NOT NULL | ID da mensagem no provider |
| `reference_external_message_id` | text nullable | mensagem respondida |
| `message_type` | text NOT NULL | `text`/`image`/`video`/`document`/`location`/`contact`/`interactive`/`poll`/`commerce`/`event` |
| `message_subtype` | text nullable | ex `list_response`, `buttons_response` |
| `has_text` | boolean NOT NULL | |
| `normalized_text` | text nullable | |
| `media_url` | text nullable | |
| `thumbnail_url` | text nullable | |
| `mime_type` | text nullable | |
| `caption` | text nullable | |
| `sent_at` | timestamptz NOT NULL | |
| `from_me` | boolean NOT NULL default false | |
| `is_forwarded` | boolean NOT NULL default false | |
| `is_edited` | boolean NOT NULL default false | |
| `moderation_status` | enum `message_moderation_status` default `pending` | denormalização para fila de pendentes |
| `current_moderation_id` | uuid FK nullable | ponteiro para moderação vigente |
| `first_seen_at` | timestamptz NOT NULL | |
| `last_seen_at` | timestamptz NOT NULL | atualizado em redeliveries |
| `created_at` / `updated_at` | timestamptz | |

**Índices**:
- `ingestion_dedupe_hash_idx` (unique)
- `content_hash_idx`
- `group_protocol_sent_at_idx (protocol, group_external_id, sent_at)`
- `moderation_status_idx (moderation_status, created_at)`

### `group_messages_zapi`

| Coluna | Tipo |
|---|---|
| `group_message_id` | uuid PK FK cascade |
| `zapi_instance_external_id` | text NOT NULL |
| `connected_phone` | text |
| `chat_name` | text |
| `status` | text |
| `sender_lid` | text |
| `waiting_message` | boolean |
| `view_once` | boolean |
| `extracted_payload` | jsonb |
| `raw_payload` | jsonb NOT NULL |
| `received_at` | timestamptz NOT NULL |

### `message_moderations`

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `group_message_id` | uuid FK NOT NULL cascade | 1 mensagem → N moderações (versões diferentes) |
| `content_hash` | text NOT NULL | redundância — permite reuso sem JOIN |
| `moderation_version` | text NOT NULL | ex `v1`, `2026-04-01-prompt-v3` |
| `model` | text NOT NULL | identificador do LLM, ex `openai/gpt-4o-mini` |
| `source` | enum `message_moderation_source` | `fresh` / `cached` |
| `source_moderation_id` | uuid FK nullable self-ref | preenchido quando `source='cached'` |
| `status` | enum `message_moderation_status` default `pending` | `pending` / `analyzed` / `failed` |
| `reason` | text nullable | |
| `partner` | text nullable | ex `quero-plantao` |
| `category` | text nullable | filtrável |
| `confidence` | numeric(3,2) nullable | |
| `action` | text nullable | `allow` / `remove` / `ban` |
| `raw_result` | jsonb nullable | `MessageAnalysis` completo (audit) |
| `prompt_tokens` | integer nullable | |
| `completion_tokens` | integer nullable | |
| `latency_ms` | integer nullable | |
| `error` | jsonb nullable | preenchido quando `status='failed'` |
| `created_at` | timestamptz NOT NULL | |
| `completed_at` | timestamptz nullable | preenchido ao chegar em estado terminal |

**Índices**:
- `group_message_version_idx` (unique on `group_message_id, moderation_version`)
- `reuse_lookup_idx (content_hash, moderation_version, status, created_at)`
- `category_created_at_idx`
- `action_created_at_idx`

---

## Ciclo de vida da moderação

```
pending ──────────────► analyzed
   │                        ▲
   │     (falha LLM)        │ markAnalyzed()
   └──────► failed          │
               ▲            │
               └────────────┘ (próxima versão pode criar nova row)
```

- **`source=fresh`**: LLM executou nesta mensagem.
- **`source=cached`**: conteúdo idêntico já analisado dentro da janela → copia campos, aponta `source_moderation_id` para a original. Não gera job AMQP.
- Reanálise com nova versão: `MODERATION_VERSION` diferente → miss no reuse lookup → novo INSERT em `message_moderations`, novo job.

---

## Versionamento via `MODERATION_VERSION`

- Env obrigatória. Exemplo: `MODERATION_VERSION=v1`.
- Bump invalida cache de reuso (versão diferente não casa no lookup `WHERE moderation_version=$2`).
- Mensagens já analisadas com versão anterior mantêm suas linhas intactas.
- Reanálise em massa de histórico: follow-up (script que cria rows `pending` com versão nova para cada `group_messages`).

---

## Job AMQP

**Type**: `whatsapp.moderate_group_message`

**Payload**:
```json
{ "moderationId": "<uuid>" }
```

**Garantias**:
- At-least-once via TTL+DLX do LavinMQ.
- Idempotência: action verifica `status='pending'` antes de executar — redelivery com status já terminal é ignorado silenciosamente.
- Retry automático (até `AMQP_RETRY_MAX_RETRIES`, default 3) com delay `AMQP_RETRY_DELAY_MS`.
- Falha final: row marcada `status='failed'` com `error` jsonb, enviada para DLQ.

---

## Variáveis de ambiente relacionadas

| Variável | Default | Descrição |
|---|---|---|
| `MODERATION_VERSION` | obrigatória | Versão ativa das regras. Bumpar invalida cache de reuso. |
| `INGESTION_DEDUPE_WINDOW_MS` | `60000` | Janela do bucket de dedup de ingestão (ms). |
| `MODERATION_REUSE_WINDOW_MS` | `1296000000` (15d) | Janela de reuso de moderação por contentHash+version (ms). |
| `ZAPI_RECEIVED_WEBHOOK_SECRET` | obrigatória | Secret validado timing-safe no webhook. |
| `ZAPI_RECEIVED_WEBHOOK_ENABLED` | `true` | Desabilitar retorna 404 imediatamente. |
| `AI_MODEL_ANALYZE_MESSAGE` | `openai/gpt-4o-mini` | Modelo LLM usado na análise. |

---

## Queries úteis

### Mensagens pendentes de moderação
```sql
SELECT id, group_external_id, moderation_status, created_at
FROM group_messages
WHERE moderation_status = 'pending'
ORDER BY created_at ASC
LIMIT 50;
```

### Reuso por categoria (últimos 7 dias)
```sql
SELECT category, action, source, COUNT(*) AS total
FROM message_moderations
WHERE created_at > now() - interval '7 days'
GROUP BY category, action, source
ORDER BY total DESC;
```

### Debug de moderação de uma mensagem
```sql
SELECT
  m.id,
  m.source,
  m.status,
  m.moderation_version,
  m.model,
  m.category,
  m.action,
  m.confidence,
  m.latency_ms,
  m.error,
  m.created_at,
  m.completed_at
FROM group_messages g
JOIN message_moderations m ON g.current_moderation_id = m.id
WHERE g.id = '<message_uuid>';
```

### Distribuição de ações por grupo (últimos 30 dias)
```sql
SELECT
  g.group_external_id,
  m.action,
  COUNT(*) AS total
FROM group_messages g
JOIN message_moderations m ON g.current_moderation_id = m.id
WHERE m.created_at > now() - interval '30 days'
  AND m.status = 'analyzed'
GROUP BY g.group_external_id, m.action
ORDER BY total DESC;
```

---

## Limitações atuais e follow-ups

- **Somente texto**: `normalizedText` e `caption`. Sem OCR para imagens, sem Whisper para áudio.
- **Somente Z-API**: Telegram Bot API e Evolution-Go têm schema preparado mas handler não implementado.
- **`model` preenchido com env**: `AI_MODEL_ANALYZE_MESSAGE` em vez do model real retornado pelo provider. Follow-up: estender `classifyMessage` para retornar o `modelId` efetivamente usado.
- **Enforcement pós-moderação**: auto-delete/auto-ban baseado em `action` fica para próximo PR.
- **Reaper de pendentes órfãos**: mensagens que ficaram `pending` sem job (crash entre INSERT e enqueue) precisam de reaper periódico.
- **Reanálise em massa**: script para reavaliar histórico ao bumpar `MODERATION_VERSION`.
