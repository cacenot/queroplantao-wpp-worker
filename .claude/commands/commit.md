---
description: Roda lint/format/typecheck/testes (unit + integração) e comita apenas o que foi modificado nesta sessão
---

# /commit — workflow de commit deste projeto

Siga **estritamente** os passos abaixo. Não pule, não invente atalhos.

## 1. Coleta de contexto (paralelo)

Em um único bloco de tool-use, rode em paralelo:

- `git status` (sem `-uall`)
- `git diff`
- `git diff --staged`
- `git log -10 --oneline`
- `git branch --show-current`

## 2. Checagem de branch

Se a branch atual for `main`:

- **PARE** e pergunte ao usuário se ele realmente quer comitar direto na `main`.
- Só prossiga após confirmação explícita.

## 3. Definir o que vai entrar no commit

**Regra padrão:** comitar **apenas** os arquivos que você criou/modificou nesta sessão (via Edit/Write/NotebookEdit). Arquivos modificados que você **não** tocou ficam intocados — nem stage, nem revert.

Para identificar:
- Releia a conversa atual e liste cada path que apareceu em chamadas Edit/Write/NotebookEdit suas.
- Cruze com `git status` para confirmar que de fato têm mudança no working tree.

Exceções:
- Usuário disse "comita tudo" / "commit everything" → inclui todas as mudanças do `git status`.
- Usuário nomeou arquivos específicos → use exatamente esses.

Se não tiver certeza de quais arquivos foram seus, **PERGUNTE** antes de stagear.

## 4. Quality gates

### 4a. Biome (lint + format + organize-imports, com auto-fix)

Rode escopado aos arquivos do commit, pra não modificar arquivos fora do escopo:

```
bunx biome check --write <arquivo1> <arquivo2> ...
```

> Nota: `bun check` (`biome check --write ./src`) faz o mesmo que `bun lint` + `bun format` juntos, **mais** organização de imports. Sempre prefira `check`. Mas aqui rodamos escopado nos arquivos do commit, não no projeto inteiro.

Se o biome modificar algum arquivo, isso é esperado — siga em frente.

### 4b. Em paralelo (um único bloco de tool-use)

- `bun typecheck`
- `docker compose ps --status running -q | grep -q . || bun infra` seguido de `bun test:verbose`

> Sempre verifique se a infra já está rodando antes de chamar `bun infra` (`docker compose up -d`) — subir containers já existentes causa erro de porta em uso. O check acima pula o `bun infra` se já houver containers rodando. `test:verbose` roda a suite completa (unit + integration) com logs visíveis.

### 4c. Falhas

- Qualquer falha (typecheck, unit, integração) → **PARE**, reporte o erro, não comite.
- Tente corrigir se for trivial e claramente relacionado ao seu trabalho. Para outros casos, pergunte ao usuário antes de mexer.

## 5. Commit

### Stage

Use `git add <path1> <path2> ...` com paths **explícitos**. **Nunca** use `git add -A`, `git add .` ou `git add -u`.

### Mensagem

Siga o estilo do `git log -10` deste repo:
- Conventional Commits em **português** (curto, imperativo).
- Prefixos comuns aqui: `feat:`, `chore:`, `fix:`, `refactor:`, `docs:`, `test:`.
- Exemplos reais do repo:
  - `feat: multi-pool ProviderGateway via redis_key + routing por providerInstanceId`
  - `chore: add postgres to local compose, reorganize .env.example, remove legacy ZAPI envs`
  - `feat: add retry mechanism with TTL+DLX and test coverage`

Foque no **porquê** (1-2 frases), não no que (o diff já mostra).

**Não** adicione `Co-Authored-By` — não é a convenção deste repo.

### Comando

Sempre via HEREDOC pra preservar formatação:

```bash
git commit -m "$(cat <<'EOF'
feat: descrição curta aqui

Corpo opcional explicando o porquê.
EOF
)"
```

## 6. Verificação

Rode `git status` depois do commit pra confirmar que ficou limpo (ou que sobraram apenas arquivos fora do escopo, como esperado).

## 7. Não fazer

- ❌ Não rodar `git push` (a menos que o usuário peça).
- ❌ Não usar `--amend`, `--no-verify`, `--force`.
- ❌ Não criar commits vazios.
- ❌ Não comitar `.env`, credenciais, ou arquivos com segredos. Avisar se aparecerem no diff.
