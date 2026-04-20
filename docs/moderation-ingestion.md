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
     │  ④ carrega config ativa via ModerationConfigService (Redis → DB)
     │  ⑤ findReusable(contentHash, config.version, 15d)
     │       hit → cria row "cached", atualiza group_messages → "reused"
     │       miss → cria row "fresh/pending" (version=config.version, model=config.primaryModel),
     │              enfileira job → "queued"
     ▼
AMQP: whatsapp.moderate_group_message { moderationId }
     │
     ▼
moderateGroupMessage()
     │  carrega message_moderations + group_messages por moderationId
     │  verifica status='pending' (guard de idempotência)
     │  chama moderate(text) → classifyTiered (1-hop escalation)
     │  markAnalyzed com modelUsed retornado pelo classifier
     │  setModerationStatus('analyzed') → atualiza group_messages
     │  ⑥ enforcement.evaluateAndEnforce() → blacklist? enfileira
     │     whatsapp.delete_message + whatsapp.remove_participant
     │  em erro: markFailed + setModerationStatus('failed')
```

> No caminho **cached** (passo ⑤ acima quando dá hit), o enforcement também roda
> sincronamente após `setCurrentModeration(..., 'analyzed')` no `GroupMessagesService`.
> A blacklist é sobre o *sender*, não sobre o conteúdo — ver "Enforcement via
> blacklist" abaixo.

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

**Janela de reuso**: `MODERATION_REUSE_WINDOW_MS` (default 15 dias). Respeita a evolução das regras (ativar uma `moderation_configs` com novo `version` invalida o cache automaticamente porque a versão entra no filtro de lookup).

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

### `phone_policies`

Tabela usada pela blacklist e pela bypass list. CRUD via API (`/admin/moderation/blacklist`,
`/admin/moderation/bypass`); leitura no fluxo via `ModerationEnforcementService`.

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `protocol` | enum `messaging_protocol` | `whatsapp` / `telegram` |
| `kind` | enum `phone_policy_kind` | `blacklist` / `bypass` |
| `phone` | text nullable | E.164 normalizado (dígitos apenas), 8–15 chars |
| `sender_external_id` | text nullable | LID do WhatsApp (ex: `1234567890@lid`) |
| `group_external_id` | text nullable | NULL = política global pro protocolo; não-null = scoped ao grupo |
| `source` | enum `phone_policy_source` | `manual` / `moderation_auto` / `group_admin_sync` / `admin_api_sync` |
| `reason` | text nullable | |
| `notes` | text nullable | |
| `moderation_id` | uuid FK nullable | quando `source='moderation_auto'` |
| `metadata` | jsonb default `{}` | |
| `expires_at` | timestamptz nullable | NULL = nunca expira |
| `created_at` / `updated_at` | timestamptz | |

**Constraint**: `CHECK (phone IS NOT NULL OR sender_external_id IS NOT NULL)` —
pelo menos um identificador é obrigatório.

**Índices**:
- `phone_policies_unique_phone_idx (protocol, kind, phone, COALESCE(group_external_id, '')) WHERE phone IS NOT NULL`
- `phone_policies_unique_external_id_idx (protocol, kind, sender_external_id, COALESCE(group_external_id, '')) WHERE sender_external_id IS NOT NULL`
- `phone_policies_lookup_idx (protocol, kind, phone) WHERE phone IS NOT NULL`
- `phone_policies_external_id_lookup_idx (protocol, kind, sender_external_id) WHERE sender_external_id IS NOT NULL`
- `phone_policies_expires_at_idx (expires_at) WHERE expires_at IS NOT NULL`

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
- Reanálise com nova versão: config ativa com `version` diferente → miss no reuse lookup → novo INSERT em `message_moderations`, novo job.

---

## Versionamento via `moderation_configs.version`

Configuração (prompt, exemplos, modelos, thresholds, versão) vive em Postgres na tabela `moderation_configs`. Partial unique index em `is_active` garante no máximo uma row ativa.

- Ativar nova config: `POST /admin/moderation/config` (cria + ativa em uma transação) ou `POST /admin/moderation/config/:version/activate` (rollback para versão existente).
- Ativação invalida cache Redis (`DEL moderation_config:active`) no service — próximo read recarrega do DB.
- Bump de `version` invalida cache de reuso de moderação (versão diferente não casa no lookup `WHERE moderation_version=$2`).
- Mensagens já analisadas com versão anterior mantêm suas linhas intactas (1 mensagem → N moderações, uma por version).
- Reanálise em massa de histórico: follow-up (script que cria rows `pending` com versão nova para cada `group_messages`).

---

## Enforcement via blacklist

Após a moderação chegar em `analyzed` (em qualquer caminho), o
`ModerationEnforcementService` consulta a blacklist e, se houver hit, dispara
**dois jobs em paralelo**: um `whatsapp.delete_message` (apaga a mensagem do grupo)
e um `whatsapp.remove_participant` (kicka o sender). O `analysis.action` retornado
pelo LLM é **ignorado** no enforcement deste PR — só a blacklist tem efeito
destrutivo. A moderação por LLM continua rodando integralmente para audit / coleta
de dados.

### Trigger nos dois caminhos

| Caminho | Onde | LLM rodou? |
|---|---|---|
| Fresh | `moderate-group-message.ts` após `setModerationStatus('analyzed')` | sim |
| Cached | `group-messages-service.ts` após `setCurrentModeration(..., 'analyzed')` | não — análise reutilizada |

**Por que cached também dispara**: a blacklist é sobre o sender, não sobre o conteúdo.
Spam multi-grupo: a mesma mensagem "JOIN CASSINO 🎰" enviada por phone X para 50
grupos vira 50 rows distintas em `group_messages` (cada uma com `externalMessageId`
único). A primeira faz fresh moderation; as 49 seguintes usam cached. Em todas, o
delete + kick precisa acontecer no grupo correspondente.

### Precedência: bypass > blacklist

Se o sender bate em `phone_policies` com `kind='bypass'`, o enforcement é
no-op imediato — a moderação por LLM segue rodando para audit, mas não há ação
destrutiva.

### Dois jobs paralelos

| Job | Por que dedupar? |
|---|---|
| `whatsapp.delete_message` | **Não dedupa** — `externalMessageId` é único por mensagem física. |
| `whatsapp.remove_participant` | **Dedup Redis 5 min** por `(grupo, phone)` — `removeParticipant` lança erro se a pessoa já saiu, então sem dedup o segundo kick vira retry → DLQ. |

Se o sender enviar 5 mensagens diferentes em sequência: 5 deletes, 1 kick (os
outros 4 são suprimidos pelo dedup). Após 5 min, próxima reentrada em grupo aberto
volta a kickar.

Os jobs reusam os tipos existentes em [src/jobs/schemas.ts](../src/jobs/schemas.ts)
(`whatsapp.delete_message`, `whatsapp.remove_participant`). Sem novo tipo de job.

### Matching por phone OU LID

A blacklist matcha se **qualquer um** dos identificadores bater:
- `phone` (E.164 normalizado, dígitos apenas) — ainda é o caso comum
- `senderExternalId` — LID do WhatsApp (exemplo `1234567890@lid`), preparação para
  o cenário onde phone deixa de ser entregue

**Limitação atual do dispatch**: as actions Z-API exigem `phone` no payload. Se
uma policy matcha **apenas por LID** e a mensagem chegou sem `senderPhone`, o
enforcement loga um warn (`Enforcement: blacklist matchou por LID mas senderPhone
é null`) e **não enfileira**. Quando phone realmente sumir, atualizar Z-API client
para aceitar LID nativamente é um follow-up separado.

### Fire-and-forget

O enforcement é wrapeado com `.catch()` que loga warn nos call sites — falha
do enforcement (Redis down, AMQP down) **não derruba** a moderação. A row de
`message_moderations` continua `analyzed`; o reaper de blacklist é o produto que
ainda falta (follow-up).

### Por que isso importa em grupos abertos

Grupos WhatsApp são abertos: o banido entra de novo. Mas uma única mensagem de
cassino / conteúdo adulto / golpe já dispara saída de membros reais. Por isso o
**delete da mensagem é tão importante quanto o kick** — e idealmente acontece em
segundos. O kick é defesa secundária para ganhar tempo até a próxima reentrada
manual.

---

## Configuração de moderação

### Endpoints

**Config de moderação:**

| Método | Path | Descrição |
|---|---|---|
| `GET` | `/admin/moderation/config/active` | Retorna a config ativa (404 se nenhuma). |
| `GET` | `/admin/moderation/config` | Histórico ordenado por `createdAt desc` (default `limit=10`). |
| `POST` | `/admin/moderation/config` | Cria e ativa uma nova config (desativa a anterior atomicamente). |
| `POST` | `/admin/moderation/config/:version/activate` | Rollback para uma versão existente. |

**Blacklist e bypass** (CRUD em `phone_policies`):

| Método | Path | Descrição |
|---|---|---|
| `POST` | `/admin/moderation/blacklist` | Adiciona entry. Body aceita `phone` e/ou `senderExternalId` (pelo menos um). |
| `GET` | `/admin/moderation/blacklist` | Lista paginada com filtros. |
| `GET` | `/admin/moderation/blacklist/:id` | Retorna entry. |
| `DELETE` | `/admin/moderation/blacklist/:id` | Remove entry. |
| `POST` `GET` `DELETE` | `/admin/moderation/bypass[...]` | Idêntico ao blacklist mas para `kind='bypass'`. |

Autenticação: header `x-api-key` (`HTTP_API_KEY`).

### Exemplo — criar config ativa

```http
POST /admin/moderation/config
Content-Type: application/json
x-api-key: ***

{
  "version": "2026-04-19-v1",
  "primaryModel": "openai/gpt-4o-mini",
  "escalationModel": "openai/gpt-4o",
  "escalationThreshold": 0.7,
  "escalationCategories": ["hate", "self-harm"],
  "systemPrompt": "Você é um moderador...",
  "examples": [
    { "text": "exemplo", "analysis": { "action": "allow", "category": "...", "confidence": 0.95, "reason": "..." } }
  ]
}
```

Se `escalationModel` for omitido/`null`, o pipeline é single-hop (sem escalation). `escalationCategories` aceita qualquer categoria do enum compartilhado em `src/ai/categories.ts` (typechecked no TypeBox da rota e no Zod do moderator).

### Rollback

```http
POST /admin/moderation/config/v1/activate
x-api-key: ***
```

Ativa a row existente com `version=v1` e desativa a anterior na mesma transação.

### Exemplo — adicionar à blacklist

Por phone (cenário comum hoje):
```http
POST /admin/moderation/blacklist
Content-Type: application/json
x-api-key: ***

{
  "protocol": "whatsapp",
  "phone": "5511999990001",
  "groupExternalId": "120363@g.us",
  "reason": "spam de cassino"
}
```

Por LID (preparação pra quando WhatsApp parar de entregar phone):
```http
POST /admin/moderation/blacklist
Content-Type: application/json
x-api-key: ***

{
  "protocol": "whatsapp",
  "senderExternalId": "1234567890@lid",
  "reason": "spam reincidente sem phone visível"
}
```

Pelo menos um de `phone` ou `senderExternalId` é obrigatório (responde 400 caso
contrário). `bypass` aceita o mesmo body.

---

## Jobs AMQP

Três tipos de jobs participam do fluxo de moderação + enforcement. Todos
compartilham o mesmo broker (LavinMQ) e topologia de retry.

| Type | Produzido por | Payload |
|---|---|---|
| `whatsapp.moderate_group_message` | `GroupMessagesService.resolveModeration` (caminho fresh) | `{ moderationId }` |
| `whatsapp.delete_message` | `ModerationEnforcementService` (blacklist hit) | `{ providerInstanceId, messageId, phone, owner }` |
| `whatsapp.remove_participant` | `ModerationEnforcementService` (blacklist hit + dedup miss) | `{ providerInstanceId, groupId, phones[] }` |

**Garantias** (válidas para os três tipos):
- At-least-once via TTL+DLX do LavinMQ.
- Idempotência por job:
  - `moderate_group_message`: action verifica `status='pending'` antes de executar.
  - `delete_message`: Z-API é tolerante a delete de mensagem já deletada.
  - `remove_participant`: `result.value === false` lança erro → contamos com dedup
    Redis no enforcement para evitar redelivery espúrio.
- Retry automático (até `AMQP_RETRY_MAX_RETRIES`, default 3) com delay
  `AMQP_RETRY_DELAY_MS`.
- Falha final: row marcada `status='failed'` com `error` jsonb, enviada para DLQ.

---

## Variáveis de ambiente relacionadas

| Variável | Default | Descrição |
|---|---|---|
| `MODERATION_CONFIG_REDIS_PREFIX` | `moderation_config` | Prefixo do cache Redis da config ativa (key = `${prefix}:active`). |
| `INGESTION_DEDUPE_WINDOW_MS` | `60000` | Janela do bucket de dedup de ingestão (ms). |
| `MODERATION_REUSE_WINDOW_MS` | `1296000000` (15d) | Janela de reuso de moderação por contentHash+version (ms). |
| `ZAPI_RECEIVED_WEBHOOK_SECRET` | obrigatória | Secret validado timing-safe no webhook. |
| `ZAPI_RECEIVED_WEBHOOK_ENABLED` | `true` | Desabilitar retorna 404 imediatamente. |

> **Removidas em favor de `moderation_configs`**: `MODERATION_VERSION`, `AI_MODEL_ANALYZE_MESSAGE`. Ambas agora vivem na row ativa da tabela.

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
- **Enforcement Z-API ainda phone-based**: a coluna `sender_external_id` (LID) já entra no matching da blacklist, mas as actions `removeParticipant`/`deleteMessage` exigem phone no payload. Match por LID sem phone vira no-op + warn. Quando WhatsApp parar de entregar phone, atualizar Z-API client para LID nativo.
- **Enforcement baseado em LLM**: `analysis.action ∈ {remove, ban}` é ignorado nesse PR — só blacklist tem efeito destrutivo. Habilitar quando confiarmos no LLM.
- **Cache Redis em PhonePoliciesService**: hoje todo lookup vai ao Postgres (2 queries por mensagem moderada — bypass + blacklist). Aceitável pra MVP; cache reduz latência.
- **`removeParticipant` action idempotente**: hoje lança erro se a pessoa já saiu. Dedup Redis cobre o caso comum, mas mudar pra not-throw seria defense-in-depth.
- **Auto-add à blacklist**: quando LLM retornar `ban` com alta confiança, criar entry em `phone_policies` com `source='moderation_auto'` automaticamente.
- **Tracking de eventos de enforcement**: hoje fica em log estruturado + rows em `tasks` AMQP. Tabela própria facilitaria audit / reverter kicks errados.
- **Reaper de pendentes órfãos**: mensagens que ficaram `pending` sem job (crash entre INSERT e enqueue) precisam de reaper periódico.
- **Reanálise em massa**: script para reavaliar histórico ao ativar nova `moderation_configs.version`.
