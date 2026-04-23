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
    }
  ]'
```

Resposta esperada:

```json
{ "accepted": 2 }
```

## Provider Instances

Todos os endpoints abaixo exigem o header `x-api-key` (mesma chave de `/tasks`, valor em `HTTP_API_KEY`).

**Importante:** alterações via API efetivam apenas no próximo restart do worker. O `ProviderGateway` lê o registry apenas no bootstrap. As respostas de `create`, `update`, `enable` e `disable` retornam um campo `warning` explicando isso.

Ao **criar** ou **atualizar** uma instância, o service chama sincronamente `/me`, `/device` e `/status` da Z-API para validar as credenciais. O refresh acontece **fora** da transação (não segura conexão PG durante HTTP); os writes (status + evento + snapshot) rodam numa txn curta depois. Se a Z-API não responder, nada é persistido no create / patch é revertido — e o HTTP retorna `502`.

### `POST /providers/instances`

Cria uma instância Z-API no registry. Fluxo: valida unicidade → chama Z-API (fora da txn) → numa txn curta insere em `messaging_provider_instances` + `zapi_instances` + 1 row em `zapi_instance_connection_events` + 1 em `zapi_instance_device_snapshots` (source=`bootstrap`). Falha no refresh → nada persistido, `502`.

Request body:

```json
{
  "displayName": "inst-01",
  "zapiInstanceId": "3D1A...",
  "instanceToken": "token-secreto-da-instancia",
  "customClientToken": "opcional-override-do-env-ZAPI_CLIENT_TOKEN",
  "executionStrategy": "leased",
  "redisKey": "qp:whatsapp"
}
```

Campos obrigatórios: `displayName`, `zapiInstanceId`, `instanceToken`. `redisKey` é opcional (default `"qp:whatsapp"`). `customClientToken` é opcional — quando ausente, o worker usa `env.ZAPI_CLIENT_TOKEN`.

O cooldown entre jobs (`ZAPI_DELAY_MIN_MS` / `ZAPI_DELAY_MAX_MS`) e os parâmetros de lease (`ZAPI_SAFETY_TTL_MS` / `ZAPI_HEARTBEAT_INTERVAL_MS`) são globais e vêm do env — não há override por instância.

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
    "redisKey": "qp:whatsapp",
    "createdAt": "2026-04-16T12:00:00.000Z",
    "updatedAt": "2026-04-16T12:00:00.000Z",
    "archivedAt": null,
    "zapi": {
      "zapiInstanceId": "3D1A...",
      "instanceTokenMasked": "toke...ncia",
      "customClientTokenMasked": null,
      "currentConnectionState": "connected",
      "currentConnected": true,
      "currentPhoneNumber": "5547999998888",
      "lastStatusSyncedAt": "2026-04-16T12:00:00.000Z"
    }
  },
  "warning": "A instância só será utilizada pelo worker após o próximo restart."
}
```

Erros:

- `401 Unauthorized` — chave ausente/errada
- `409 Conflict` — `zapiInstanceId` já cadastrado
- `422 Unprocessable Entity` — body inválido (shape conferido pelo TypeBox)
- `502 Bad Gateway` — Z-API não respondeu ao refresh; nada foi persistido

`instanceToken` e `customClientToken` em claro **nunca** aparecem na resposta. Os campos `*Masked` mostram os 4 primeiros + `...` + 4 últimos caracteres; `****` para tokens curtos.

### `PATCH /providers/instances/:id`

Atualiza campos editáveis. `zapiInstanceId` é **imutável** e não está presente no schema do body — para trocar de instância Z-API, crie um novo registro.

Request body (todos os campos opcionais):

```json
{
  "displayName": "inst-01-renomeada",
  "executionStrategy": "leased",
  "redisKey": "qp:whatsapp",
  "instanceToken": "novo-token-rotacionado",
  "customClientToken": "novo-client-token-ou-null-para-voltar-ao-env"
}
```

`customClientToken: null` limpa o override e volta a usar `env.ZAPI_CLIENT_TOKEN`.

Fluxo análogo ao `POST`: refresh com credenciais efetivas (patch aplicado) fora da txn → txn curta aplicando patch + status + evento/snapshot (`source=manual`).

Assimetria proposital vs `POST /refresh`: aqui, falha no refresh geralmente indica que o usuário passou credencial inválida. Nesse caso **a instância não é ejetada do pool** — o patch é revertido e o estado anterior (que provavelmente funcionava) permanece. Se a instância de fato caiu, o webhook `disconnect` da Z-API avisa o worker, ou o operador pode chamar `POST /:id/refresh` explicitamente para forçar a ejeção.

Response `200 OK`: `{ "data": InstanceView, "warning": "..." }`. Erros: `401`, `404`, `502`.

### `POST /providers/instances/:id/refresh`

Sincroniza o status da instância com a Z-API sem alterar credenciais ou configurações. Grava 1 row em `connection_events` + 1 em `device_snapshots` com `source=manual`.

Em **falha** (timeout, erro de rede ou resposta inválida), o service:

1. Marca `currentConnectionState='unreachable'`, `currentStatusReason=<erro>`, `currentConnected=false`;
2. Desabilita a instância (`isEnabled=false`);
3. Remove a entrada do Sorted Set do pool (`ZREM redisKey providerInstanceId`) — tira da rotação do gateway imediatamente;
4. Retorna `502` com `{ "error": "Instância marcada como unreachable: ..." }`.

Isso evita que a instância quebrada continue sendo tentada no worker em execução.

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
- `AMQP_ZAPI_QUEUE`: fila do worker zapi (default `wpp.zapi`)
- `AMQP_MODERATION_QUEUE`: fila do worker de moderação (default `wpp.moderation`)
- `REDIS_URL`: URL de conexao Redis para rate limiting distribuido

Roteamento por `job.type` em [`src/jobs/routing.ts`](../src/jobs/routing.ts).

## Observacoes operacionais

- Cada job do batch e publicado individualmente na fila com `durable: true`.

## Desenvolvimento local

### Pré-requisitos

- [Docker](https://docs.docker.com/get-docker/) e Docker Compose
- [Bun](https://bun.sh/)

### Subindo as dependências locais (LavinMQ + Redis + Postgres)

```bash
docker compose -f infra/docker/compose/dev-deps.yml up -d
```

Isso inicia LavinMQ, Redis e Postgres com:

- **AMQP**: `amqp://guest:guest@localhost:5672`
- **Management UI**: `http://localhost:15672` (user: `guest`, password: `guest`)
- **Redis**: `redis://localhost:6379`
- **Postgres**: `postgres://postgres:secret@localhost:5432/queroplantao_messaging`

### Executando os workers

Configurar `.env` (copiar de `.env.example`) e rodar cada worker em terminal separado:

```bash
bun run dev:worker:zapi          # consumer wpp.zapi
bun run dev:worker:moderation    # consumer wpp.moderation
bun run dev:api                  # API HTTP
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
