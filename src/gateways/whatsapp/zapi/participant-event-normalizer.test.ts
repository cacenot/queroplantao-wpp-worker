import { describe, expect, it } from "bun:test";
import { extractZapiParticipantEvent } from "./participant-event-normalizer.ts";
import type { ZapiReceivedWebhookPayload } from "./webhook-schema.ts";

function base(overrides: Partial<ZapiReceivedWebhookPayload> = {}): ZapiReceivedWebhookPayload {
  return {
    instanceId: "3D0000",
    messageId: "msg-1",
    phone: "120363@g.us",
    connectedPhone: "5511999999999",
    chatName: "Grupo Teste",
    senderName: "AdminName",
    participantPhone: "5511999990001",
    participantLid: "5511999990001@lid",
    fromMe: false,
    isGroup: true,
    isNewsletter: false,
    broadcast: false,
    type: "ReceivedCallback",
    momment: 1_700_000_000_000,
    ...overrides,
  };
}

describe("extractZapiParticipantEvent — descartes", () => {
  it("descarta não-grupo", () => {
    const r = extractZapiParticipantEvent(base({ isGroup: false }));
    expect(r.status).toBe("ignored");
    if (r.status === "ignored") expect(r.reason).toBe("not-group");
  });

  it("descarta newsletter", () => {
    const r = extractZapiParticipantEvent(base({ isNewsletter: true }));
    expect(r.status).toBe("ignored");
    if (r.status === "ignored") expect(r.reason).toBe("newsletter");
  });

  it("descarta sem notification (mensagem normal)", () => {
    const r = extractZapiParticipantEvent(base({ notification: undefined }));
    expect(r.status).toBe("ignored");
    if (r.status === "ignored") expect(r.reason).toBe("no-notification");
  });

  it("descarta notification desconhecida e inclui valor cru", () => {
    const r = extractZapiParticipantEvent(base({ notification: "SOMETHING_NEW" }));
    expect(r.status).toBe("ignored");
    if (r.status === "ignored") {
      expect(r.reason).toBe("unknown-notification");
      expect(r.notification).toBe("SOMETHING_NEW");
    }
  });
});

describe("extractZapiParticipantEvent — mapeamento", () => {
  it.each([
    ["GROUP_PARTICIPANT_ADD", "joined_add"],
    ["GROUP_PARTICIPANT_REMOVE", "left_removed"],
    ["GROUP_PARTICIPANT_LEAVE", "left_voluntary"],
    ["GROUP_PARTICIPANT_PROMOTE", "promoted_admin"],
    ["GROUP_PARTICIPANT_DEMOTE", "demoted_member"],
    ["GROUP_ADMIN_PROMOTE", "promoted_admin"],
    ["GROUP_ADMIN_DEMOTE", "demoted_member"],
  ] as const)("mapeia %s → %s", (notification, eventType) => {
    const r = extractZapiParticipantEvent(
      base({ notification, notificationParameters: ["5511999990002"] })
    );
    expect(r.status).toBe("accepted");
    if (r.status === "accepted") expect(r.data.eventType).toBe(eventType);
  });

  it("MEMBERSHIP_APPROVAL_REQUEST + invite_link → joined_invite_link", () => {
    const r = extractZapiParticipantEvent(
      base({
        notification: "MEMBERSHIP_APPROVAL_REQUEST",
        requestMethod: "invite_link",
        notificationParameters: ["5511999990002"],
      })
    );
    expect(r.status).toBe("accepted");
    if (r.status === "accepted") expect(r.data.eventType).toBe("joined_invite_link");
  });

  it("MEMBERSHIP_APPROVAL_REQUEST + non_admin_add → joined_non_admin_add", () => {
    const r = extractZapiParticipantEvent(
      base({
        notification: "MEMBERSHIP_APPROVAL_REQUEST",
        requestMethod: "non_admin_add",
        notificationParameters: ["5511999990002"],
      })
    );
    expect(r.status).toBe("accepted");
    if (r.status === "accepted") expect(r.data.eventType).toBe("joined_non_admin_add");
  });

  it("MEMBERSHIP_APPROVAL_REQUEST sem requestMethod válido → unknown", () => {
    const r = extractZapiParticipantEvent(
      base({
        notification: "MEMBERSHIP_APPROVAL_REQUEST",
        notificationParameters: ["5511999990002"],
      })
    );
    expect(r.status).toBe("ignored");
    if (r.status === "ignored") expect(r.reason).toBe("unknown-notification");
  });
});

describe("extractZapiParticipantEvent — targets e actor", () => {
  it("resolve targets do notificationParameters normalizando E.164", () => {
    const r = extractZapiParticipantEvent(
      base({
        notification: "GROUP_PARTICIPANT_ADD",
        notificationParameters: ["5511999990010", "5511999990011"],
      })
    );
    expect(r.status).toBe("accepted");
    if (r.status !== "accepted") return;
    expect(r.data.targets).toHaveLength(2);
    expect(r.data.targets[0]?.phone).toBe("+5511999990010");
    expect(r.data.targets[1]?.phone).toBe("+5511999990011");
  });

  it("actor = executor (participantPhone/Lid)", () => {
    const r = extractZapiParticipantEvent(
      base({
        notification: "GROUP_PARTICIPANT_ADD",
        participantPhone: "5511999990001",
        participantLid: "5511999990001@lid",
        notificationParameters: ["5511999990010"],
      })
    );
    expect(r.status).toBe("accepted");
    if (r.status !== "accepted") return;
    expect(r.data.actor).toEqual({
      phone: "+5511999990001",
      senderExternalId: "5511999990001@lid",
    });
  });

  it("fallback para participantPhone quando notificationParameters ausente", () => {
    const r = extractZapiParticipantEvent(
      base({
        notification: "GROUP_PARTICIPANT_LEAVE",
        participantPhone: "5511999990003",
        notificationParameters: undefined,
      })
    );
    expect(r.status).toBe("accepted");
    if (r.status !== "accepted") return;
    expect(r.data.targets).toHaveLength(1);
    expect(r.data.targets[0]?.phone).toBe("+5511999990003");
  });

  it("descarta quando não há targets e nem participantPhone/Lid", () => {
    const r = extractZapiParticipantEvent(
      base({
        notification: "GROUP_PARTICIPANT_ADD",
        participantPhone: undefined,
        participantLid: undefined,
        notificationParameters: [],
      })
    );
    expect(r.status).toBe("ignored");
    if (r.status === "ignored") expect(r.reason).toBe("missing-targets");
  });
});
