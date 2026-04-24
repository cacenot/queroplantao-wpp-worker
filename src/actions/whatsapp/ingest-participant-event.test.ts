import { describe, expect, it, mock } from "bun:test";
import type { IngestParticipantEventPayload } from "../../jobs/schemas.ts";
import type { GroupParticipantsService } from "../../services/group-participants/index.ts";
import { ingestParticipantEvent } from "./ingest-participant-event.ts";

const PAYLOAD: IngestParticipantEventPayload = {
  providerInstanceId: "11111111-1111-1111-1111-111111111111",
  event: {
    providerKind: "whatsapp_zapi",
    protocol: "whatsapp",
    groupExternalId: "120363@g.us",
    eventType: "joined_add",
    targets: [{ phone: "+5511999990010", senderExternalId: null }],
    actor: { phone: "+5511999990002", senderExternalId: null },
    displayName: "Alice",
    occurredAt: "2026-04-10T00:00:00.000Z",
    sourceWebhookMessageId: "msg-1",
    sourceNotification: "GROUP_PARTICIPANT_ADD",
    rawPayload: { notification: "GROUP_PARTICIPANT_ADD" },
  },
};

describe("ingestParticipantEvent", () => {
  it("delega ao participantsService.applyEvent com o payload do job", async () => {
    const applyEvent = mock(() =>
      Promise.resolve({ upserted: 1, eventsInserted: 1, eventsSkipped: 0 })
    );
    const participantsService = { applyEvent } as unknown as GroupParticipantsService;

    await ingestParticipantEvent(PAYLOAD, { participantsService });

    expect(applyEvent).toHaveBeenCalledTimes(1);
    const args = (applyEvent.mock.calls as unknown as unknown[][])[0]?.[0];
    expect(args).toEqual(PAYLOAD);
  });

  it("propaga erro do service (retry fica a cargo do handler)", async () => {
    const applyEvent = mock(() => Promise.reject(new Error("db down")));
    const participantsService = { applyEvent } as unknown as GroupParticipantsService;

    await expect(ingestParticipantEvent(PAYLOAD, { participantsService })).rejects.toThrow(
      "db down"
    );
  });
});
