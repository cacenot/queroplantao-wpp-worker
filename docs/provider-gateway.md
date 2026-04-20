# ProviderGateway

Documento de referência do `ProviderGateway<T>`, do `ProviderGatewayRegistry<T>` e da estratégia de lease distribuída.

## Objetivo

O gateway existe para separar duas preocupações do restante da aplicação:

- escolher qual provider será usado em cada execução
- aplicar coordenação distribuída apenas quando o provider precisa de controle por instância

As actions continuam vendo apenas o contrato `execute(fn)`. A diferença entre `leased` e `passthrough` fica encapsulada no gateway.

## Estratégias de execução

Cada provider pode declarar uma estratégia de execução:

- `leased`: usa coordenação distribuída via Redis para garantir exclusão por instância entre múltiplos workers
- `passthrough`: não usa Redis para acquire/release; o provider é executado diretamente

`leased` é o default para compatibilidade com os providers atuais da Z-API.

## Leased

No modo `leased`, o gateway mantém dois estados por provider:

- um score no Sorted Set indexado pelo `redisKey` do pool representando quando a instância volta a ficar disponível
- uma chave de ownership `{redisKey}:lease:{providerId}` contendo o token do owner atual

### Fluxo

1. O worker tenta adquirir um provider específico.
2. Um script Lua verifica se o score daquele provider já venceu.
3. Se estiver disponível, o script cria o ownership token com TTL e atualiza o score do provider para `now + safetyTtlMs`.
4. Enquanto o callback `fn(provider)` está rodando, o gateway renova a lease periodicamente com heartbeat.
5. No `finally`, o gateway tenta liberar a lease aplicando cooldown aleatório.

### Heartbeat

O heartbeat impede que jobs longos percam a posse da instância no meio da execução.

- sem heartbeat, um job que durasse mais que `safetyTtlMs` deixaria a instância reaparecer para outro worker
- com heartbeat, o TTL e o score são renovados enquanto o owner atual ainda for válido

### Stale release

O release é token-aware.

Se o owner atual do Redis não for mais o mesmo token que adquiriu a lease originalmente, o release vira no-op.

Isso evita o bug clássico em que um worker antigo sobrescreve o agendamento de disponibilidade de uma lease mais nova.

## Passthrough

No modo `passthrough`, o gateway:

- não registra o provider no Redis
- não faz acquire distribuído
- não cria ownership token
- apenas seleciona o provider e executa o callback

Esse modo existe para integrações em que não faz sentido impor exclusão distribuída por instância.

## Pools mistos

Um mesmo gateway pode ter providers `leased` e `passthrough` ao mesmo tempo.

O seletor interno usa rotação local para evitar que um único tipo monopolize todas as execuções. A decisão é sempre por provider, não por protocolo inteiro.

## Múltiplos pools via ProviderGatewayRegistry

O bootstrap do worker agrupa provider instances por `redis_key` e instancia um `ProviderGateway` por grupo. Esses gateways ficam expostos pelo `ProviderGatewayRegistry<T>`, que resolve por `providerInstanceId`:

```ts
interface GatewayRegistry<T extends MessagingProvider> {
  getByInstanceId(providerInstanceId: string): ProviderExecutor<T> | undefined;
}
```

Cada job AMQP carrega `providerInstanceId` no payload — o handler resolve o executor correto antes de chamar a action. Se o id não existir no registry (instância desconhecida pelo worker atual), o handler lança `NonRetryableError` e o job vai direto para DLQ: retry não corrige config drift.

Isso abre caminho para multi-tenant sem mudar as actions: instâncias isoladas num pool (`redis_key` próprio) não competem nem dividem cooldown com instâncias de outro pool.

## Relação com o provider registry

O provider registry persiste por instância:

- `execution_strategy`
- `redis_key` (NOT NULL — determina o pool)
- `custom_client_token` em `zapi_instances` (opcional — override do `env.ZAPI_CLIENT_TOKEN` por instância)

Os parâmetros operacionais do gateway são **envs globais**, sem override por instância:

- `ZAPI_DELAY_MIN_MS` / `ZAPI_DELAY_MAX_MS` — cooldown entre jobs
- `ZAPI_SAFETY_TTL_MS` — TTL da lease distribuída
- `ZAPI_HEARTBEAT_INTERVAL_MS` — intervalo de renovação da lease (< safety TTL)

O worker materializa esses campos no bootstrap e os injeta nos providers concretos. A identidade do provider dentro do gateway é o `providerInstanceId` (UUID da linha em `messaging_provider_instances`), não o `instance_id` externo da Z-API.

### Ejeção runtime via refresh manual

`POST /providers/instances/:id/refresh` (ver HTTP_API.md) chama sincronamente `/me`, `/device`, `/status` da Z-API. Em falha, além de marcar `currentConnectionState='unreachable'` e `isEnabled=false` no DB, o service executa `ZREM redisKey providerInstanceId` — o script Lua `ACQUIRE_LEASE_SCRIPT` retorna `nil` quando não há score no Sorted Set, então a instância é automaticamente pulada na rotação até o próximo restart. É o caminho único de ejeção runtime disponível hoje.

## Mutação via HTTP

A API expõe `POST`/`GET`/`PATCH /providers/instances` para criar, consultar, habilitar e desabilitar provider instances.

- As rotas escrevem apenas no banco (`messaging_provider_instances` + `zapi_instances`).
- O worker lê o registry **apenas no bootstrap**. A lista de providers do registry é imutável em runtime.
- Portanto, habilitar/desabilitar/criar via HTTP **só entra em vigor no próximo restart do worker**. As respostas dos endpoints retornam um campo `warning` explicitando isso.
- Um provider desabilitado continua executando jobs até o restart porque a lease no Redis permanece válida.
- Uma instância reabilitada sem restart também permanece inoperante até o próximo bootstrap: o Sorted Set `redis_key` ainda não terá sua entrada via `ZADD NX`, e o handler não resolve sua gateway.
- Runtime reload (via Redis pub/sub notificando os workers) é trabalho futuro.

## Limites e trade-offs

- `leased` garante exclusão distribuída enquanto heartbeat e Redis estiverem saudáveis
- o gateway não cancela callbacks em andamento se a lease for perdida; ele apenas evita que um stale release corrompa o estado seguinte
- `passthrough` não tenta impor nenhuma forma de serialização distribuída
- CRUD via HTTP depende de restart do worker para efetivar — ver "Mutação via HTTP" acima
- jobs sem `providerInstanceId` válido (inexistente no worker atual) vão para DLQ, não para retry

## Arquivos principais

- `src/gateways/gateway.ts`
- `src/gateways/gateway-registry.ts`
- `src/gateways/types.ts`
- `src/worker/index.ts`
- `src/worker/handler.ts`
- `src/services/provider-registry/provider-registry-read-service.ts`
