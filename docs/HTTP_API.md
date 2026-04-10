# HTTP API - Tasks Ingestion

## Visao geral

Este worker expõe um endpoint HTTP para receber batches de tasks e publicar cada task na fila AMQP configurada.

- Rota de ingestao: `POST /tasks`
- Rota de healthcheck: `GET /health`
- Porta default: `3000` (configuravel via `HTTP_PORT`)

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
- `targetKey`: `string` nao vazia
- `createdAt`: `string` datetime ISO 8601
- `attempt`: `number` inteiro >= 0 (opcional)

### Tipo `delete_message`

```json
{
  "id": "job-1",
  "type": "delete_message",
  "targetKey": "target-1",
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
  "targetKey": "target-2",
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
      "targetKey": "target-1",
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
      "targetKey": "target-2",
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

## Rota de healthcheck

`GET /health` nao exige autenticacao.

```bash
curl http://localhost:3000/health
```

Resposta:

```json
{ "status": "ok" }
```

## Variaveis de ambiente relevantes

- `HTTP_PORT`: porta do servidor HTTP (default `3000`)
- `HTTP_API_KEY`: chave obrigatoria para `POST /tasks`
- `AMQP_QUEUE`: nome da fila para onde as tasks serao publicadas

## Observacoes operacionais

- Cada job do batch e publicado individualmente na fila com `persistent: true`.
- Se `sendToQueue` reportar backpressure (`false`), um warning e logado.
- O endpoint continua retornando `202` quando o batch e aceito.
