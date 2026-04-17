# Sync de grupos monitorados

## Motivação

O filtro de ingestão de mensagens precisa saber quais grupos estão sendo monitorados (~1200 grupos). Dois requisitos conflitantes:

1. **Latência sub-ms** no caminho crítico do webhook (resposta em <50ms para Z-API).
2. **Resiliência**: continuar filtrando corretamente se a admin API ficar fora do ar.

A solução é um cache Redis com fallback no Postgres local:

- **Redis** (`SISMEMBER`) → sub-ms, sem I/O de disco.
- **Postgres** (tabela `messaging_groups`) → fonte de verdade durável, lida quando Redis está vazio ou inconsistente.
- **Admin API** → fonte canônica remota, consultada periodicamente pelo worker.

> Todos os grupos sincronizados são considerados monitorados. O campo `is_community_visible` é metadado, não filtro.

---

## Schema `messaging_groups`

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `external_id` | text UNIQUE NOT NULL | ID do grupo no provider (ex: `120363...@g.us`) |
| `protocol` | enum `messaging_protocol` NOT NULL | `whatsapp` / `telegram` |
| `name` | text NOT NULL | |
| `invite_url` | text nullable | |
| `image_url` | text nullable | |
| `country` | text nullable | |
| `uf` | text nullable | |
| `region` | text nullable | |
| `city` | text nullable | |
| `specialties` | jsonb `string[]` nullable | sem tabela de mapeamento |
| `categories` | jsonb `string[]` nullable | |
| `participant_count` | integer nullable | snapshot da admin API |
| `is_community_visible` | boolean nullable | replica do campo `enabled` — **não** usado como filtro |
| `metadata` | jsonb nullable | payload extra da admin API |
| `source_updated_at` | timestamptz nullable | `updatedAt` vindo da admin API |
| `synced_at` | timestamptz NOT NULL | última vez visto no sync |
| `created_at` / `updated_at` | timestamptz | |

**Índices**:
- `external_id_idx` (unique)
- `protocol_idx`

---

## Estratégia de cache Redis

### Estrutura de chave

```
{MESSAGING_GROUPS_REDIS_PREFIX}:{protocol}
# ex: messaging_groups:whatsapp
```

Cada chave é um **Redis Set** com os `external_id`s dos grupos monitorados daquele protocol.

### Lookup no webhook (cache-first)

```
1. SISMEMBER messaging_groups:whatsapp <externalId>
   └─► 1 → aceita (< 1ms)
   └─► 0 → SELECT em messaging_groups WHERE external_id=$1 (fallback Postgres)
             └─► achou → SADD para repopular cache → aceita
             └─► não achou → descarta ("group-not-monitored")
```

O fallback Postgres protege contra:
- Redis vazio no boot (antes do primeiro sync completar).
- Flush acidental do Redis.
- Race entre startup da API e conclusão do primeiro sync.

### Rebuild do cache (após cada sync)

O cache é reconstruído a partir do estado atual do Postgres (não do payload da admin API), garantindo consistência mesmo em syncs parciais.

```typescript
// Implementação em MessagingGroupsCache.replaceSet()
// 1. Obtém nova chave versionada: messaging_groups:whatsapp:tmp:<uuid>
// 2. SADD em chunks de 1000 na chave temporária
// 3. RENAME atômico: messaging_groups:whatsapp:tmp:<uuid> → messaging_groups:whatsapp
```

O `RENAME` é atômico — leitores nunca veem o set parcialmente preenchido.

---

## Ciclo de sync

### Responsável: `GroupSyncService` (roda no worker)

```
┌─ startup do worker ──────────────────┐
│  await groupSyncService.syncFromAdminApi()  │  ← sync inicial (blocking)
└──────────────────────────────────────┘
         │
         ▼
┌─ setInterval ────────────────────────┐
│  syncFromAdminApi() a cada           │
│  GROUPS_SYNC_INTERVAL_MS (default 5min) │
└──────────────────────────────────────┘
```

### Passos do `syncFromAdminApi()`

1. `GET /api/internal/messaging-groups` na admin API (sem filtro — todos os grupos).
2. Se a resposta chegar vazia ou com erro → loga warn e **não altera** Postgres nem Redis.
3. `upsertMany()` no Postgres: `INSERT ... ON CONFLICT (external_id) DO UPDATE SET ...`.
4. `listExternalIdsByProtocol()` do Postgres (estado pós-upsert).
5. `replaceSet(protocol, externalIds)` no Redis.

### O que acontece em cada cenário de falha

| Cenário | Comportamento |
|---|---|
| Admin API fora | Sync loga warn, Postgres e Redis **não são alterados** — continuam servindo dados do último sync bem-sucedido |
| Redis fora | Lookup cai para Postgres; sync continua sem reconstruir cache; próximo sync tentará novamente |
| Postgres fora | Sync falha; lookup no webhook também falha (accept all ou reject all dependendo do retry) — ver nota abaixo |
| Boot frio sem sync ainda | Lookup cai para Postgres; se Postgres também estiver vazio, descarta todas as mensagens até o primeiro sync completar |

> **Nota Postgres fora**: se o fallback Postgres falhar, `isMonitored()` lança exceção que propaga para o webhook. O webhook responde 500, Z-API re-tentará. Não há modo "aceitar tudo" para evitar ingestão de grupos não monitorados.

---

## Variáveis de ambiente

| Variável | Default | Descrição |
|---|---|---|
| `GROUPS_SYNC_INTERVAL_MS` | `300000` (5min) | Intervalo do sync periódico no worker |
| `MESSAGING_GROUPS_REDIS_PREFIX` | `messaging_groups` | Prefixo das chaves Redis do cache |
| `QP_ADMIN_API_URL` | obrigatória | Base URL da admin API |
| `QP_ADMIN_API_TOKEN` | obrigatória | Bearer token para a admin API |

---

## Queries úteis

### Grupos atualmente monitorados
```sql
SELECT external_id, protocol, name, synced_at
FROM messaging_groups
ORDER BY synced_at DESC
LIMIT 50;
```

### Grupos não vistos no último sync (possível remoção)
```sql
SELECT external_id, name, synced_at
FROM messaging_groups
WHERE synced_at < now() - interval '10 minutes'
ORDER BY synced_at ASC;
```

### Contagem por protocol
```sql
SELECT protocol, COUNT(*) FROM messaging_groups GROUP BY protocol;
```

---

## Follow-ups

- **TTL curto + pubsub de invalidação**: útil se o sync a cada 5min mostrar lag perceptível. Não implementado pois rebuild do set em 1200 grupos é sub-ms.
- **Remoção automática de grupos**: atualmente grupos removidos da admin API continuam em `messaging_groups`. Adicionar soft-delete via `archivedAt` se necessário.
- **Sync na API além do worker**: hoje o sync roda só no worker; a API faz apenas lookup. Se a API precisar de sync independente, extrair `GroupSyncService` para lib compartilhada.
