# HTTP API

## Visao geral

A API roda em Elysia sobre Bun.serve e expõe:

- `POST /tasks` — ingestão de batches de jobs para o AMQP
- `GET /health` — healthcheck (sem autenticação)
- `GET /docs` — Swagger UI / OpenAPI (sem autenticação)
- `POST|GET|PATCH /providers/instances` — CRUD de provider instances (registry Z-API)

Porta default: `3000` (configurável via `HTTP_PORT`).

## Autenticacao

`POST /tasks` exige header `x-api-key` com o valor de `HTTP_API_KEY`.

- Header obrigatorio: `x-api-key`
- Erro quando ausente, vazio ou invalido: `401`

Exemplo:

```bash
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -H "x-api-key: sua-chave" \
  -d '[]'
```

## Contrato do endpoint `POST /tasks`

### Request

- Content-Type esperado: `application/json`
- Body: array de jobs
- Quantidade minima: 1 job
- Quantidade maxima: 1000 jobs
- Tamanho maximo de payload: 2 MB

### Response de sucesso

- Status: `202 Accepted`
- Body:

```json
{ "accepted": 2 }
```

`accepted` representa quantos jobs do batch foram aceitos para tentativa de publicacao na fila.

### Responses de erro

- `401 Unauthorized`

```json
{ "error": "Unauthorized" }
```

- `400 Bad Request` (JSON invalido)

```json
{ "error": "Invalid JSON" }
```

- `400 Bad Request` (falha de validacao)

```json
{
  "error": "Validation failed",
  "details": {
    "formErrors": [],
    "fieldErrors": {}
  }
}
```

- `413 Payload Too Large`

```json
{ "error": "Payload too large" }
```

- `500 Internal Server Error`

```json
{ "error": "Internal server error" }
```

## Tipos de tasks aceitos

Cada item do array precisa seguir o discriminated union pelo campo `type`.

Campos comuns a todos os tipos:

- `id`: `string` nao vazia
- `type`: tipo da task
- `createdAt`: `string` datetime ISO 8601
- `attempt`: `number` inteiro >= 0 (opcional)

### Tipo `delete_message`

```json
{
  "id": "job-1",
  "type": "delete_message",
  "createdAt": "2026-04-10T00:00:00Z",
  "attempt": 0,
  "payload": {
    "messageId": "msg-1",
    "phone": "5511999990001",
    "owner": true
  }
}
```

`payload` de `delete_message`:

- `messageId`: `string` nao vazia
- `phone`: `string` nao vazia
- `owner`: `boolean`

### Tipo `remove_participant`

```json
{
  "id": "job-2",
  "type": "remove_participant",
  "createdAt": "2026-04-10T00:00:00Z",
  "payload": {
    "groupId": "group-1",
    "phones": ["5511999990001", "5511999990002"]
  }
}
```

`payload` de `remove_participant`:

- `groupId`: `string` nao vazia
- `phones`: array com pelo menos 1 telefone (`string` nao vazia)

### Tipo `analyze_message`

```json
{
  "id": "job-3",
  "type": "analyze_message",
  "createdAt": "2026-04-10T00:00:00Z",
  "payload": {
    "hash": "abc123",
    "text": "mensagem a analisar"
  }
}
```

`payload` de `analyze_message`:

- `hash`: `string` nao vazia
- `text`: `string` nao vazia

## Exemplo completo de batch misto

```bash
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -H "x-api-key: sua-chave" \
  -d '[
    {
      "id": "job-del-1",
      "type": "delete_message",
      "createdAt": "2026-04-10T12:00:00Z",
      "payload": {
        "messageId": "msg-123",
        "phone": "5511999990001",
        "owner": true
      }
    },
    {
      "id": "job-rm-1",
      "type": "remove_participant",
      "createdAt": "2026-04-10T12:01:00Z",
      "payload": {
        "groupId": "group-1",
        "phones": ["5511999990001"]
      }
    },
    {
      "id": "job-am-1",
      "type": "analyze_message",
      "createdAt": "2026-04-10T12:02:00Z",
      "payload": {
        "hash": "abc123",
        "text": "mensagem a analisar"
      }
    }
  ]'
```

Resposta esperada:

```json
{ "accepted": 3 }
```

## Provider Instances

Todos os endpoints abaixo exigem o header `x-api-key` (mesma chave de `/tasks`, valor em `HTTP_API_KEY`).

**Importante:** alterações via API efetivam apenas no próximo restart do worker. O `ProviderGateway` lê o registry apenas no bootstrap. As respostas de `create`, `enable` e `disable` retornam um campo `warning` explicando isso.

### `POST /providers/instances`

Cria uma instância Z-API no registry. Executa as inserções em `messaging_provider_instances` e `zapi_instances` dentro de uma única transação.

Request body:

```json
{
  "displayName": "inst-01",
  "zapiInstanceId": "3D1A...",
  "instanceToken": "token-secreto-da-instancia",
  "webhookBaseUrl": "https://wpp-api.qp.internal",
  "executionStrategy": "leased",
  "redisKey": "messaging:whatsapp",
  "safetyTtlMs": 120000,
  "heartbeatIntervalMs": 30000
}
```

Campos obrigatórios: `displayName`, `zapiInstanceId`, `instanceToken`, `redisKey`. Demais são opcionais.

O cooldown entre jobs (delay min/max) é global do pool e vem das envs `ZAPI_DELAY_MIN_MS` / `ZAPI_DELAY_MAX_MS` — não há override por instância.

Response `201 Created`:

```json
{
  "data": {
    "id": "uuid",
    "protocol": "whatsapp",
    "providerKind": "whatsapp_zapi",
    "displayName": "inst-01",
    "isEnabled": true,
    "executionStrategy": "leased",
    "redisKey": "messaging:whatsapp",
    "safetyTtlMs": 120000,
    "heartbeatIntervalMs": 30000,
    "createdAt": "2026-04-16T12:00:00.000Z",
    "updatedAt": "2026-04-16T12:00:00.000Z",
    "archivedAt": null,
    "zapi": {
      "zapiInstanceId": "3D1A...",
      "instanceTokenMasked": "toke...ncia",
      "webhookBaseUrl": "https://wpp-api.qp.internal",
      "currentConnectionState": null,
      "currentConnected": null,
      "currentPhoneNumber": null,
      "lastStatusSyncedAt": null
    }
  },
  "warning": "A instância só será utilizada pelo worker após o próximo restart."
}
```

Erros:

- `401 Unauthorized` — chave ausente/errada
- `409 Conflict` — `zapiInstanceId` já cadastrado
- `422 Unprocessable Entity` — body inválido (shape conferido pelo TypeBox)

O `instanceToken` em claro **nunca** aparece na resposta. `instanceTokenMasked` mostra os 4 primeiros + `...` + 4 últimos caracteres; `****` para tokens curtos.

### `GET /providers/instances/:id`

Retorna a instância. `instanceToken` mascarado.

- `200 OK` — `{ "data": InstanceView }`
- `404 Not Found` — id não existe
- `422 Unprocessable Entity` — id não é UUID

### `GET /providers/instances`

Lista paginada com filtros.

Query params:

- `limit` — default `20`, clamp `[1, 100]`
- `offset` — default `0`, min `0`
- `protocol` — `whatsapp | telegram` (opcional)
- `providerKind` — `whatsapp_zapi | whatsapp_whatsmeow | whatsapp_business_api | telegram_bot` (opcional)
- `isEnabled` — `true | false` (opcional)

Response `200 OK`:

```json
{
  "data": [ /* InstanceView[] */ ],
  "pagination": { "limit": 20, "offset": 0, "total": 42 }
}
```

### `PATCH /providers/instances/:id/enable`

Marca a instância como habilitada. Idempotente: segunda chamada em instância já habilitada retorna `200` com o estado atual e sem alterar `updatedAt`.

Response `200 OK`: `{ "data": InstanceView, "warning": "..." }`.
Erro `404 Not Found` se id não existe.

### `PATCH /providers/instances/:id/disable`

Mesma semântica, invertida.

### Exemplos curl

```bash
# create
curl -X POST http://localhost:3000/providers/instances \
  -H "x-api-key: $HTTP_API_KEY" -H "content-type: application/json" \
  -d '{"displayName":"inst-01","zapiInstanceId":"i1","instanceToken":"supersecret1234"}'

# list
curl -H "x-api-key: $HTTP_API_KEY" "http://localhost:3000/providers/instances?limit=10&isEnabled=true"

# get
curl -H "x-api-key: $HTTP_API_KEY" http://localhost:3000/providers/instances/$ID

# disable / enable
curl -X PATCH -H "x-api-key: $HTTP_API_KEY" http://localhost:3000/providers/instances/$ID/disable
curl -X PATCH -H "x-api-key: $HTTP_API_KEY" http://localhost:3000/providers/instances/$ID/enable
```

## Rota de healthcheck

`GET /health` nao exige autenticacao.

```bash
curl http://localhost:3000/health
```

Resposta quando saudavel (`200 OK`):

```json
{ "status": "ok" }
```

Resposta quando degradado — conexao AMQP perdida (`503 Service Unavailable`):

```json
{ "status": "degraded" }
```

## Variaveis de ambiente relevantes

- `HTTP_PORT`: porta do servidor HTTP (default `3000`)
- `HTTP_API_KEY`: chave obrigatoria para `POST /tasks`
- `AMQP_QUEUE`: nome da fila para onde as tasks serao publicadas
- `REDIS_URL`: URL de conexao Redis para rate limiting distribuido

## Observacoes operacionais

- Cada job do batch e publicado individualmente na fila com `durable: true`.

## Desenvolvimento local

### Pré-requisitos

- [Docker](https://docs.docker.com/get-docker/) e Docker Compose
- [Bun](https://bun.sh/)

### Subindo o broker AMQP (LavinMQ)

```bash
docker compose up -d
```

Isso inicia o LavinMQ e Redis com:

- **AMQP**: `amqp://guest:guest@localhost:5672`
- **Management UI**: `http://localhost:15672` (user: `guest`, password: `guest`)
- **Redis**: `redis://localhost:6379`

### Executando o worker

```bash
export AMQP_URL=amqp://guest:guest@localhost:5672
export AMQP_QUEUE=tasks
export ZAPI_BASE_URL=https://api.z-api.io
export ZAPI_INSTANCES='[{"instance_id":"i1","instance_token":"t1","client_token":"c1"}]'
export HTTP_API_KEY=dev-secret
export REDIS_URL=redis://localhost:6379

bun run src/worker/index.ts
```

### Executando os testes

```bash
bun test
```

## Validação

- **Headers**: `x-api-key` comparado com `timingSafeEqual` contra `HTTP_API_KEY`. Plugin compartilhado em `src/api/plugins/auth.ts`.
- **Body de `/tasks`**: array de jobs validado via `z.discriminatedUnion` pelo campo `type`. Zod mantido porque o discriminado não se traduz bem para TypeBox. Limites: 1-1000 jobs por batch, payload máximo de 2 MB.
- **Body e query de `/providers/instances`**: schemas TypeBox (`src/api/schemas/provider-instances.ts`) que alimentam o OpenAPI do swagger. Validação falhando retorna `422 Unprocessable Entity`.

## OpenAPI / Swagger

Swagger UI disponível em `GET /docs`. Definição gerada automaticamente a partir dos schemas TypeBox das rotas. Sem autenticação.
