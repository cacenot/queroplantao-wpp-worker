---
description: Afinar prompt/examples de moderação com base num caso concreto — cria nova versão .md e ativa
---

# /tune-moderation — afinar moderation config

Slash command pra iterar no prompt/examples de moderação baseado num caso que
classificou errado. Fonte canônica é `src/ai/moderation/versions/*.md`; troca
de versão via `src/ai/moderation/active.ts`.

## Entrada esperada

Usuário passa um dos três formatos:

1. **ID de moderação** — `moderation_id` (uuid) de uma row em
   `message_moderations`. Consulta o DB pra pegar texto + output que o modelo deu.
2. **Texto + output errado inline** — ex.: `"Ta pedindo meu endereço... gente do céu!" foi classificado como scam/ban, deveria ser clean/allow`.
3. **Só texto** — nesse caso pergunte qual era o output esperado antes de seguir.

Se a entrada for ambígua, **pergunte** antes de fazer qualquer coisa.

## 1. Coletar caso

- Se ID de moderação: query via `psql`/`docker exec`:
  ```sql
  SELECT gm.normalized_text, gm.caption, mm.moderation_version, mm.reason,
         mm.partner, mm.category, mm.confidence, mm.action, mm.model
  FROM message_moderations mm
  JOIN group_messages gm ON gm.id = mm.group_message_id
  WHERE mm.id = '<uuid>';
  ```
  (Ajuste se o schema mudou — consulte `src/db/schema/message-moderations.ts` e
  `group-messages.ts`.)
- Texto da mensagem = `normalized_text` ou `caption` (o que tiver).
- Se id: pergunte ao usuário **qual seria a decisão correta** antes de prosseguir.

## 2. Ler estado atual

- Leia `src/ai/moderation/active.ts` pra achar `ACTIVE_VERSION`.
- Leia `src/ai/moderation/versions/${ACTIVE_VERSION}.md` completo (prompt + exemplos).
- Use `Bun.YAML.parse` mentalmente pra interpretar o frontmatter — não edite esses valores
  sem razão (primaryModel, escalationModel, threshold, escalationCategories).

## 3. Propor ajuste mínimo

Decida qual é o tipo de mudança:

- **Regra existente mal-redigida** → ajuste localizado no prompt (1-3 linhas).
- **Caso novo não coberto** → adicione exemplo novo em `# Exemplos`. Categoria
  + action + (opcional) partner. Reason concisa, descritiva, **sem** citar
  categorias removidas (veja guardrails).
- **Ambíguo** → pode ser os dois (exemplo + ajuste no prompt). Prefira exemplo
  sozinho se o prompt já cobre — não duplique regra.

**Princípio**: *adicionar > modificar > remover*. Pequeno delta > rewrite.

## 4. Gerar nova versão

- Nome: `yyyy-mm-vN` onde N = maior N do mês atual + 1. Ex.: se já existe
  `2026-04-v1` e `2026-04-v2`, a próxima é `2026-04-v3`. Se é o primeiro do
  mês, `v1`.
- Copie `src/ai/moderation/versions/${ACTIVE_VERSION}.md` →
  `src/ai/moderation/versions/${NOVA_VERSION}.md`.
- Atualize `version:` no frontmatter pra `${NOVA_VERSION}`.
- Aplique os deltas.
- **Mostre o diff** (novo vs ativo) antes de ativar.

## 5. Pedir confirmação

Pare e pergunte ao usuário se o delta está correto. Só siga com aceite explícito.

## 6. Ativar

- Edite `src/ai/moderation/active.ts`: troque `ACTIVE_VERSION` pra `${NOVA_VERSION}`.
- Rode `bun typecheck` e `bun test src/ai/moderation/loader.test.ts`.
  - Se qualquer um falhar: **reverta** o arquivo novo e o `active.ts`, reporte o erro.
  - Se passar: reporte a nova versão ativa + como reverter (editar `active.ts` de volta).

Não faça commit — workflow de commit é separado (ver `.claude/commands/commit.md`).

## Guardrails (não viole)

- **Enum de categoria no FORMATO DE SAÍDA OBRIGATÓRIO é intocável**. Qualquer
  edit que adicione/remova categoria é rejeitado.
- **Nunca remova seções inteiras** do prompt (REGRAS DE OURO, CATEGORIAS,
  DATABASE DE PARCEIROS). Só adicione ou ajuste.
- **Reasons dos examples só citam**: `clean | job_opportunity | sales | spam | scam`.
  Rejeite qualquer reason que mencione `profanity`, `competitor_promotion`,
  `product_sales`, `service_sales`, `off_topic`, `gambling_spam`, `piracy`,
  `adult_content`, `other_spam`.
- **Nunca apague example existente** sem confirmação 1-a-1 do usuário. Em caso
  de exemplo obsoleto, prefira reescrevê-lo em vez de remover.
- **Preferir adicionar novo example** cobrindo o caso em vez de mexer em examples
  existentes. Examples existentes são contratos implícitos — mudar muda o
  comportamento da LLM em casos que funcionavam.
- **Sempre mostre o diff** antes de aplicar.
- **Sempre rode o test do loader** no final. Se `loader.test.ts` falhar, algo
  no formato tá errado.

## Formato dos examples (lembrete)

```markdown
## N · category / action [· partner]
Reason curta, descritiva, sem citar categorias removidas.

​````input
<texto literal da mensagem>
​````
```

- Cabeçalho obrigatório: `## N · category / action`. Partner opcional.
- Reason = 1 linha descrevendo **por quê** a decisão (sem jargão contraditório
  tipo "viola X, porém…").
- Codeblock com fence `input`. Use 4 crases se o texto contém ``` crase ```.
