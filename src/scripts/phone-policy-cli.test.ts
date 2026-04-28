import { describe, expect, it } from "bun:test";
import {
  type AddPhonePolicyInput,
  ConflictError,
  type ListPhonePoliciesFilters,
  type ListPhonePoliciesResult,
  type PhonePolicyView,
} from "../services/phone-policies/index.ts";
import { addPolicy, parseArgs, removePolicy } from "./phone-policy-cli.ts";

// — Fake

function makeView(overrides: Partial<PhonePolicyView> = {}): PhonePolicyView {
  return {
    id: "policy-id-1",
    protocol: "whatsapp",
    kind: "blacklist",
    phone: "+5547999999999",
    senderExternalId: null,
    groupExternalId: null,
    source: "manual",
    reason: null,
    notes: null,
    moderationId: null,
    metadata: {},
    expiresAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

class FakeService {
  lastAddInput?: AddPhonePolicyInput;
  addResult: PhonePolicyView = makeView();
  addError?: Error;

  lastListFilters?: ListPhonePoliciesFilters;
  listResult: PhonePolicyView[] = [];

  lastRemoveId?: string;
  removeError?: Error;

  async add(input: AddPhonePolicyInput): Promise<PhonePolicyView> {
    this.lastAddInput = input;
    if (this.addError) throw this.addError;
    return this.addResult;
  }

  async list(
    filters: ListPhonePoliciesFilters,
    _pagination: { limit: number; offset: number }
  ): Promise<ListPhonePoliciesResult> {
    this.lastListFilters = filters;
    return {
      data: this.listResult,
      pagination: { limit: 1, offset: 0, total: this.listResult.length },
    };
  }

  async remove(id: string): Promise<void> {
    this.lastRemoveId = id;
    if (this.removeError) throw this.removeError;
  }
}

// — parseArgs

describe("parseArgs", () => {
  it("retorna action e phone com defaults", () => {
    const result = parseArgs(["add", "+5547999999999"]);
    expect(result.action).toBe("add");
    expect(result.phone).toBe("+5547999999999");
    expect(result.protocol).toBe("whatsapp");
    expect(result.reason).toBeUndefined();
    expect(result.groupExternalId).toBeUndefined();
  });

  it("aceita remove como action", () => {
    const result = parseArgs(["remove", "+5547999999999"]);
    expect(result.action).toBe("remove");
  });

  it("lê --protocol telegram", () => {
    const result = parseArgs(["add", "+5547999999999", "--protocol", "telegram"]);
    expect(result.protocol).toBe("telegram");
  });

  it("lê --reason", () => {
    const result = parseArgs(["add", "+5547999999999", "--reason", "spam detectado"]);
    expect(result.reason).toBe("spam detectado");
  });

  it("lê --group", () => {
    const result = parseArgs(["add", "+5547999999999", "--group", "grp-abc-123"]);
    expect(result.groupExternalId).toBe("grp-abc-123");
  });

  it("lê --reason e --group juntos", () => {
    const result = parseArgs(["add", "+5547999999999", "--reason", "spam", "--group", "grp-1"]);
    expect(result.reason).toBe("spam");
    expect(result.groupExternalId).toBe("grp-1");
  });

  it("lança Error para action inválida", () => {
    expect(() => parseArgs(["invalid", "+5547999999999"])).toThrow(/Ação inválida/);
  });

  it("lança Error para action ausente", () => {
    expect(() => parseArgs([])).toThrow(/Ação inválida/);
  });

  it("lança Error para phone ausente", () => {
    expect(() => parseArgs(["add"])).toThrow(/Telefone obrigatório/);
  });

  it("lança Error quando --reason é usado com remove", () => {
    expect(() => parseArgs(["remove", "+5547999999999", "--reason", "spam"])).toThrow(
      /--reason não é aceito em `remove`/
    );
  });

  it("lança Error para protocol inválido", () => {
    expect(() => parseArgs(["add", "+5547999999999", "--protocol", "ftp"])).toThrow(
      /Protocol inválido/
    );
  });
});

// — addPolicy

describe("addPolicy", () => {
  it("chama service.add com E.164 normalizado e source=manual", async () => {
    const svc = new FakeService();
    svc.addResult = makeView({ phone: "+5547999999999" });

    await addPolicy(svc, "blacklist", { phone: "+5547999999999", protocol: "whatsapp" });

    expect(svc.lastAddInput?.phone).toBe("+5547999999999");
    expect(svc.lastAddInput?.kind).toBe("blacklist");
    expect(svc.lastAddInput?.protocol).toBe("whatsapp");
    expect(svc.lastAddInput?.source).toBe("manual");
  });

  it("normaliza phone sem + para E.164", async () => {
    const svc = new FakeService();
    svc.addResult = makeView({ phone: "+5547999999999" });

    await addPolicy(svc, "blacklist", { phone: "5547999999999", protocol: "whatsapp" });

    expect(svc.lastAddInput?.phone).toBe("+5547999999999");
  });

  it("passa reason quando fornecido", async () => {
    const svc = new FakeService();
    svc.addResult = makeView();

    await addPolicy(svc, "blacklist", {
      phone: "+5547999999999",
      protocol: "whatsapp",
      reason: "spam reincidente",
    });

    expect(svc.lastAddInput?.reason).toBe("spam reincidente");
  });

  it("passa groupExternalId quando fornecido", async () => {
    const svc = new FakeService();
    svc.addResult = makeView({ groupExternalId: "grp-1" });

    await addPolicy(svc, "bypass", {
      phone: "+5547999999999",
      protocol: "whatsapp",
      groupExternalId: "grp-1",
    });

    expect(svc.lastAddInput?.groupExternalId).toBe("grp-1");
  });

  it("passa groupExternalId null quando ausente", async () => {
    const svc = new FakeService();
    svc.addResult = makeView();

    await addPolicy(svc, "blacklist", { phone: "+5547999999999", protocol: "whatsapp" });

    expect(svc.lastAddInput?.groupExternalId).toBeNull();
  });

  it("lança Error sem chamar service quando phone inválido", async () => {
    const svc = new FakeService();

    await expect(
      addPolicy(svc, "blacklist", { phone: "abc", protocol: "whatsapp" })
    ).rejects.toThrow(/Telefone inválido/);

    expect(svc.lastAddInput).toBeUndefined();
  });

  it("propaga ConflictError do service", async () => {
    const svc = new FakeService();
    svc.addError = new ConflictError("Política já existe");

    await expect(
      addPolicy(svc, "blacklist", { phone: "+5547999999999", protocol: "whatsapp" })
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

// — removePolicy

describe("removePolicy", () => {
  it("chama service.list com filtros corretos e remove pelo id encontrado", async () => {
    const policy = makeView({ id: "target-id", phone: "+5547999999999" });
    const svc = new FakeService();
    svc.listResult = [policy];

    await removePolicy(svc, "blacklist", { phone: "+5547999999999", protocol: "whatsapp" });

    expect(svc.lastListFilters?.phone).toBe("+5547999999999");
    expect(svc.lastListFilters?.kind).toBe("blacklist");
    expect(svc.lastListFilters?.protocol).toBe("whatsapp");
    expect(svc.lastRemoveId).toBe("target-id");
  });

  it("passa groupExternalId null em list quando ausente (política global)", async () => {
    const svc = new FakeService();
    svc.listResult = [makeView()];

    await removePolicy(svc, "blacklist", { phone: "+5547999999999", protocol: "whatsapp" });

    expect(svc.lastListFilters?.groupExternalId).toBeNull();
  });

  it("passa groupExternalId correto em list quando fornecido", async () => {
    const policy = makeView({ groupExternalId: "grp-xyz" });
    const svc = new FakeService();
    svc.listResult = [policy];

    await removePolicy(svc, "bypass", {
      phone: "+5547999999999",
      protocol: "whatsapp",
      groupExternalId: "grp-xyz",
    });

    expect(svc.lastListFilters?.groupExternalId).toBe("grp-xyz");
  });

  it("lança Error sem chamar service quando phone inválido", async () => {
    const svc = new FakeService();

    await expect(
      removePolicy(svc, "blacklist", { phone: "nope", protocol: "whatsapp" })
    ).rejects.toThrow(/Telefone inválido/);

    expect(svc.lastRemoveId).toBeUndefined();
  });

  it("lança Error quando política não encontrada", async () => {
    const svc = new FakeService();
    svc.listResult = [];

    await expect(
      removePolicy(svc, "blacklist", { phone: "+5547999999999", protocol: "whatsapp" })
    ).rejects.toThrow(/Política não encontrada/);

    expect(svc.lastRemoveId).toBeUndefined();
  });
});
