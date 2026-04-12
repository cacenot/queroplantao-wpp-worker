import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { Connection } from "rabbitmq-client";

const phone = process.argv[2];
const allDays = process.argv.includes("all");
const limitArg = process.argv.find((a) => a !== "all" && a !== phone && Number.isFinite(Number(a)));
const limit = Number(limitArg || "0");

if (!phone) {
  console.error("Uso: bun run src/scripts/remove-by-phone.ts <telefone> [limit] [all]");
  console.error('Exemplo: bun run src/scripts/remove-by-phone.ts "5511999999999" 100');
  console.error('         bun run src/scripts/remove-by-phone.ts "5511999999999" all');
  console.error('         bun run src/scripts/remove-by-phone.ts "5511999999999" 100 all');
  console.error(
    "limit=0 (default) processa todas as mensagens. all = sem filtro de data (default: somente hoje)."
  );
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
const AMQP_URL = process.env.AMQP_URL;
const AMQP_QUEUE = process.env.AMQP_QUEUE;

if (!DATABASE_URL || !AMQP_URL || !AMQP_QUEUE) {
  console.error("Variáveis obrigatórias: DATABASE_URL, AMQP_URL, AMQP_QUEUE");
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

console.log(
  `Buscando mensagens com sender_phone ILIKE '%${phone}%'${limit > 0 ? ` (limit: ${limit})` : ""}${allDays ? " (todos os dias)" : " (somente hoje)"}...`
);

const rows = await sql<
  { external_message_id: string; sender_phone: string; group_external_id: string }[]
>`
  SELECT external_message_id, sender_phone, group_external_id
  FROM zapi_group_messages
  WHERE sender_phone ILIKE ${`%${phone}%`}
    AND removed IS false
    ${allDays ? sql`` : sql`AND sent_at >= CURRENT_DATE AND sent_at < CURRENT_DATE + INTERVAL '1 day'`}
  ${limit > 0 ? sql`LIMIT ${limit}` : sql``}
`;

console.log(`Encontradas ${rows.length} mensagens.`);

if (rows.length === 0) {
  await sql.end();
  process.exit(0);
}

const rabbit = new Connection(AMQP_URL);
const publisher = rabbit.createPublisher({ confirm: true });

const now = new Date().toISOString();
let deleteCount = 0;

for (const row of rows) {
  await publisher.send(
    { routingKey: AMQP_QUEUE, durable: true },
    {
      id: randomUUID(),
      type: "delete_message",
      targetKey: row.group_external_id,
      createdAt: now,
      payload: {
        messageId: row.external_message_id,
        phone: row.group_external_id,
        owner: false,
      },
    }
  );
  console.log(`delete_message: ${row.external_message_id} (grupo: ${row.group_external_id})`);
  deleteCount++;
}

console.log(`Publicados ${deleteCount} jobs delete_message.`);

const uniquePairs = new Set<string>();
for (const row of rows) {
  uniquePairs.add(`${row.sender_phone}:${row.group_external_id}`);
}

let removeCount = 0;

for (const pair of uniquePairs) {
  const [senderPhone, groupExternalId] = pair.split(":");
  await publisher.send(
    { routingKey: AMQP_QUEUE, durable: true },
    {
      id: randomUUID(),
      type: "remove_participant",
      targetKey: groupExternalId,
      createdAt: now,
      payload: {
        groupId: groupExternalId,
        phones: [senderPhone],
      },
    }
  );
  removeCount++;
}

console.log(`Publicados ${removeCount} jobs remove_participant.`);
console.log("Concluído.");

await publisher.close();
await rabbit.close();
await sql.end();
