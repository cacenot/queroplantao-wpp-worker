# Webhook Z-API de disconnect → desabilitar instância automaticamente

> Status: **planejado**. Origem: PR #5 (envio outbound) — investigação revelou que o comentário em `MessagingProviderInstanceService.updateZApiInstance` ("o webhook disconnect da Z-API avisa o worker") é **aspiracional**: a implementação não existe.

## Contexto

Z-API envia webhooks de mudança de status do dispositivo (disconnect, connect, restore session). Hoje o projeto **não tem** rota pra recebê-los — só o `POST /webhooks/zapi/on-message-received` ([api](../../src/api/modules/webhooks-zapi/index.ts)).

Consequência operacional do buraco:

1. Aparelho desconecta silenciosamente (bateria, modo avião, logout do WhatsApp Web).
2. Worker continua roteando jobs (`delete_message`, `remove_participant`, novos: `send_message`) pra essa instância — `is_enabled` ainda é `true`.
3. Cada job falha com 4xx Z-API ("instance not connected") ou timeout. Vai pra DLQ.
4. Operador percebe pela acumulação na DLQ ou por dashboard, chama `POST /:id/refresh` manualmente — aí sim `markUnreachableAndDisable` ([repo](../../src/db/repositories/messaging-provider-instance-repository.ts)) seta `is_enabled=false` e ejeta do pool Redis.

Janela de inutilidade: minutos a horas, dependendo de quando o operador olha. Toda essa janela queima cota Z-API.

## Plano

### Rota nova

`POST /webhooks/zapi/on-status-change` (ou nome equivalente — consultar docs Z-API pra evento exato; pode ser único endpoint pra connect/disconnect/restore).

- Auth: mesmo padrão de `on-message-received` (timing-safe secret via query/header).
- Body: schema Zod específico (Z-API documenta `connected: bool`, `instanceId`, `phoneConnected`, etc).
- Resolve `messaging_provider_instances.id` pelo `zapi_instance_id` recebido (já existe `instanceService.resolveProviderInstanceIdByZapiInstanceId`).

### Lógica

| Evento | Ação no DB | Ação no Redis |
|---|---|---|
| `connected: false` (disconnect) | `markUnreachableAndDisable(id, "webhook_disconnect")` — seta `current_connection_state='disconnected'`, `is_enabled=false`. | Ejetar do ZSet do pool. |
| `connected: true` (reconnect) | Decisão de produto: religar automaticamente (`setEnabled(true)` + `currentConnectionState='connected'`) ou exigir refresh manual? Recomendo **automático com guarda**: só religa se `is_enabled` foi setado por webhook anterior (registrar a origem do disable). Reconect manual pós-troca de credencial deve passar por refresh humano. |
| `restore session` etc. | Logar e atualizar `current_connection_state`; sem mexer em `is_enabled`. |

Pra registrar a origem do disable (`webhook` vs `manual`), [zapi-instance-connection-events](../../src/db/schema/provider-registry.ts) já existe e é append-only — basta inserir um event com `source='webhook'`. A "guarda" pra reconnect automático fica: ler último `connection_event` e só religar se o último disable veio com `source='webhook'`.

### Sentry / observabilidade

- Cada disconnect via webhook gera 1 Sentry breadcrumb (não exception) com tag `provider_instance_id`. Não captureException — disconnect é evento normal.
- Métrica `messaging_provider_instance_disabled_by_webhook_total` (Prometheus) pra alertar quando uma instância especifica desconecta com frequência anormal.

## Casos a cuidar

- **Webhook fora de ordem**: Z-API pode entregar disconnect depois de connect (queue da Z-API). Idempotência via `dedupe_key` em `connection_events` (provavelmente `${instanceId}:${eventTimestamp}`). Já tem o campo no schema.
- **Webhook que chega antes do CRUD criar a instância**: ignorar (zapi_instance_id desconhecido) e logar warn — evento perdido é aceitável, próximo refresh manual reconcilia.
- **Z-API cliente único, múltiplas instâncias num só dispositivo (não acontece, mas)**: o webhook traz `instanceId` específico — não há ambiguidade.

## Dependências

- Antes do disconnect webhook: confirma se [provider-instance-archived-removal.md](./provider-instance-archived-removal.md) está em andamento — vamos querer remover `archived_at` antes de adicionar mais lógica em torno de `is_enabled`.
- Schema do webhook depende da doc Z-API atualizada — confirmar formato (Z-API muda body de webhook entre versões).

## Critério de aceitação

- Webhook auth correto, retornando 401 sem secret válido (mesmo padrão de on-message-received).
- Disconnect → `is_enabled=false` em DB + ejeção no Redis em < 1s.
- Connect (após disconnect via webhook) → re-enabling automático com guarda de origem.
- Integration test com webhook real simulado ponta a ponta.
- Métrica Prometheus exposta.

## Referências

- Doc Z-API de webhook de status: confirmar versão atual em developer.z-api.io.
- Padrão atual: [`webhooks-zapi/index.ts`](../../src/api/modules/webhooks-zapi/index.ts).
- Função existente que já faz o trabalho: `markUnreachableAndDisable` em [`messaging-provider-instance-repository.ts`](../../src/db/repositories/messaging-provider-instance-repository.ts).
