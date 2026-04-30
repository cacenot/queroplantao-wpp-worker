# Adicionar provider `whatsapp_evolution_go`

> Status: **planejado** (substitui o slot `whatsapp_whatsmeow` que nunca foi implementado).
> Origem: discussão pós-merge do PR de envio outbound — análise de prontidão da arquitetura para o segundo provider WhatsApp.

## Contexto

Hoje o sistema tem um único provider WhatsApp implementado: Z-API ([`src/gateways/whatsapp/zapi/`](../../src/gateways/whatsapp/zapi/)). O enum `messaging_provider_kind` ([provider-registry.ts](../../src/db/schema/provider-registry.ts)) já reserva slots para `whatsapp_whatsmeow` e `whatsapp_business_api`, mas nenhum tem implementação.

A intenção agora é trocar o slot reservado de WhatsMeow por **evolution-go** — um serviço Go que expõe uma API HTTP equivalente, baseado na lib `whatsmeow` (mas operado em processo separado, em vez de embedado em Bun).

A boa notícia: **a maior parte da arquitetura já é provider-agnóstica.** A maioria do trabalho é mecânica (criar classe que implementa `WhatsAppProvider`). A única dívida real é uma camada de erro que ficou Z-API-específica e precisa ser generalizada antes do segundo provider chegar.

Este documento existe pra que a sessão que for atacar evolution-go saiba exatamente o que fazer e o que evitar — sem precisar reler o histórico.

## O que já está pronto (zero mudança)

Todos os pontos abaixo aceitam um novo `WhatsAppProvider` sem qualquer ajuste:

| Componente | Arquivo | Por que é agnóstico |
|---|---|---|
| Interface do provider | [`src/gateways/whatsapp/types.ts`](../../src/gateways/whatsapp/types.ts) | `WhatsAppProvider` define só o contrato; cada implementação faz seu mapeamento. |
| Targets de envio | mesma | `SendTarget = group \| contact` com `externalId` polimórfico — sem premissa de Z-API. |
| Resultado de envio | mesma | `SendResult = { externalMessageId, raw }`. Cada client extrai do payload no seu formato. |
| Switch por content kind | [`src/actions/whatsapp/send-message.ts`](../../src/actions/whatsapp/send-message.ts) (`dispatchSend`) | Switch é por `content.kind`, não por provider. |
| Service de orquestração | [`src/services/outbound-messages/outbound-messages-service.ts`](../../src/services/outbound-messages/outbound-messages-service.ts) | Lê `instance.base.providerKind` do banco e injeta no payload. Sem branch por provider. |
| Schema de outbound | [`src/db/schema/outbound-messages.ts`](../../src/db/schema/outbound-messages.ts) | `provider_kind` enum, `content` jsonb, `target_external_id` polimórfico. Só falta adicionar o novo enum value. |
| Job schema | [`src/jobs/schemas.ts`](../../src/jobs/schemas.ts) (`whatsapp.send_message`) | Carrega `providerInstanceId` — qual provider executa é resolvido em runtime. |
| Idempotência, single-writer, findActiveById | repo + service | Operam no nível da row, sem conhecer provider. |
| Registry agnóstico | [`src/gateways/gateway-registry.ts`](../../src/gateways/gateway-registry.ts) | `GatewayRegistry<WhatsAppProvider>` aceita providers de kinds distintos no mesmo pool, agrupados por `redis_key`. |
| Lease distribuída | `ProviderGateway<T>` ([provider-gateway.md](../provider-gateway.md)) | Genérico em `T`. Só o `redis_key` muda. |

Isso significa que a action `sendMessage` e o service `OutboundMessagesService` **não precisam saber que evolution-go existe**. O switch invisível já está feito por DI.

## O que **não** está pronto: classificação de erro

A única ponta solta de "vazamento" provider-específico está em duas funções que fazem `instanceof ZApiError`:

### 1. Action `sendMessage` ([send-message.ts:46-64](../../src/actions/whatsapp/send-message.ts))

```ts
} catch (err) {
  if (err instanceof ZApiTimeoutError) throw err;                          // ← Z-API
  if (err instanceof ZApiError && err.status >= 400 && err.status < 500) { // ← Z-API
    await deps.outboundMessagesRepo
      .markFailed(payload.outboundMessageId, normalizeOutboundError(err))
      .catch(warnOnFail(log, "..."));
    throw new NonRetryableError(...);
  }
  throw err;
}
```

Para o evolution-go, um erro 4xx do servidor evolution **não vai** bater nesse `instanceof` — vai cair no `throw err` final e ser tratado como retryable, gastando todas as tentativas até DLQ. Pior: a row de outbound nunca é marcada `failed` com o body do erro (perdemos o motivo do 400 — números inválidos, instância desconectada etc.).

### 2. Normalizador de erro ([error.ts](../../src/services/outbound-messages/error.ts))

```ts
function unwrapZApiError(err: unknown): ZApiError | null {
  if (err instanceof ZApiError) return err;
  if (err instanceof Error && err.cause instanceof ZApiError) return err.cause;
  return null;
}
```

Mesmo problema: erros do evolution-go não exporiam `status`/`body` em `outbound_messages.error`, perdendo o diagnóstico do dashboard de "envios por motivo de falha".

## Refactor proposto: `ProviderHttpError` como base provider-agnóstica

Criar em [`src/gateways/types.ts`](../../src/gateways/types.ts) uma hierarquia base:

```ts
export class ProviderHttpError extends Error {
  override readonly name: string = "ProviderHttpError";

  constructor(
    message: string,
    /** Identificador do provider (ex.: "zapi", "evolution_go") — para tags de log/Sentry. */
    public readonly providerKind: string,
    /** HTTP status. 0 quando timeout/rede (sem resposta). */
    public readonly status: number,
    /** Body da resposta crua, quando houver. */
    public readonly body: unknown,
  ) {
    super(message);
  }
}

export class ProviderTimeoutError extends ProviderHttpError {
  override readonly name = "ProviderTimeoutError";

  constructor(providerKind: string, url: string, timeoutMs: number) {
    super(
      `${providerKind} timeout após ${timeoutMs}ms: ${url}`,
      providerKind,
      0,
      null,
    );
  }
}
```

Em seguida, mudar `ZApiError` ([client.ts:36-52](../../src/gateways/whatsapp/zapi/client.ts)) para herdar:

```ts
export class ZApiError extends ProviderHttpError {
  override readonly name = "ZApiError";
  constructor(message: string, status: number, body: unknown) {
    super(message, "zapi", status, body);
  }
}

export class ZApiTimeoutError extends ProviderTimeoutError {
  override readonly name = "ZApiTimeoutError";
  constructor(url: string, timeoutMs: number) {
    super("zapi", url, timeoutMs);
  }
}
```

E atualizar a action:

```ts
} catch (err) {
  if (err instanceof ProviderTimeoutError) throw err;
  if (err instanceof ProviderHttpError && err.status >= 400 && err.status < 500) {
    await deps.outboundMessagesRepo
      .markFailed(payload.outboundMessageId, normalizeOutboundError(err))
      .catch(warnOnFail(log, "..."));
    throw new NonRetryableError(
      `${err.providerKind} recusou envio (HTTP ${err.status}) para outboundMessageId=${...}`,
      err,
    );
  }
  throw err;
}
```

E o `normalizeOutboundError`:

```ts
function unwrapProviderError(err: unknown): ProviderHttpError | null {
  if (err instanceof ProviderHttpError) return err;
  if (err instanceof Error && err.cause instanceof ProviderHttpError) return err.cause;
  return null;
}
```

Com isso, `EvolutionError extends ProviderHttpError` (igual ZApiError) funciona automaticamente — action e normalizer são genéricos.

**Custo aproximado**: ~30 linhas tocadas, 4 arquivos (`gateways/types.ts`, `zapi/client.ts`, `actions/send-message.ts`, `services/outbound-messages/error.ts`), 2 testes ajustados. Sem mudança de comportamento — só refactor de classes.

> Importante: este refactor **não bloqueia** funcionalidades atuais. Pode ser feito junto com o primeiro PR de evolution-go, ou separado e mergeado primeiro pra deixar o terreno limpo.

## Decisões arquiteturais a tomar antes de codar

Três decisões com tradeoffs reais. Definir antes de abrir PR pra não retrabalhar.

### 1. Worker compartilhado ou separado?

| Opção | Quando faz sentido |
|---|---|
| **Compartilhado** (`whatsapp-worker` cobrindo Z-API + evolution-go) | Se rate-limit semantics são parecidas (lease distribuída por instância) e prefetch é compatível. Menos overhead operacional (1 deploy, 1 health). |
| **Separado** (novo `whatsapp-evolution-worker`) | Se evolution-go tem rate-limit diferente (ex.: API-key shared vs per-instance), ou throughput muito distinto. Permite tunar prefetch e instance pool isoladamente. |

**Recomendação default**: compartilhado, renomeando `whatsapp-zapi-worker` → `whatsapp-worker`. O `WhatsAppExecutor` é genérico, o registry agrupa por `redis_key` e isola por instância. Só vale separar se aparecer evidência operacional (DLQ pesa um lado mais que outro, métricas precisam de cardinalidade separada).

Renomear o worker exige:
- Rename do diretório `src/workers/whatsapp-zapi/` → `src/workers/whatsapp/`.
- Atualizar entry point + Dockerfile + compose em `infra/docker/`.
- Atualizar `WORKER_ZAPI_HEALTH_PORT` → `WORKER_WHATSAPP_HEALTH_PORT` (env nova; manter alias temporário se tiver deploy em produção).

### 2. Fila compartilhada ou separada?

Hoje `whatsapp.send_message` vai pra `messaging.zapi` ([routing.ts:24](../../src/jobs/routing.ts)). Manter ou bifurcar?

| Opção | Tradeoff |
|---|---|
| **Compartilhada** (renomear `messaging.zapi` → `messaging.whatsapp`) | DLQ única, retry compartilhado. Operacionalmente simples. Custo: head-of-line blocking entre os dois providers (raro com priority correto, mas existe). |
| **Separada** (`messaging.zapi` + `messaging.evolution_go`) | Isolamento operacional. DLQ separada por provider facilita triagem. Custo: duplicação de topology, env vars, dashboards. |

**Recomendação default**: compartilhada (`messaging.whatsapp`). Mas atenção: **renomear fila no AMQP é cirurgia** — declarar uma fila com args diferentes dos atuais dispara `PRECONDITION_FAILED` no boot. O caminho seguro é versionar:

1. Declarar `messaging.whatsapp` (nova) com mesmos args.
2. Routing publica nas duas (`messaging.zapi` e `messaging.whatsapp`) durante a janela de migração.
3. Worker consome só de `messaging.whatsapp`.
4. Após drenar `messaging.zapi`, deletar a fila antiga.

Esse fluxo está documentado em [`architecture.md`](../architecture.md#persistência-de-tasks) (nota sobre redeclaração).

Se evitar essa cirurgia for prioridade, a alternativa é **manter `messaging.zapi`** e simplesmente roteiar `whatsapp.send_message` baseado no `provider_kind` (lookup adicional na hora do enqueue para decidir fila). Mais complexidade no código, menos no broker.

### 3. Como tratar o slot `whatsapp_whatsmeow` no enum

Opções:
- **Renomear via `ALTER TYPE ... RENAME VALUE 'whatsapp_whatsmeow' TO 'whatsapp_evolution_go'`** (Postgres ≥ 10). Cirurgia mínima, zero rows afetadas (whatsmeow nunca foi usado). Recomendado.
- **Adicionar `whatsapp_evolution_go` lado a lado**, deixar `whatsmeow` morto. Funciona mas polui o enum.
- **Drop `whatsmeow` + add `evolution_go`**. Postgres não suporta `DROP VALUE` no enum sem recriar — mais trabalho que a opção 1.

## Plano de implementação (ordem sugerida)

Sugiro 2 PRs:

### PR 1 — Refactor de erros (sem evolution-go ainda)

1. Criar `ProviderHttpError` e `ProviderTimeoutError` em `src/gateways/types.ts`.
2. `ZApiError` herda; `ZApiTimeoutError` herda. Mantém o nome e propriedades pra não quebrar imports existentes.
3. Atualizar `actions/whatsapp/send-message.ts`: `instanceof ProviderTimeoutError` / `ProviderHttpError`.
4. Atualizar `services/outbound-messages/error.ts`: `unwrapProviderError`.
5. Atualizar testes que constroem `ZApiError` direto (continua funcionando, mas vale rodar).
6. Mensagem do `NonRetryableError` usa `err.providerKind` em vez de hardcoded "Z-API".

Mergeia sozinho. Zero mudança de comportamento — só organiza herança.

### PR 2 — Provider evolution-go

1. **Schema**:
   - Migration `ALTER TYPE messaging_provider_kind RENAME VALUE 'whatsapp_whatsmeow' TO 'whatsapp_evolution_go'`.
   - Tabela `evolution_go_instances` análoga a `zapi_instances`. Campos prováveis: `messaging_provider_instance_id` (PK/FK), `base_url`, `api_key` (criptografada ou em env?), `current_connection_state`, snapshots análogos.
2. **Gateway**:
   - `src/gateways/whatsapp/evolution-go/types.ts` — `EvolutionGoInstanceConfig`.
   - `src/gateways/whatsapp/evolution-go/client.ts` — `class EvolutionGoClient implements WhatsAppProvider`. Implementa todos os métodos do contrato (`sendText`, `sendImage`, …, `deleteMessage`, `removeParticipant`, `fetchGroupMetadata*`, `acceptGroupInvite`).
   - `EvolutionError extends ProviderHttpError` com `providerKind: "evolution_go"`.
3. **Conversão de phone**: cada provider tem sua fronteira em `src/lib/phone.ts`. Adicionar `toEvolutionGoFormat` se o formato esperado diferir de digits puros (a regra do CLAUDE.md vale: conversão **só dentro de `src/gateways/whatsapp/evolution-go/`**).
4. **Bootstrap**:
   - Adicionar `loadEvolutionGoProviderRows(db)` em `src/workers/shared/zapi-bootstrap.ts` (renomear o arquivo se ficar grande — `src/workers/shared/whatsapp-bootstrap.ts`).
   - `buildWhatsappGatewayRegistry` recebe rows de Z-API e evolution-go agora; o registry já agrupa por `redis_key` e aceita kinds mistos.
5. **Service de provider instance**:
   - `MessagingProviderInstanceService` ganha CRUD pra evolution-go, análogo ao Z-API: create/update/refresh/disable. Pode ser um arquivo separado (`evolution-go-instance-service.ts`) ou estender o existente — depende do tamanho.
6. **Worker** (decidido na seção anterior):
   - Compartilhado: rename + adiciona evolution-go ao bootstrap.
   - Separado: criar `src/workers/whatsapp-evolution/` com Dockerfile, compose, env vars.
7. **Routing**:
   - Se queue compartilhada: rename `messaging.zapi` → `messaging.whatsapp` (ver migração de fila).
   - Se separada: novo `AMQP_EVOLUTION_QUEUE` env, novo branch em `routing.ts` por `provider_kind`.
8. **Webhook** (se evolution-go tiver):
   - Novo módulo `src/api/modules/webhooks-evolution-go/` análogo a `webhooks-zapi`.
   - Schema de payload, normalizer pra `NormalizedZapiMessage`-equivalente, plumbing pro `GroupMessagesService.ingest*`.
9. **Tests**:
   - Unit do `EvolutionGoClient` (mocking fetch, igual ao [`zapi/client.test.ts`](../../src/gateways/whatsapp/zapi/client.test.ts)).
   - Integration cobrindo: criar instância evolution-go, enviar via outbound service, marcar failed em 4xx.
   - Validar que action funciona com EvolutionError sem branch específico.
10. **Doc**:
    - Atualizar `docs/architecture.md` § "Provider registry" com evolution-go.
    - Atualizar `docs/outbound-messages.md` se houver diferença operacional.
    - Listar nos env vars novos em `.env.example` + `src/config/env.ts`.

## O que **não** muda no PR 2

Pra evitar scope creep, deixar fora:

- `OutboundMessagesService.send` — agnóstico, não toca.
- `outbound_messages` repo (markFailed, setTaskId, idempotency) — agnóstico, não toca.
- `dispatchSend` na action — switch é por `content.kind`, não por provider.
- Job schema `whatsapp.send_message` — payload é o mesmo.
- Convenções de phone E.164 no domínio — só a fronteira de saída do client específico converte.

Se algum desses precisar mudar pra suportar evolution-go, é sinal de que algo escapou na análise — pare e revisite o desenho antes de continuar.

## Riscos conhecidos

- **Endpoints divergentes**: evolution-go pode expor `POST /message/sendText/{instanceId}` (com body diferente) onde Z-API tem `POST /send-text`. O `WhatsAppProvider.sendText({ target, message })` continua o mesmo — diferença mora dentro do client.
- **Formato de `externalMessageId`**: cada provider retorna ID em formato próprio. `extractZapiMessageId` é privado a Z-API; evolution faz o seu equivalente. `outbound_messages.external_message_id` é só `text`, aceita qualquer formato.
- **Status code semantics**: Z-API usa 4xx pra "número não existe". Evolution pode usar 200 com `{ success: false, error: "..." }`. Nesse caso o **client** deve traduzir pra `EvolutionError` (status > 0) — não deixar a action lidar com isso. Regra: a fronteira do client transforma payload do provider em erro tipado, ou deixa passar `SendResult`.
- **Rate-limit shared vs per-instance**: definir antes de implementar a lease no Redis. Se evolution-go é multi-tenant numa única chave de API (rate compartilhado), `redis_key` não pode ser por instância — vira por API-key.
- **Renomeação de fila**: já documentado, mas é a fonte mais comum de bug em prod. Versionar nome e fazer dual-publish é o caminho seguro.

## Critério de aceitação

PR 1 (refactor):
- `bun typecheck` verde, biome verde, todos os testes existentes passam.
- `instanceof ZApiError` aparece **só** dentro de `src/gateways/whatsapp/zapi/`. Action e service usam `ProviderHttpError`.
- Nada quebra em produção (smoke test: 4xx de Z-API ainda marca outbound como failed com body).

PR 2 (evolution-go):
- Migração roda em staging sem perder dados.
- Outbound `whatsapp.send_message` aceita `provider_instance_id` de evolution-go e enfileira normalmente.
- Worker consome e executa via `EvolutionGoClient`.
- Erros 4xx do evolution-go marcam outbound como failed com `body` preservado em `outbound_messages.error.body`.
- Sentry mostra `EvolutionError` na chain (Sentry SDK detecta automaticamente porque `NonRetryableError` passa `cause`).
- Dashboard de "falhas por provider_kind" diferencia Z-API e evolution-go.

## Referências

- Análise original que motivou esta doc: discussão pós-merge do PR #5.
- Convenções aplicáveis: [CLAUDE.md](../../CLAUDE.md) (validação na fronteira, phone na fronteira do provider).
- Padrão de provider novo: [`docs/architecture.md`](../architecture.md) § "Como adicionar um novo provider".
- Lease distribuída: [`docs/provider-gateway.md`](../provider-gateway.md).
- Implementação de referência: [`src/gateways/whatsapp/zapi/`](../../src/gateways/whatsapp/zapi/).
