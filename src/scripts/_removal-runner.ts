import { createInterface } from "node:readline/promises";
import { Connection } from "rabbitmq-client";
import { env } from "../config/env.ts";
import { createDbConnection, createDrizzleDb } from "../db/client.ts";
import { PhonePoliciesRepository } from "../db/repositories/phone-policies-repository.ts";
import { TaskRepository } from "../db/repositories/task-repository.ts";
import { logger } from "../lib/logger.ts";
import {
  GroupMessagesRemovalService,
  type RemovalPreview,
  type RemovalResult,
} from "../services/group-messages-removal/index.ts";
import { PhonePoliciesService } from "../services/phone-policies/index.ts";
import { TaskService } from "../services/task/index.ts";

export type RemovalRunner = {
  service: GroupMessagesRemovalService;
  close: () => Promise<void>;
};

export async function buildRemovalRunner(): Promise<RemovalRunner> {
  const sql = createDbConnection();
  const db = createDrizzleDb(sql);
  const rabbit = new Connection(env.AMQP_URL);
  const publisher = rabbit.createPublisher({ confirm: true });

  const phonePoliciesService = new PhonePoliciesService({
    repo: new PhonePoliciesRepository(db),
  });
  const taskService = new TaskService({
    repo: new TaskRepository(db),
    publisher,
    queueName: env.AMQP_QUEUE,
  });
  const service = new GroupMessagesRemovalService({
    db,
    phonePoliciesService,
    taskService,
    logger,
  });

  return {
    service,
    async close() {
      await publisher.close();
      await rabbit.close();
      await sql.end();
    },
  };
}

export async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} `);
    const trimmed = answer.trim().toLowerCase();
    return trimmed === "s" || trimmed === "sim" || trimmed === "y" || trimmed === "yes";
  } finally {
    rl.close();
  }
}

export function formatPreview(p: RemovalPreview): string {
  const lines = [
    `${p.messageCount} mensagens em ${p.groupCount} grupos de ${p.senderCount} senders.`,
  ];
  if (p.excludedByAllowlistCount > 0) {
    lines.push(`(${p.excludedByAllowlistCount} mensagens excluídas por allowlist)`);
  }
  return lines.join("\n");
}

export function formatResult(r: RemovalResult): string {
  const lines = [
    `Publicados ${r.messagesDeleteEnqueued} delete_message + ${r.participantsRemoveEnqueued} remove_participant.`,
  ];
  if (r.mode === "by-phone") {
    if (r.blacklistAdded) lines.push("Phone adicionado à blacklist.");
    else if (r.alreadyBlacklisted) lines.push("Phone já estava na blacklist (nenhuma ação).");
  }
  if (r.excludedByAllowlistCount > 0) {
    lines.push(`${r.excludedByAllowlistCount} mensagens puladas por allowlist.`);
  }
  return lines.join("\n");
}

export function parseFlagArgs(args: string[]): { allDays: boolean; limit: number } {
  const allDays = args.includes("all");
  const limitArg = args.find((a) => a !== "all" && /^\d+$/.test(a));
  const limit = limitArg ? Number(limitArg) : 0;
  return { allDays, limit };
}
