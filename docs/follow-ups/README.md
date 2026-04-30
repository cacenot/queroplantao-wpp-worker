# Follow-ups

PRs e débitos técnicos identificados em revisões mas conscientemente deferidos pra escopo subsequente. Cada arquivo documenta motivação, plano de execução, dependências e critério de aceitação — pra que a próxima sessão (humana ou IA) entre cold sem precisar reconstruir o contexto.

Critério pra entrar aqui: **conhecimento que se perde se ficar só num comentário de PR**. Diferente de:

- `docs/architecture.md` — estado atual, não o que viria.
- `// TODO` no código — granular demais; pra qualquer débito que envolva mais que uma função, prefira um arquivo aqui.
- Issues no GitHub — quando o débito tem dependências cruzadas com o repo (paths, schema, decisões), o arquivo versionado vive melhor que uma issue.

## Atual

- [setTaskId-transactional-fix.md](./setTaskId-transactional-fix.md) — refactor pra vincular `outbound_messages.task_id` em transação atômica; loosen-fix atual é mitigação.
- [provider-instance-archived-removal.md](./provider-instance-archived-removal.md) — drop de `archived_at`; estado redundante com `is_enabled`.
- [zapi-disconnect-webhook.md](./zapi-disconnect-webhook.md) — handler de webhook de disconnect da Z-API; hoje só refresh manual desabilita instância morta.
