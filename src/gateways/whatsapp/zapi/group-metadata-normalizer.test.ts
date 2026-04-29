import { describe, expect, it } from "bun:test";
import { normalizeGroupMetadata } from "./group-metadata-normalizer.ts";
import type { ZApiGroupMetadata } from "./group-metadata-schema.ts";

function build(participants: ZApiGroupMetadata["participants"]): ZApiGroupMetadata {
  return { participants };
}

describe("normalizeGroupMetadata", () => {
  it("normaliza phone Z-API digits para E.164 + waId", () => {
    const result = normalizeGroupMetadata(
      "120363@g.us",
      build([{ phone: "5547997490248", isAdmin: false, isSuperAdmin: false }])
    );
    expect(result.participants).toHaveLength(1);
    expect(result.participants[0]).toEqual({
      phone: "+5547997490248",
      senderExternalId: null,
      waId: "5547997490248@s.whatsapp.net",
      role: "member",
    });
  });

  it("identifica admin e owner via flags", () => {
    const result = normalizeGroupMetadata(
      "120363@g.us",
      build([
        { phone: "5547911111111", isAdmin: true, isSuperAdmin: false },
        { phone: "5547922222222", isAdmin: true, isSuperAdmin: true },
      ])
    );
    expect(result.participants[0]?.role).toBe("admin");
    expect(result.participants[1]?.role).toBe("owner");
  });

  it("trata LID como senderExternalId puro", () => {
    const result = normalizeGroupMetadata(
      "120363@g.us",
      build([{ phone: "1234567890@lid", isAdmin: false, isSuperAdmin: false }])
    );
    expect(result.participants[0]).toEqual({
      phone: null,
      senderExternalId: "1234567890@lid",
      waId: null,
      role: "member",
    });
  });

  it("trata phone canonical (@s.whatsapp.net) preservando waId", () => {
    const result = normalizeGroupMetadata(
      "120363@g.us",
      build([{ phone: "5547997490248@s.whatsapp.net", isAdmin: false, isSuperAdmin: false }])
    );
    expect(result.participants[0]).toEqual({
      phone: null,
      senderExternalId: null,
      waId: "5547997490248@s.whatsapp.net",
      role: "member",
    });
  });

  it("filtra entries inválidas (phone vazio ou irrecuperável)", () => {
    const result = normalizeGroupMetadata(
      "120363@g.us",
      build([
        { phone: "5547997490248", isAdmin: false, isSuperAdmin: false },
        { phone: "abc", isAdmin: false, isSuperAdmin: false },
      ])
    );
    expect(result.participants).toHaveLength(1);
    expect(result.participants[0]?.phone).toBe("+5547997490248");
  });
});
