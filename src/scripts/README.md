# Scripts

Scripts utilitários para operações manuais e de manutenção. Todos são executados com `bun run <nome>` conforme mapeado no `package.json`.

---

## Moderação

### `test-moderation` — Testar uma mensagem

Classifica uma única mensagem usando o modelo de moderação ativo e exibe o resultado formatado no terminal.

```bash
bun run test-moderation "<mensagem>"
```

**Exemplo:**
```bash
bun run test-moderation "Plantão disponível no HU amanhã"
```

**Saída:** action (ALLOW / REMOVE / BAN), categoria, confiança com barra visual e reasoning.

**Env necessário:** `REDIS_URL`, `DATABASE_URL`, `MODERATION_CONFIG_REDIS_PREFIX`  
**Opcional:** `MODERATION_MODEL` (padrão: `openai/gpt-4o-mini`)

---

### `test-moderation-bulk` — Processar lote de mensagens via CSV

Classifica em lote mensagens de um CSV, com concorrência de 5 e barra de progresso em tempo real. Salva resultado em `src/scripts/moderation/output/output_<timestamp>.csv`.

```bash
bun run test-moderation-bulk <caminho/para/arquivo.csv>
```

**Formato do CSV de entrada:**

```
message
"Plantão amanhã no HU"
"Compre agora com desconto"
```

Aceita CSV com ou sem cabeçalho `message`. Campos entre aspas (incluindo multiline) são tratados corretamente.

**CSV de saída:** `message, action, partner, category, confidence, reason, error`

**Env necessário:** `REDIS_URL`, `DATABASE_URL`, `MODERATION_CONFIG_REDIS_PREFIX`  
**Opcional:** `MODERATION_MODEL` (padrão: `openai/gpt-4o-mini`)

---

## Remoção manual

### `remove-by-phone` — Remover mensagens de um número

Busca mensagens de um telefone no banco, publica jobs de deleção e remove o participante dos grupos onde enviou mensagens.

```bash
bun run remove-by-phone <telefone> [limit|all] [all]
```

**Exemplos:**
```bash
# apenas mensagens de hoje (padrão)
bun run remove-by-phone "5511999999999"

# limite de 100 mensagens de hoje
bun run remove-by-phone "5511999999999" 100

# todas as mensagens do histórico, sem limite
bun run remove-by-phone "5511999999999" all

# todas do histórico, limite de 50
bun run remove-by-phone "5511999999999" 50 all
```

**Env necessário:** `DATABASE_URL`, `AMQP_URL`, `AMQP_QUEUE`

---

### `remove-spam` — Remover mensagens por filtro de texto

Busca mensagens que contenham um ou mais termos (ILIKE) e publica jobs de deleção e remoção de participantes.

```bash
bun run remove-spam <filtro1> [filtro2 ...] [limit|all] [all]
```

**Exemplos:**
```bash
# filtro único, mensagens de hoje
bun run remove-spam "https://tk7.games"

# múltiplos filtros, limite de 100
bun run remove-spam "https://tk7.games" "bit.ly" 100

# todo o histórico
bun run remove-spam "encurta.ai" all
```

**Env necessário:** `DATABASE_URL`, `AMQP_URL`, `AMQP_QUEUE`

---

### `spam-watcher` — Daemon de vigilância de spam

Executa `remove-spam` automaticamente em intervalos regulares. Roda indefinidamente como processo daemon.

```bash
bun run spam-watcher
```

**Env necessário:**

| Variável | Descrição |
|---|---|
| `SPAM_FILTERS` | Filtros separados por vírgula, ex.: `"tk7.games,encurta.ai"` |
| `SPAM_INTERVAL_MS` | Intervalo entre execuções em ms, ex.: `60000` |
| `DATABASE_URL`, `AMQP_URL`, `AMQP_QUEUE` | Igual ao `remove-spam` |

---

## Sincronização e seed

### `sync-groups` — Sincronizar grupos do WhatsApp

Busca os grupos de mensagens na API do Quero Plantão Admin e atualiza banco e cache Redis.

```bash
bun run sync-groups
```

**Env necessário:** `REDIS_URL`, `DATABASE_URL`, `QP_ADMIN_API_URL`, `QP_ADMIN_API_TOKEN`, `QP_ADMIN_API_SERVICE_TOKEN`, `MESSAGING_GROUPS_REDIS_PREFIX`

---

### `seed-initial` — Seed idempotente para novos ambientes

Inicializa um ambiente novo (inclusive produção) em três etapas, pulando o que já existe:

1. **Provider instances** — cria instâncias Z-API (somente se `SEED_DATA_JSON` for passado)
2. **Moderation config** — cria configuração de moderação inicial ativa
3. **Sync groups** — sincroniza grupos via API Admin

```bash
bun run seed-initial
```

**Com instâncias Z-API:**
```bash
SEED_DATA_JSON='{"instances":[{"displayName":"Principal","zapiInstanceId":"abc123","instanceToken":"tok","customClientToken":null}]}' \
  bun run seed-initial
```

**Env necessário:** `REDIS_URL`, `DATABASE_URL`, `QP_ADMIN_API_URL`, `QP_ADMIN_API_TOKEN`, `QP_ADMIN_API_SERVICE_TOKEN`, `MESSAGING_GROUPS_REDIS_PREFIX`, `MODERATION_CONFIG_REDIS_PREFIX`, `ZAPI_CLIENT_TOKEN`
