# Débitos técnicos

## Sem auditoria de remoção de participantes

**Área:** `src/actions/whatsapp/remove-participant.ts`

`removeParticipant` chama o provider (Z-API) e não grava nenhum evento no banco. Não há como responder "o usuário X foi kickado do grupo Y às HH:MM" via DB.

**O que existe hoje:**
- `phone_policies` — quem está na blacklist e por quê (`source`, `reason`), mas não quando nem de qual grupo foi kickado
- `group_messages.removed_at` — qual mensagem foi deletada (e de quem), mas não o kick em si

**O que falta:** uma tabela de eventos (ex: `participant_removals`) com `phone`, `group_external_id`, `removed_at`, `source` (`blacklist` | `content_filter` | `manual`), `policy_id` e `moderation_id`.

**Query de contorno atual:** cruzar `phone_policies WHERE source='moderation_auto'` com `group_messages WHERE removed_at IS NOT NULL AND sender_phone = phone_policies.phone`. Cobre só casos de content-filter; blacklist manual não tem rastreabilidade de quando ocorreu.
