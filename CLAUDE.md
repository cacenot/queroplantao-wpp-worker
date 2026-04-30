# Guia do projeto para agents

Regras e convenções para sessões de IA neste repositório. Para **o que** o código faz (camadas, fluxos, contratos), ver [docs/architecture.md](docs/architecture.md) — este arquivo cobre **como escrever código** aqui.

## Princípios

- **SRP**: uma função tem uma responsabilidade. Funções >80 linhas orquestrando 4+ coisas são sinal de refactor — extraia colaboradores puros.
- **DRY pragmático**: duas ocorrências é aceitável; três justificam extração. Não crie abstração para um único uso futuro hipotético (YAGNI).
- **Aninhamento**: máx 2 níveis. Mais que isso, inverta condição (early return) ou extraia.
- **Comentários**: explicam o **porquê** (constraint, bug conhecido, decisão não-óbvia). Nunca o **o quê** — o nome já diz. Exceção: funções de orquestração com 3+ etapas distintas podem usar seções comentadas (`// — Etapa: descrição`) para demarcar o fluxo.
- **Nada de defesa supérflua**: não valide parâmetros de funções internas nem adicione error handling para cenários que não podem acontecer. Validar só em boundaries (HTTP, AMQP, external APIs).

## Padrões estabelecidos

### Best-effort side effects → `warnOnFail`

Chamadas que não devem abortar o fluxo principal (atualizar status, emitir métrica) usam o helper de [src/lib/log-helpers.ts](src/lib/log-helpers.ts):

```ts
import { warnOnFail } from "src/lib/log-helpers.ts";

await taskService.markSucceeded(id).catch(warnOnFail(log, "Falha ao marcar succeeded"));
```

Quando o callsite quer contexto extra (ex.: `outboundMessageId`), use `logger.child({ ... })` antes do `.catch` em vez de inflar o helper.

Silenciar erros com `.catch(() => {})` só se for genuinamente irrelevante — e com comentário explicando.

### Evite tri-state / sentinel strings

Um retorno `T | "fallback" | null` vaza lógica pro chamador. Extraia um helper que normalize:

```ts
// ruim
const r = await op().catch(() => "fallback" as const);
const x = r === "fallback" ? msg.x : r.x;

// bom
const r = await opOrFallback(); // { x } | null
if (r === null) return drop();
const x = r.x;
```

### Publish + fallback REQUEUE → `publishOrRequeue`

Publish em AMQP que precisa de requeue em caso de broker down já tem helper em [src/worker/handler.ts](src/worker/handler.ts). Não duplique o try/catch.

### Dispatch por tipo → discriminated union + switch exaustivo

Jobs, webhooks e rotas são discriminated unions Zod. O switch no handler delega para a action. Type narrowing do TS garante exaustividade — não use mapas `Record<type, fn>` a menos que precise de extensão dinâmica.

### UPDATEs condicionais a status

Filtros por `status` no `WHERE` valem para **transições de estado** (`pending → queued`, `queued → sending`, etc.) — protegem contra escrita em estado terminal e idempotência de retries.

Mas **escritas de dado/FK** (linkar `task_id`, gravar `external_message_id`, preencher `idempotency_key`) **não devem** ser condicionadas a status: o dado existe independente do estado, e gating em status restritivo cria race condition silenciosa quando outro caminho transiciona o status entre o `SELECT` e o `UPDATE`. Resultado típico: o dado nunca é gravado e ninguém percebe.

Quando a mesma operação precisa gravar dado + transicionar status, faça o status condicional **dentro** do SET — não no WHERE:

```ts
// ruim — UPDATE de FK + status no mesmo WHERE filtra
.set({ taskId, status: "queued", queuedAt: new Date() })
.where(and(eq(id, $id), eq(status, "pending")))  // ← se status mudou, taskId perdido

// bom — task_id sempre grava; status só transiciona se ainda for o de origem
.set({
  taskId,
  status: sql`CASE WHEN ${status} = 'pending' THEN 'queued' ELSE ${status} END`,
  queuedAt: sql`COALESCE(${queuedAt}, NOW())`,
  updatedAt: new Date(),
})
.where(eq(id, $id))
```

Para escrita de dado pura (sem transição), `WHERE column IS NULL` é o filtro de idempotência aceitável (não escreve por cima de valor já gravado).

## Validação

- **Domínio** (jobs, env, payloads internos): **Zod**. Ver [src/jobs/schemas.ts](src/jobs/schemas.ts), [src/config/env.ts](src/config/env.ts).
- **HTTP I/O**: **TypeBox** (`import { t } from "elysia"`) — alimenta OpenAPI automático.
- Nunca `as Record<string, unknown>` para ler entrada desconhecida — use `z.object({...}).safeParse()`.

## Phone numbers → E.164

Todo número de telefone no **domínio** (DB, payloads de job, métricas, logs) é E.164 completo com `+`: `+5547997490248`. Nunca armazene, compare ou faça hash de phone em outro formato.

- Normalize na **fronteira de entrada** (webhook, HTTP, scripts) com `toE164(raw)` de [src/lib/phone.ts](src/lib/phone.ts). Retorna `null` se inválido.
- Na **fronteira Z-API** (que exige dígitos puros sem `+`), converta com `toZapiDigits(e164)` — só dentro de `src/gateways/whatsapp/zapi/`.
- LID (`sender_external_id`, ex.: `"1234567890@lid"`) é identificador separado e não passa por `toE164`.
- Exceção: `deleteMessagePayload.phone` em [src/jobs/schemas.ts](src/jobs/schemas.ts) é polimórfico (carrega chatId ou phone) e não segue a convenção — ver comentário no arquivo.

Lib de referência: `libphonenumber-js` (cobertura internacional, validação por país).

## Convenção de tipos

- Use `type` em vez de `interface` em todo o codebase — mais expressivo, sem surpresa de declaration merging, consistente com `z.infer`.
- Dentro de um módulo de service, dois arquivos de tipos possíveis:
  - `schemas.ts` — schemas Zod + tipos inferidos via `z.infer`. Usado quando há parse em runtime.
  - `types.ts` — tipos TypeScript puros (shapes de output, DTOs). Sem Zod.
- Não crie `schemas.ts` onde não há parse real, nem `types.ts` onde todos os tipos já saem de `z.infer`.

## Erros

- Retryable (transiente): `throw new Error(...)` ou erros nativos. Vão para retry queue até `maxRetries`, depois DLQ.
- Permanente (payload inválido, recurso inexistente): `throw new NonRetryableError(...)` de [src/lib/errors.ts](src/lib/errors.ts). Vai direto ao DLQ.
- Classifique no **ponto de origem** (action, service), não no handler.

## Tests

- `bun test` = unit. `bun test:verbose` = tudo (unit + integration, com logs).
- Integration tests (`*.integration.test.ts`) tocam DB/Redis/AMQP reais — **não mockar**.
- Um `*.test.ts` por arquivo testado, mesma pasta.
- Fakes em factories (ex.: `makeTaskService` em [src/worker/handler.test.ts](src/worker/handler.test.ts)). `mock(() => ...)` do `bun:test`.
- Testes cobrem **comportamento observável**, não detalhes de implementação — refactors não devem quebrar testes.

## Style

- TypeScript estrito (`strict: true`).
- **Biome** é a ferramenta de lint/format/organize-imports. Nunca rode `prettier` ou `eslint`.
- Antes de commit: `bunx biome check --write <arquivos_do_commit>` (escopado, não no projeto todo).
- `bun typecheck` sempre verde.

## Workflow de commit

- Conventional Commits em **português**, curto e imperativo (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`). Ver `git log -10` para estilo.
- **Sem `Co-Authored-By`** — não é convenção do repo.
- **Nunca** `git add -A`, `git add .`, `git add -u`. Sempre paths explícitos.
- **Nunca** `--amend`, `--no-verify`, `--force` sem pedido explícito.
- Commit direto na `main` requer **confirmação** do usuário.
- Quality gates antes de todo commit: biome + typecheck + test:verbose. Falha = parar, reportar, não comitar.
- Workflow completo: [.claude/commands/commit.md](.claude/commands/commit.md).

## Quando perguntar antes de agir

- Adicionar dependência nova.
- Mudar contrato público (schema de job, shape de API, tabela de DB).
- Criar novo padrão ou abstração não discutida.
- Operações destrutivas (drop table, rm -rf, force push).
- Commit/push direto na `main`.

Refactor localizado dentro de um arquivo, correções de tipo, ajustes de lint: prossiga sem perguntar.
