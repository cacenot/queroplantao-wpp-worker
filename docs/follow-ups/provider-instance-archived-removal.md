# Remover `archived_at` de `messaging_provider_instances`

> Status: **planejado**. Origem: PR #5 (envio outbound) — discussão sobre ambiguidade entre `is_enabled` e `archived_at`.

## Motivação

Hoje a tabela `messaging_provider_instances` tem dois flags de "está fora de uso":

- `is_enabled` (bool, default `true`) — significa "não usar pra envios automáticos / pode estar em onboarding".
- `archived_at` (timestamp, nullable) — significa "removida do pool, não retorne em listagens nem em bootstrap".

A intenção da separação seria distinguir "desativada temporariamente" de "removida pra sempre". Na prática:

- Não há fluxo que volte de `archived_at IS NOT NULL` para `archived_at IS NULL`.
- `archived_at` filtra em `buildFilters` (list) e `queryZApiRows` (bootstrap). `is_enabled` filtra em `listEnabledZApiRows` mas é repassado pra callers via `listAllZApiRows` quando precisamos incluir desabilitadas.
- Na cabeça do operador, "arquivar" e "desabilitar" não são distinguíveis sem ler o código.

A semântica fica mais limpa com **um estado**:

- "Em uso" → `is_enabled = true`.
- "Fora de uso" → `is_enabled = false`. Se for definitivo, **deletar** a row (com cascade pra `zapi_instances` etc.) ou manter `is_enabled = false` + uma coluna `disabled_at` se for útil pra dashboard.

## Plano de execução

1. **Migration**:
   - `ALTER TABLE messaging_provider_instances DROP COLUMN archived_at;`
   - Não há row "arquivada" recoverable a preservar — confirmar antes do drop fazendo `SELECT count(*) WHERE archived_at IS NOT NULL` em produção. Se houver, decidir caso a caso (delete ou converter pra `is_enabled=false`).

2. **Schema Drizzle** ([provider-registry.ts](../../src/db/schema/provider-registry.ts)):
   - Remover campo `archivedAt` de `messagingProviderInstances`.

3. **Repositório** ([messaging-provider-instance-repository.ts](../../src/db/repositories/messaging-provider-instance-repository.ts)):
   - `buildFilters` — remover `isNull(messagingProviderInstances.archivedAt)`.
   - `queryZApiRows` — remover `isNull(messagingProviderInstances.archivedAt)` da lista de conditions.
   - `listAllZApiRows` — manter (o nome ainda faz sentido: "todas, incluindo desabilitadas"). Atualizar comentário.

4. **Integration tests**:
   - Remover seeds com `archived: true` em [messaging-provider-instance-repository.integration.test.ts](../../src/db/repositories/messaging-provider-instance-repository.integration.test.ts).
   - Os testes que validavam "archived não aparece em list" viram redundantes — remover.

5. **Documentação**:
   - `docs/architecture.md` § "Provider registry" — substituir menções a `archived_at` por "Para remover uma instância definitivamente, use `DELETE` ou `is_enabled=false`".

## Critério de aceitação

- `grep -rn "archived" src/` retorna zero hits no código de produção.
- `provider_instances.test.ts` e o integration test passam sem o conceito.
- Migration roda em staging sem perder histórico (já validado: ninguém lê `archived_at`).
- Nenhum CLI ou script depende do flag (verificar `src/scripts/`).

## Riscos

- Se algum consumer externo (admin UI, scripts) filtra por `archived_at IS NULL` por sua conta, vai quebrar. Mapear antes do deploy.
- Se houver linha hoje com `archived_at IS NOT NULL`, ela vai voltar a aparecer em listagens. Por isso o passo de auditoria antes do drop.
