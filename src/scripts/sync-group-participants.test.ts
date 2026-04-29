import { describe, expect, it, mock } from "bun:test";

process.env.DATABASE_URL ??= "postgres://postgres:secret@localhost:5432/queroplantao_messaging";
process.env.AMQP_URL ??= "amqp://localhost";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.HTTP_API_KEY ??= "test-key";
process.env.ZAPI_BASE_URL ??= "https://test.example.com";
process.env.ZAPI_CLIENT_TOKEN ??= "test-client-token";
process.env.ZAPI_RECEIVED_WEBHOOK_SECRET ??= "test-webhook-secret";
process.env.QP_ADMIN_API_URL ??= "https://qp-admin.example.com";
process.env.QP_ADMIN_API_TOKEN ??= "test-admin-token";
process.env.QP_ADMIN_API_SERVICE_TOKEN ??= "test-service-token";

const { ZodError } = await import("zod");
const { ZApiError } = await import("../gateways/whatsapp/zapi/client.ts");
const { MAX_ATTEMPTS, BASE_DELAY_MS, fmtDuration, isRetryable, parseArgs, renderBar, withRetry } =
  await import("./sync-group-participants.ts");

describe("parseArgs", () => {
  it("aceita todas as flags válidas", () => {
    const args = parseArgs([
      "--instance-id",
      "abc-123",
      "--limit",
      "50",
      "--group-external-id",
      "120363@g.us",
      "--mark-missing-as-left",
      "--stale-hours",
      "12",
      "--concurrency",
      "10",
    ]);
    expect(args).toEqual({
      instanceId: "abc-123",
      limit: 50,
      groupExternalId: "120363@g.us",
      markMissingAsLeft: true,
      staleHours: 12,
      concurrency: 10,
      light: false,
    });
  });

  it("ativa --light", () => {
    const args = parseArgs(["--instance-id", "abc-123", "--light"]);
    expect(args.light).toBe(true);
  });

  it("aplica defaults", () => {
    const args = parseArgs(["--instance-id", "abc-123"]);
    expect(args).toEqual({
      instanceId: "abc-123",
      limit: null,
      groupExternalId: null,
      markMissingAsLeft: false,
      staleHours: 24,
      concurrency: 5,
      light: false,
    });
  });

  it("aceita stale-hours fracionário e zero", () => {
    expect(parseArgs(["--instance-id", "x", "--stale-hours", "0"]).staleHours).toBe(0);
    expect(parseArgs(["--instance-id", "x", "--stale-hours", "0.5"]).staleHours).toBe(0.5);
  });

  it("rejeita limit não-numérico", () => {
    expect(() => parseArgs(["--instance-id", "x", "--limit", "abc"])).toThrow(/--limit inválido/);
  });

  it("rejeita limit zero ou negativo", () => {
    expect(() => parseArgs(["--instance-id", "x", "--limit", "0"])).toThrow(/--limit inválido/);
    expect(() => parseArgs(["--instance-id", "x", "--limit", "-5"])).toThrow(/--limit inválido/);
  });

  it("rejeita stale-hours negativo", () => {
    expect(() => parseArgs(["--instance-id", "x", "--stale-hours", "-1"])).toThrow(
      /--stale-hours inválido/
    );
  });

  it("rejeita concurrency menor que 1", () => {
    expect(() => parseArgs(["--instance-id", "x", "--concurrency", "0"])).toThrow(
      /--concurrency inválido/
    );
  });

  it("rejeita flag desconhecida", () => {
    expect(() => parseArgs(["--instance-id", "x", "--bogus"])).toThrow(/Argumento desconhecido/);
  });

  it("rejeita ausência de --instance-id", () => {
    expect(() => parseArgs([])).toThrow(/--instance-id é obrigatório/);
  });
});

describe("isRetryable", () => {
  it("ZApiError com 5xx e 429 é retryable", () => {
    expect(isRetryable(new ZApiError("err", 500, null))).toBe(true);
    expect(isRetryable(new ZApiError("err", 502, null))).toBe(true);
    expect(isRetryable(new ZApiError("err", 503, null))).toBe(true);
    expect(isRetryable(new ZApiError("err", 429, null))).toBe(true);
  });

  it("ZApiError com timeout (status 0) é retryable", () => {
    expect(isRetryable(new ZApiError("timeout", 0, null))).toBe(true);
  });

  it("ZApiError com 4xx (exceto 429) NÃO é retryable", () => {
    expect(isRetryable(new ZApiError("bad", 400, null))).toBe(false);
    expect(isRetryable(new ZApiError("auth", 401, null))).toBe(false);
    expect(isRetryable(new ZApiError("forbid", 403, null))).toBe(false);
    expect(isRetryable(new ZApiError("not found", 404, null))).toBe(false);
    expect(isRetryable(new ZApiError("invalid", 422, null))).toBe(false);
  });

  it("erro genérico (não-ZApi) é retryable (rede/DNS)", () => {
    expect(isRetryable(new Error("ENETUNREACH"))).toBe(true);
    expect(isRetryable("string err")).toBe(true);
  });

  it("ZodError NÃO é retryable (payload inválido — retentar não muda nada)", () => {
    const err = new ZodError([
      {
        code: "invalid_type",
        expected: "array",
        received: "undefined",
        path: ["participants"],
        message: "Required",
      },
    ]);
    expect(isRetryable(err)).toBe(false);
  });
});

describe("withRetry", () => {
  // random=0.5 → jitter factor = 0.8 + 0.5*0.4 = 1.0 → delay = base (sem jitter).
  const noJitter = () => 0.5;

  it("retorna o valor na 1ª tentativa sem chamar sleep", async () => {
    const fn = mock(async () => "ok");
    const sleepMs = mock(async (_ms: number) => {});
    const got = await withRetry(fn, "label", { sleepMs, random: noJitter });
    expect(got).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepMs).toHaveBeenCalledTimes(0);
  });

  it("retenta erros retryable até obter sucesso", async () => {
    let calls = 0;
    const fn = mock(async () => {
      calls++;
      if (calls < 3) throw new ZApiError("server err", 503, null);
      return "ok";
    });
    const sleepMs = mock(async (_ms: number) => {});
    const onRetry = mock(() => {});

    const got = await withRetry(fn, "label", { sleepMs, onRetry, random: noJitter });
    expect(got).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepMs).toHaveBeenCalledTimes(2);
    expect(sleepMs.mock.calls.map((c) => c[0])).toEqual([BASE_DELAY_MS, BASE_DELAY_MS * 2]);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("propaga erro non-retryable imediatamente", async () => {
    const err = new ZApiError("not found", 404, null);
    const fn = mock(async () => {
      throw err;
    });
    const sleepMs = mock(async (_ms: number) => {});

    await expect(withRetry(fn, "label", { sleepMs, random: noJitter })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepMs).toHaveBeenCalledTimes(0);
  });

  it("esgota MAX_ATTEMPTS quando erro retryable persiste", async () => {
    const err = new ZApiError("503", 503, null);
    const fn = mock(async () => {
      throw err;
    });
    const sleepMs = mock(async (_ms: number) => {});

    await expect(withRetry(fn, "label", { sleepMs, random: noJitter })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(sleepMs).toHaveBeenCalledTimes(MAX_ATTEMPTS - 1);
    expect(sleepMs.mock.calls.map((c) => c[0])).toEqual([
      BASE_DELAY_MS,
      BASE_DELAY_MS * 2,
      BASE_DELAY_MS * 4,
      BASE_DELAY_MS * 8,
    ]);
  });

  it("aplica jitter de ±20% no delay", async () => {
    const fn = mock(async () => {
      throw new ZApiError("503", 503, null);
    });
    const sleepMs = mock(async (_ms: number) => {});

    // random=0 → fator 0.8 (mínimo)
    await expect(withRetry(fn, "label", { sleepMs, random: () => 0 })).rejects.toThrow();
    expect(sleepMs.mock.calls.map((c) => c[0])).toEqual([
      Math.round(BASE_DELAY_MS * 0.8),
      Math.round(BASE_DELAY_MS * 2 * 0.8),
      Math.round(BASE_DELAY_MS * 4 * 0.8),
      Math.round(BASE_DELAY_MS * 8 * 0.8),
    ]);

    sleepMs.mockClear();
    // random=1 → fator 1.2 (máximo). Limite teórico: random retorna < 1, mas testamos a borda.
    await expect(withRetry(fn, "label", { sleepMs, random: () => 1 })).rejects.toThrow();
    expect(sleepMs.mock.calls.map((c) => c[0])).toEqual([
      Math.round(BASE_DELAY_MS * 1.2),
      Math.round(BASE_DELAY_MS * 2 * 1.2),
      Math.round(BASE_DELAY_MS * 4 * 1.2),
      Math.round(BASE_DELAY_MS * 8 * 1.2),
    ]);
  });
});

describe("fmtDuration", () => {
  it("milissegundos abaixo de 1s", () => {
    expect(fmtDuration(0)).toBe("0ms");
    expect(fmtDuration(350)).toBe("350ms");
    expect(fmtDuration(999)).toBe("999ms");
  });

  it("segundos abaixo de 1m", () => {
    expect(fmtDuration(1_000)).toBe("1s");
    expect(fmtDuration(23_000)).toBe("23s");
    expect(fmtDuration(59_400)).toBe("59s"); // arredonda
  });

  it("minutos abaixo de 1h", () => {
    expect(fmtDuration(60_000)).toBe("1m 00s");
    expect(fmtDuration(107_000)).toBe("1m 47s");
    expect(fmtDuration(3_599_000)).toBe("59m 59s");
  });

  it("horas e minutos", () => {
    expect(fmtDuration(3_600_000)).toBe("1h 00m");
    expect(fmtDuration(3_661_000)).toBe("1h 01m");
    expect(fmtDuration(7_320_000)).toBe("2h 02m");
  });
});

describe("renderBar", () => {
  it("total=0 retorna barra vazia com largura correta", () => {
    const bar = renderBar(0, 0, 10);
    expect(bar).toBe(`[${"░".repeat(10)}]`);
  });

  it("done=total preenche 100%", () => {
    const bar = renderBar(10, 10, 10);
    expect(bar).toBe(`[${"█".repeat(10)}]`);
  });

  it("done=0 com total>0 fica vazia", () => {
    const bar = renderBar(0, 10, 10);
    expect(bar).toBe(`[${"░".repeat(10)}]`);
  });

  it("preenche metade quando done=total/2", () => {
    const bar = renderBar(50, 100, 30);
    expect(bar).toBe(`[${"█".repeat(15)}${"░".repeat(15)}]`);
  });

  it("arredonda corretamente para frações", () => {
    // 3/7 ≈ 0.4286 → 0.4286 * 10 = 4.286 → round = 4
    expect(renderBar(3, 7, 10)).toBe(`[${"█".repeat(4)}${"░".repeat(6)}]`);
  });

  it("clamp para 0–100% quando done > total", () => {
    expect(renderBar(15, 10, 10)).toBe(`[${"█".repeat(10)}]`);
  });

  it("largura default é 30", () => {
    expect(renderBar(0, 0)).toHaveLength(32); // 30 chars + 2 brackets
  });
});
