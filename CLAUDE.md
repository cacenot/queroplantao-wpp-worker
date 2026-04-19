# Guia do projeto para agents

Regras e convenções para sessões de IA neste repositório. Para **o que** o código faz (camadas, fluxos, contratos), ver [docs/architecture.md](docs/architecture.md) — este arquivo cobre **como escrever código** aqui.

## Princípios

- **SRP**: uma função tem uma responsabilidade. Funções >80 linhas orquestrando 4+ coisas são sinal de refactor — extraia colaboradores puros.
- **DRY pragmático**: duas ocorrências é aceitável; três justificam extração. Não crie abstração para um único uso futuro hipotético (YAGNI).
- **Aninhamento**: máx 2 níveis. Mais que isso, inverta condição (early return) ou extraia.
- **Comentários**: explicam o **porquê** (constraint, bug conhecido, decisão não-óbvia). Nunca o **o quê** — o nome já diz.
- **Nada de defesa supérflua**: não valide parâmetros de funções internas nem adicione error handling para cenários que não podem acontecer. Validar só em boundaries (HTTP, AMQP, external APIs).

## Padrões estabelecidos

### Best-effort side effects → `warnOnFail`

Chamadas que não devem abortar o fluxo principal (atualizar status, emitir métrica) usam o helper:

```ts
await taskService.markSucceeded(id).catch(warnOnFail(log, "Falha ao marcar succeeded"));
```

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

## Validação

- **Domínio** (jobs, env, payloads internos): **Zod**. Ver [src/jobs/schemas.ts](src/jobs/schemas.ts), [src/config/env.ts](src/config/env.ts).
- **HTTP I/O**: **TypeBox** (`import { t } from "elysia"`) — alimenta OpenAPI automático.
- Nunca `as Record<string, unknown>` para ler entrada desconhecida — use `z.object({...}).safeParse()`.

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
