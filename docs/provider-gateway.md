# ProviderGateway

Documento de referência do `ProviderGateway<T>` e da estratégia de lease distribuída.

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

- um score no Sorted Set `messaging:{protocolo}` representando quando a instância volta a ficar disponível
- uma chave de ownership `messaging:{protocolo}:lease:{providerId}` contendo o token do owner atual

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

## Relação com o provider registry

O provider registry persiste a estratégia e os defaults operacionais do provider:

- `execution_strategy`
- `cooldown_min_ms`
- `cooldown_max_ms`
- `safety_ttl_ms`
- `heartbeat_interval_ms`

O worker materializa esses campos no bootstrap e os injeta nos providers concretos.

## Z-API e snapshot de estado

O snapshot atual da Z-API vive em `zapi_instances`, mas a observabilidade de webhook fica nas tabelas append-only:

- `zapi_instance_connection_events`
- `zapi_instance_device_snapshots`

`last_webhook_received_at` não deve existir em `zapi_instances`, porque webhooks de alta frequência transformariam a row de snapshot em hot row de update sem ganho real. O campo `received_at` nos eventos históricos já cobre esse caso.

## Mutação via HTTP

A API expõe `POST`/`GET`/`PATCH /providers/instances` para criar, consultar, habilitar e desabilitar provider instances.

- As rotas escrevem apenas no banco (`messaging_provider_instances` + `zapi_instances`).
- O worker lê o registry **apenas no bootstrap**. A lista de providers do `ProviderGateway` é imutável em runtime.
- Portanto, habilitar/desabilitar/criar via HTTP **só entra em vigor no próximo restart do worker**. As respostas dos endpoints retornam um campo `warning` explicitando isso.
- Um provider desabilitado continua executando jobs até o restart porque a lease no Redis permanece válida.
- Runtime reload (via Redis pub/sub notificando os workers) é trabalho futuro.

## Limites e trade-offs

- `leased` garante exclusão distribuída enquanto heartbeat e Redis estiverem saudáveis
- o gateway não cancela callbacks em andamento se a lease for perdida; ele apenas evita que um stale release corrompa o estado seguinte
- `passthrough` não tenta impor nenhuma forma de serialização distribuída
- CRUD via HTTP depende de restart do worker para efetivar — ver "Mutação via HTTP" acima

## Arquivos principais

- `src/messaging/gateway.ts`
- `src/messaging/types.ts`
- `src/worker/index.ts`
- `src/services/provider-registry/provider-registry-read-service.ts`