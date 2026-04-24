import { and, eq, isNotNull, ne, or } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  type GroupParticipantEvent,
  groupParticipantEvents,
  type NewGroupParticipantEvent,
} from "../schema/group-participant-events.ts";
import {
  type GroupParticipant,
  groupParticipants,
  type NewGroupParticipant,
} from "../schema/group-participants.ts";
import type {
  messagingProtocolEnum,
  messagingProviderKindEnum,
} from "../schema/provider-registry.ts";

type Protocol = (typeof messagingProtocolEnum.enumValues)[number];
type ProviderKind = (typeof messagingProviderKindEnum.enumValues)[number];

export type ParticipantIdentifier = {
  phone: string | null;
  senderExternalId: string | null;
};

export class GroupParticipantsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Acha participante existente por LID (preferido) ou phone. Match por qualquer um
   * dos dois: um evento pode chegar só com phone, outro só com LID, e o mesmo
   * participante fica consolidado via UPDATE quando ambos aparecerem.
   */
  async findByIdentifier(
    groupExternalId: string,
    protocol: Protocol,
    identifier: ParticipantIdentifier
  ): Promise<GroupParticipant | null> {
    if (identifier.senderExternalId) {
      const [byLid] = await this.db
        .select()
        .from(groupParticipants)
        .where(
          and(
            eq(groupParticipants.groupExternalId, groupExternalId),
            eq(groupParticipants.protocol, protocol),
            eq(groupParticipants.senderExternalId, identifier.senderExternalId)
          )
        )
        .limit(1);
      if (byLid) return byLid;
    }
    if (identifier.phone) {
      const [byPhone] = await this.db
        .select()
        .from(groupParticipants)
        .where(
          and(
            eq(groupParticipants.groupExternalId, groupExternalId),
            eq(groupParticipants.protocol, protocol),
            eq(groupParticipants.phone, identifier.phone)
          )
        )
        .limit(1);
      if (byPhone) return byPhone;
    }
    return null;
  }

  /**
   * Acha todas as linhas que batem por phone OR LID no grupo. Usado pra detectar
   * split de identidade (ex.: row A por phone + row B por LID criados por eventos
   * diferentes). Retorna até 2 rows — se achar mais, ignora extras.
   */
  async findAllByIdentifier(
    groupExternalId: string,
    protocol: Protocol,
    identifier: ParticipantIdentifier
  ): Promise<GroupParticipant[]> {
    if (!identifier.phone && !identifier.senderExternalId) return [];

    const conditions = [];
    if (identifier.phone) conditions.push(eq(groupParticipants.phone, identifier.phone));
    if (identifier.senderExternalId) {
      conditions.push(eq(groupParticipants.senderExternalId, identifier.senderExternalId));
    }

    const rows = await this.db
      .select()
      .from(groupParticipants)
      .where(
        and(
          eq(groupParticipants.groupExternalId, groupExternalId),
          eq(groupParticipants.protocol, protocol),
          or(...conditions)
        )
      )
      .limit(2);
    return rows;
  }

  /**
   * Verifica se já existe OUTRO row (id distinto) no grupo com o mesmo phone
   * ou LID. Usado pelo service pra evitar UPDATE que violaria unique parcial
   * quando a identidade ficou split (A só phone, B só LID) e um evento novo
   * tenta preencher o que falta em A com o dado que já está em B.
   */
  async hasOtherRowWithIdentifier(
    groupExternalId: string,
    protocol: Protocol,
    excludeId: string,
    identifier: { phone?: string | null; senderExternalId?: string | null }
  ): Promise<boolean> {
    const conditions = [];
    if (identifier.phone) {
      conditions.push(
        and(isNotNull(groupParticipants.phone), eq(groupParticipants.phone, identifier.phone))
      );
    }
    if (identifier.senderExternalId) {
      conditions.push(
        and(
          isNotNull(groupParticipants.senderExternalId),
          eq(groupParticipants.senderExternalId, identifier.senderExternalId)
        )
      );
    }
    if (conditions.length === 0) return false;

    const [row] = await this.db
      .select({ id: groupParticipants.id })
      .from(groupParticipants)
      .where(
        and(
          eq(groupParticipants.groupExternalId, groupExternalId),
          eq(groupParticipants.protocol, protocol),
          ne(groupParticipants.id, excludeId),
          or(...conditions)
        )
      )
      .limit(1);
    return Boolean(row);
  }

  /**
   * INSERT com `onConflictDoNothing` nos unique indexes parciais (phone/LID).
   * Retorna a linha inserida ou null se outro processo inseriu antes (race
   * sob prefetch>1). Service faz re-find nesse caso.
   */
  async insert(row: NewGroupParticipant): Promise<GroupParticipant | null> {
    const [inserted] = await this.db
      .insert(groupParticipants)
      .values(row)
      .onConflictDoNothing()
      .returning();
    return inserted ?? null;
  }

  async update(id: string, patch: Partial<NewGroupParticipant>): Promise<GroupParticipant> {
    const [updated] = await this.db
      .update(groupParticipants)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(groupParticipants.id, id))
      .returning();
    if (!updated) throw new Error(`UPDATE group_participants ${id} não retornou linha`);
    return updated;
  }

  /**
   * INSERT idempotente via UNIQUE(source_webhook_message_id, event_type,
   * target_phone, target_sender_external_id). Retorna a linha inserida ou null
   * se já existia (conflito silencioso).
   */
  async insertEvent(row: NewGroupParticipantEvent): Promise<GroupParticipantEvent | null> {
    const [inserted] = await this.db
      .insert(groupParticipantEvents)
      .values(row)
      .onConflictDoNothing()
      .returning();
    return inserted ?? null;
  }
}

export type ProtocolType = Protocol;
export type ProviderKindType = ProviderKind;
