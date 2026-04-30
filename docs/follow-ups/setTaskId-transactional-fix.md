# Refactor transacional para vincular `outbound_messages.task_id`

> Status: **planejado**. Origem: PR #5 (envio outbound). Bug imediato mitigado por loosen-fix em `setTaskId` ([repo](../../src/db/repositories/outbound-messages-repository.ts)) — esta nota cobre o refactor "certo".

## Contexto

`OutboundMessagesService.send` ([service](../../src/services/outbound-messages/outbound-messages-service.ts)) hoje executa três passos serializados:

1. `INSERT outbound_messages (status='pending', task_id=NULL)`.
2. `taskService.enqueue([job])` — `INSERT tasks (id=jobId)` + publish AMQP.
3. `setTaskId(rowId, jobId)` — `UPDATE outbound_messages SET task_id=$jobId, status='queued', queued_at=NOW()`.

A versão atual de `setTaskId` foi relaxada: o `task_id` é gravado de qualquer jeito; o status só transiciona para `queued` se ainda estiver `pending`. Isso fecha o race em que o worker drena a fila entre o publish (2) e o `setTaskId` (3) e move o status pra `sending` antes do UPDATE — o link FK não fica mais perdido.

Mas a forma certa, single-writer, é fazer **insert outbound + insert tasks + publish AMQP** em uma operação coesa.

## Problema do approach atual

- O caminho feliz envolve dois UPDATEs no mesmo registro (transição implícita `pending → queued` no `setTaskId`). É menos overhead que parece (um round-trip), mas é state visível à leitura.
- Em janelas de crash entre (1) e (2), a row fica em `pending` órfã indefinidamente — só um reaper futuro limpa.
- A FK `outbound_messages.task_id → tasks.id` **não pode** ser preenchida no INSERT sem antes ter a row em `tasks` (FK violation). Por isso o passo (3) existe.

## Refactor proposto

```
BEGIN;
  INSERT INTO tasks (id, type, payload, status, ...) VALUES ($jobId, ...);
  INSERT INTO outbound_messages (..., task_id, status, queued_at) VALUES (..., $jobId, 'queued', NOW());
COMMIT;
publisher.send(...)  -- fora da transação
```

Vantagens:

- Single writer pro estado de queued + task_id (mesma transação).
- Se publish falha, ambos já estão em DB com `status='queued'` — reaper republica ou marca failed (mesmo problema do reaper já listado em `architecture.md`).
- Sem `setTaskId`, sem branch `WHERE status='pending'`.

Custo: requer expor transação a partir do `TaskService.enqueue` (hoje monolítico — INSERT+publish numa chamada). Duas opções:

a. **Quebrar `enqueue`** em `createPendingTasks(jobs, tx)` + `publishTasks(jobs)`. Callers compostos (como o outbound service) chamam separadamente; callers simples (rota `POST /tasks`) ganham um helper `enqueueAndPublish` que mantém a API atual.

b. **Aceitar transação opcional** em `enqueue(jobs, { tx })`. Quando `tx` é passado, INSERT roda dentro da transação do caller; publish acontece após `await tx.commit()`. Mais complexo de implementar (publish precisa ser callback diferido).

Opção (a) é mais simples e expõe a separação naturalmente.

## Quando atacar

- Quando um segundo "mirror table" entrar em cena (ex.: `outbound_message_batches`, `inbound_messages`). Aí o refactor do TaskService se paga em N tabelas.
- Antes de implementar bulk send — bulk vai fazer N inserts em transação só pelo `outbound_messages`; vale incluir o tasks no mesmo BEGIN.

## Critério de aceitação

- `OutboundMessagesService.send` não chama mais `setTaskId`.
- `setTaskId` é removido (ou marcado `@deprecated` por uma janela curta).
- Integration test cobre o caso de publish falhando após commit DB (row e task em `queued`, sem mensagem AMQP) — o reaper futuro precisa cobrir esse estado.
- `architecture.md` "Persistência de tasks" atualizado: o ciclo de vida deixa de mencionar `pending → queued` como transição observável (vira atomic insert em `queued`).

## Referências

- Convenção que documenta a regra geral (UPDATE de dado ≠ UPDATE de status): [CLAUDE.md](../../CLAUDE.md#updates-condicionais-a-status).
- Loosen-fix aplicado: [outbound-messages-repository.ts](../../src/db/repositories/outbound-messages-repository.ts) (`setTaskId`).
- Roadmap de bulk send: [outbound-messages.md § Roadmap](../outbound-messages.md#roadmap).
