import { describe, expect, it, mock } from "bun:test";
import type { PhonePoliciesRepository } from "../../db/repositories/phone-policies-repository.ts";
import type { PhonePolicyRow } from "../../db/schema/phone-policies.ts";
import { PhonePoliciesService } from "./phone-policies-service.ts";
import { ConflictError, NotFoundError, ValidationError } from "./types.ts";

function makeRow(overrides: Partial<PhonePolicyRow> = {}): PhonePolicyRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    protocol: "whatsapp",
    kind: "blacklist",
    phone: "5511999990001",
    groupExternalId: null,
    source: "manual",
    reason: null,
    notes: null,
    moderationId: null,
    metadata: {},
    expiresAt: null,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    ...overrides,
  };
}

type FakeRepo = {
  create: ReturnType<typeof mock>;
  findById: ReturnType<typeof mock>;
  delete: ReturnType<typeof mock>;
  findMatch: ReturnType<typeof mock>;
  list: ReturnType<typeof mock>;
};

function makeRepo(overrides: Partial<FakeRepo> = {}): PhonePoliciesRepository {
  const repo: FakeRepo = {
    create: mock(async (row) => makeRow(row)),
    findById: mock(async () => null),
    delete: mock(async () => true),
    findMatch: mock(async () => null),
    list: mock(async () => ({ rows: [], total: 0 })),
    ...overrides,
  };
  return repo as unknown as PhonePoliciesRepository;
}

describe("PhonePoliciesService", () => {
  describe("add", () => {
    it("normaliza phone e persiste defaults", async () => {
      let captured: unknown;
      const repo = makeRepo({
        create: mock(async (row) => {
          captured = row;
          return makeRow(row);
        }),
      });
      const svc = new PhonePoliciesService({ repo });

      await svc.add({
        protocol: "whatsapp",
        kind: "blacklist",
        phone: "+55 (11) 99999-0001",
      });

      expect((captured as { phone: string }).phone).toBe("5511999990001");
      expect((captured as { source: string }).source).toBe("manual");
      expect((captured as { groupExternalId: null }).groupExternalId).toBeNull();
      expect((captured as { metadata: Record<string, unknown> }).metadata).toEqual({});
    });

    it("rejeita phone inválido após normalização", async () => {
      const svc = new PhonePoliciesService({ repo: makeRepo() });

      await expect(
        svc.add({ protocol: "whatsapp", kind: "blacklist", phone: "abc" })
      ).rejects.toThrow(ValidationError);

      await expect(
        svc.add({ protocol: "whatsapp", kind: "blacklist", phone: "1234" })
      ).rejects.toThrow(ValidationError);
    });

    it("aceita expiresAt como string ISO", async () => {
      let captured: unknown;
      const repo = makeRepo({
        create: mock(async (row) => {
          captured = row;
          return makeRow(row);
        }),
      });
      const svc = new PhonePoliciesService({ repo });

      await svc.add({
        protocol: "whatsapp",
        kind: "blacklist",
        phone: "5511999990002",
        expiresAt: "2026-05-01T00:00:00Z",
      });

      expect((captured as { expiresAt: Date }).expiresAt).toBeInstanceOf(Date);
    });

    it("rejeita expiresAt inválido", async () => {
      const svc = new PhonePoliciesService({ repo: makeRepo() });
      await expect(
        svc.add({
          protocol: "whatsapp",
          kind: "blacklist",
          phone: "5511999990003",
          expiresAt: "not-a-date",
        })
      ).rejects.toThrow(ValidationError);
    });

    it("traduz unique violation em ConflictError", async () => {
      const repo = makeRepo({
        create: mock(async () => {
          throw new Error(
            'duplicate key value violates unique constraint "phone_policies_unique_idx"'
          );
        }),
      });
      const svc = new PhonePoliciesService({ repo });

      await expect(
        svc.add({ protocol: "whatsapp", kind: "blacklist", phone: "5511999990004" })
      ).rejects.toThrow(ConflictError);
    });
  });

  describe("remove", () => {
    it("lança NotFoundError quando id não existe", async () => {
      const repo = makeRepo({ delete: mock(async () => false) });
      const svc = new PhonePoliciesService({ repo });

      await expect(svc.remove("missing")).rejects.toThrow(NotFoundError);
    });

    it("resolve sem erro quando deleta", async () => {
      const repo = makeRepo({ delete: mock(async () => true) });
      const svc = new PhonePoliciesService({ repo });
      await svc.remove("some-id");
    });
  });

  describe("list", () => {
    it("normaliza phone no filtro e retorna view + pagination", async () => {
      let captured: unknown;
      const repo = makeRepo({
        list: mock(async (filters) => {
          captured = filters;
          return {
            rows: [makeRow({ phone: "5511999990010" })],
            total: 1,
          };
        }),
      });
      const svc = new PhonePoliciesService({ repo });

      const result = await svc.list({ phone: "+55 (11) 99999-0010" }, { limit: 5, offset: 0 });

      expect((captured as { phone: string }).phone).toBe("5511999990010");
      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
    });
  });

  describe("isBlacklisted / isBypassed", () => {
    it("isBlacklisted chama findMatch com kind=blacklist", async () => {
      const repo = makeRepo({
        findMatch: mock(async () => makeRow({ kind: "blacklist" })),
      });
      const svc = new PhonePoliciesService({ repo });

      const hit = await svc.isBlacklisted("5511999990020", "whatsapp", "grp-x");
      expect(hit?.kind).toBe("blacklist");
      expect(repo.findMatch).toHaveBeenCalledWith(
        "whatsapp",
        "blacklist",
        "5511999990020",
        "grp-x"
      );
    });

    it("isBypassed chama findMatch com kind=bypass", async () => {
      const repo = makeRepo({
        findMatch: mock(async () => makeRow({ kind: "bypass" })),
      });
      const svc = new PhonePoliciesService({ repo });

      const hit = await svc.isBypassed("5511999990021", "whatsapp", "grp-x");
      expect(hit?.kind).toBe("bypass");
      expect(repo.findMatch).toHaveBeenCalledWith("whatsapp", "bypass", "5511999990021", "grp-x");
    });

    it("retorna null quando phone normalizado é vazio", async () => {
      const repo = makeRepo({
        findMatch: mock(async () => makeRow()),
      });
      const svc = new PhonePoliciesService({ repo });

      const hit = await svc.isBlacklisted("", "whatsapp", "grp-x");
      expect(hit).toBeNull();
      expect(repo.findMatch).not.toHaveBeenCalled();
    });

    it("retorna null quando repo não encontra", async () => {
      const repo = makeRepo({ findMatch: mock(async () => null) });
      const svc = new PhonePoliciesService({ repo });

      const hit = await svc.isBlacklisted("5511999990022", "whatsapp", "grp-x");
      expect(hit).toBeNull();
    });

    it("normaliza phone antes do lookup", async () => {
      const repo = makeRepo({
        findMatch: mock(async () => null),
      });
      const svc = new PhonePoliciesService({ repo });

      await svc.isBlacklisted("+55 11 99999-0023", "whatsapp", "grp-x");
      expect(repo.findMatch).toHaveBeenCalledWith(
        "whatsapp",
        "blacklist",
        "5511999990023",
        "grp-x"
      );
    });
  });
});
