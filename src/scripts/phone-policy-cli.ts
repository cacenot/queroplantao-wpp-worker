import { createDbConnection, createDrizzleDb } from "../db/client.ts";
import { PhonePoliciesRepository } from "../db/repositories/phone-policies-repository.ts";
import { toE164 } from "../lib/phone.ts";
import {
  PhonePoliciesService,
  type PhonePolicyKind,
  type Protocol,
} from "../services/phone-policies/index.ts";

export type PhonePolicyCliOpts = {
  phone: string;
  protocol: Protocol;
  reason?: string;
  groupExternalId?: string | null;
};

export type ParsedArgs = {
  action: "add" | "remove";
  phone: string;
  protocol: Protocol;
  reason?: string;
  groupExternalId?: string;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const [action, phone, ...rest] = argv;

  if (action !== "add" && action !== "remove") {
    throw new Error(`Ação inválida: "${action ?? ""}". Use: add <phone> | remove <phone>`);
  }

  if (!phone) {
    throw new Error("Telefone obrigatório. Ex: +5547999999999");
  }

  let protocol: Protocol = "whatsapp";
  let reason: string | undefined;
  let groupExternalId: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--protocol") {
      const val = rest[++i];
      if (val !== "whatsapp" && val !== "telegram") {
        throw new Error(`Protocol inválido: "${val ?? ""}". Use: whatsapp | telegram`);
      }
      protocol = val;
    } else if (flag === "--reason") {
      reason = rest[++i];
    } else if (flag === "--group") {
      groupExternalId = rest[++i];
    }
  }

  if (action === "remove" && reason !== undefined) {
    throw new Error("--reason não é aceito em `remove`. Use apenas em `add`.");
  }

  return { action, phone, protocol, reason, groupExternalId };
}

type AddService = Pick<PhonePoliciesService, "add">;
type RemoveService = Pick<PhonePoliciesService, "list" | "remove">;

export async function addPolicy(
  service: AddService,
  kind: PhonePolicyKind,
  opts: PhonePolicyCliOpts
): Promise<void> {
  const e164 = toE164(opts.phone);
  if (!e164) {
    throw new Error(`Telefone inválido: "${opts.phone}". Use formato E.164 (ex: +5547999999999)`);
  }

  const view = await service.add({
    protocol: opts.protocol,
    kind,
    phone: e164,
    source: "manual",
    reason: opts.reason ?? null,
    groupExternalId: opts.groupExternalId ?? null,
  });

  const scope = view.groupExternalId ? `grupo ${view.groupExternalId}` : "global";
  console.log(`Adicionado: ${view.phone} → ${kind} (${view.protocol}, ${scope})`);
}

export async function removePolicy(
  service: RemoveService,
  kind: PhonePolicyKind,
  opts: PhonePolicyCliOpts
): Promise<void> {
  const e164 = toE164(opts.phone);
  if (!e164) {
    throw new Error(`Telefone inválido: "${opts.phone}". Use formato E.164 (ex: +5547999999999)`);
  }

  const { data } = await service.list(
    {
      protocol: opts.protocol,
      kind,
      phone: e164,
      groupExternalId: opts.groupExternalId ?? null,
    },
    { limit: 1, offset: 0 }
  );

  const policy = data[0];
  if (!policy) {
    const scope = opts.groupExternalId ? `grupo ${opts.groupExternalId}` : "global";
    throw new Error(
      `Política não encontrada: ${e164} não está na ${kind} (${opts.protocol}, ${scope})`
    );
  }

  await service.remove(policy.id);

  const scope = policy.groupExternalId ? `grupo ${policy.groupExternalId}` : "global";
  console.log(`Removido: ${e164} da ${kind} (${policy.protocol}, ${scope})`);
}

export async function runPolicyCli(kind: PhonePolicyKind): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const sql = createDbConnection();
  const db = createDrizzleDb(sql);
  const repo = new PhonePoliciesRepository(db);
  const service = new PhonePoliciesService({ repo });

  let exitCode = 0;
  try {
    const opts: PhonePolicyCliOpts = {
      phone: args.phone,
      protocol: args.protocol,
      reason: args.reason,
      groupExternalId: args.groupExternalId ?? null,
    };

    if (args.action === "add") {
      await addPolicy(service, kind, opts);
    } else {
      await removePolicy(service, kind, opts);
    }
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    console.error(err.message);
    exitCode = 1;
  } finally {
    await sql.end();
  }

  if (exitCode !== 0) process.exit(exitCode);
}
