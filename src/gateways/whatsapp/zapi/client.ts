import { env } from "../../../config/env.ts";
import { toZapiDigits } from "../../../lib/phone.ts";
import {
  type ZApiDeviceSnapshot,
  type ZApiMeSnapshot,
  type ZApiStatusSnapshot,
  zapiDeviceSnapshotSchema,
  zapiMeSnapshotSchema,
  zapiStatusSnapshotSchema,
} from "../../../services/provider-registry/schemas.ts";
import type { MessagingProviderExecution } from "../../types.ts";
import type {
  AcceptGroupInviteResult,
  DeleteMessagePayload,
  RemoveParticipantPayload,
  SendButtonsPayload,
  SendImagePayload,
  SendLinkPayload,
  SendLocationPayload,
  SendResult,
  SendTarget,
  SendTextPayload,
  SendVideoPayload,
  WhatsAppInstance,
  WhatsAppProvider,
} from "../types.ts";
import {
  type ZApiGroupMetadataLight,
  zapiGroupMetadataLightSchema,
} from "./group-metadata-schema.ts";
import type { ZApiInstanceConfig } from "./types.ts";

export interface ZApiRefreshSnapshot {
  me: ZApiMeSnapshot;
  device: ZApiDeviceSnapshot;
  status: ZApiStatusSnapshot;
}

export class ZApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "ZApiError";
  }
}

export class ZApiTimeoutError extends ZApiError {
  constructor(url: string, timeoutMs: number) {
    super(`Z-API timeout após ${timeoutMs}ms: ${url}`, 0, null);
    this.name = "ZApiTimeoutError";
  }
}

/**
 * Implementação Z-API do WhatsAppProvider.
 *
 * Centraliza: base URL, construção de endpoint, headers de autenticação
 * e tratamento básico de erro HTTP. Uma instância por número WhatsApp —
 * a seleção fica a cargo do ProviderGateway.
 */
export class ZApiClient implements WhatsAppProvider {
  readonly instance: WhatsAppInstance;
  readonly execution?: MessagingProviderExecution;

  constructor(private readonly config: ZApiInstanceConfig) {
    this.instance = { id: config.providerInstanceId };
    this.execution = config.execution;
  }

  /**
   * DELETE /messages?messageId=&phone=&owner=
   * Docs: https://developer.z-api.io/message/delete-message
   */
  async deleteMessage(payload: DeleteMessagePayload): Promise<void> {
    const params = new URLSearchParams({
      messageId: payload.messageId,
      phone: payload.phone,
      owner: String(payload.owner),
    });

    await this.request(`messages?${params.toString()}`, { method: "DELETE" });
  }

  /**
   * GET /me — dados da conta WhatsApp associada à instância.
   * Docs: https://developer.z-api.io/instance/me
   */
  async fetchMe(): Promise<ZApiMeSnapshot> {
    const response = await this.request("me", { method: "GET" });
    const body = await response.json();
    return zapiMeSnapshotSchema.parse(body);
  }

  /**
   * GET /device — dados do dispositivo conectado.
   * Docs: https://developer.z-api.io/instance/device
   */
  async fetchDevice(): Promise<ZApiDeviceSnapshot> {
    const response = await this.request("device", { method: "GET" });
    const body = await response.json();
    return zapiDeviceSnapshotSchema.parse(body);
  }

  /**
   * GET /status — estado de conexão.
   * Docs: https://developer.z-api.io/instance/status
   */
  async fetchStatus(): Promise<ZApiStatusSnapshot> {
    const response = await this.request("status", { method: "GET" });
    const body = await response.json();
    return zapiStatusSnapshotSchema.parse(body);
  }

  /**
   * Chama /me, /device e /status em paralelo. Uma falha em qualquer endpoint
   * propaga o erro — o caller decide rollback (create/patch) ou ejeção
   * (refresh manual).
   */
  async refreshSnapshot(): Promise<ZApiRefreshSnapshot> {
    const [me, device, status] = await Promise.all([
      this.fetchMe(),
      this.fetchDevice(),
      this.fetchStatus(),
    ]);
    return { me, device, status };
  }

  /**
   * GET /phone-exists/{phone}
   * Docs: https://developer.z-api.io/contacts/get-iswhatsapp
   * Aceita múltiplos formatos; `link` contém o número canonical que o WA usa.
   */
  async phoneExists(phone: string): Promise<{ exists: boolean; link: string | null }> {
    const digits = toZapiDigits(phone) ?? phone.replace(/\D/g, "");
    const response = await this.request(`phone-exists/${digits}`, { method: "GET" });
    const body = (await response.json()) as { exists: boolean; link?: string };
    return { exists: body.exists === true, link: body.link ?? null };
  }

  /**
   * POST /remove-participant
   * Docs: https://developer.z-api.io/group/remove-participant
   */
  async removeParticipant(payload: RemoveParticipantPayload): Promise<{ value: boolean }> {
    const response = await this.request("remove-participant", {
      method: "POST",
      body: JSON.stringify({
        groupId: payload.groupId,
        phones: payload.phones.map((p) => toZapiDigits(p) ?? p),
      }),
    });

    return response.json() as Promise<{ value: boolean }>;
  }

  /**
   * GET /group-metadata-light/{groupId}
   * Docs: https://developer.z-api.io/group/light-group-metadata
   *
   * Variante "light" — não traz fotos nem descrição completa, mas inclui a lista
   * de participantes com flags de admin/superAdmin. Usado pelo sync esporádico.
   */
  async fetchGroupMetadataLight(groupId: string): Promise<ZApiGroupMetadataLight> {
    const response = await this.request(`group-metadata-light/${encodeURIComponent(groupId)}`, {
      method: "GET",
    });
    const body = await response.json();
    return zapiGroupMetadataLightSchema.parse(body);
  }

  /**
   * POST /accept-group-invite
   * Docs: https://developer.z-api.io/group/accept-group-invite
   *
   * Body: `{ inviteCode }` — só o código (sem o prefixo `chat.whatsapp.com/`).
   * Resposta sob falha de negócio: `{ success: false, ... }`. O caller decide
   * se classifica como retryable; aqui só repassamos o flag.
   */
  async acceptGroupInvite(inviteCode: string): Promise<AcceptGroupInviteResult> {
    const response = await this.request("accept-group-invite", {
      method: "POST",
      body: JSON.stringify({ inviteCode }),
    });
    const raw = (await response.json()) as { success?: boolean };
    return { success: raw?.success === true, raw };
  }

  /**
   * POST /send-text
   * Docs: https://developer.z-api.io/message/send-message-text
   */
  async sendText(payload: SendTextPayload): Promise<SendResult> {
    return this.postSend("send-text", {
      phone: targetToPhoneField(payload.target),
      message: payload.message,
    });
  }

  /**
   * POST /send-image
   * Docs: https://developer.z-api.io/message/send-image
   * `image` precisa ser URL pública (Z-API recusa silenciosamente URLs privadas).
   */
  async sendImage(payload: SendImagePayload): Promise<SendResult> {
    return this.postSend("send-image", {
      phone: targetToPhoneField(payload.target),
      image: payload.imageUrl,
      caption: payload.caption,
    });
  }

  /**
   * POST /send-video
   * Docs: https://developer.z-api.io/message/send-video
   */
  async sendVideo(payload: SendVideoPayload): Promise<SendResult> {
    return this.postSend("send-video", {
      phone: targetToPhoneField(payload.target),
      video: payload.videoUrl,
      caption: payload.caption,
    });
  }

  /**
   * POST /send-link
   * Docs: https://developer.z-api.io/message/send-link
   */
  async sendLink(payload: SendLinkPayload): Promise<SendResult> {
    return this.postSend("send-link", {
      phone: targetToPhoneField(payload.target),
      message: payload.message,
      linkUrl: payload.linkUrl,
      title: payload.title,
      linkDescription: payload.linkDescription,
      image: payload.image,
    });
  }

  /**
   * POST /send-location
   * Docs: https://developer.z-api.io/message/send-location
   */
  async sendLocation(payload: SendLocationPayload): Promise<SendResult> {
    return this.postSend("send-location", {
      phone: targetToPhoneField(payload.target),
      latitude: payload.latitude,
      longitude: payload.longitude,
      title: payload.title,
      address: payload.address,
    });
  }

  /**
   * POST /send-button-actions
   * Docs: https://developer.z-api.io/message/send-buttons-with-actions
   *
   * Limite de 3 botões pelo WhatsApp; usamos `type: "REPLY"` (botões simples
   * que respondem com o `id` quando clicados). Para tipos URL/CALL/COPY, o
   * caller pode estender a interface.
   */
  async sendButtons(payload: SendButtonsPayload): Promise<SendResult> {
    return this.postSend("send-button-actions", {
      phone: targetToPhoneField(payload.target),
      message: payload.message,
      title: payload.title,
      footer: payload.footer,
      buttonActions: payload.buttons.map((btn) => ({
        id: btn.id,
        type: "REPLY",
        label: btn.label,
      })),
    });
  }

  /**
   * POST helper para endpoints de envio. Remove campos undefined do body para
   * não confundir o validador da Z-API e normaliza a resposta.
   */
  private async postSend(path: string, body: Record<string, unknown>): Promise<SendResult> {
    const cleaned = stripUndefined(body);
    const response = await this.request(path, {
      method: "POST",
      body: JSON.stringify(cleaned),
    });
    const raw = (await response.json()) as Record<string, unknown>;
    const externalMessageId = extractZapiMessageId(raw);
    if (!externalMessageId) {
      throw new ZApiError(`Z-API ${path}: resposta sem messageId/zaapId/id`, response.status, raw);
    }
    return { externalMessageId, raw };
  }

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${env.ZAPI_BASE_URL}/instances/${this.config.instance_id}/token/${this.config.instance_token}/${path}`;

    const headers = new Headers(options.headers);
    headers.set("Client-Token", this.config.client_token);

    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const timeoutSignal = AbortSignal.timeout(env.ZAPI_REQUEST_TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(url, { ...options, headers, signal });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new ZApiTimeoutError(url, env.ZAPI_REQUEST_TIMEOUT_MS);
      }
      throw err;
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text();
      }

      throw new ZApiError(
        `Z-API retornou erro: ${response.status} ${response.statusText}`,
        response.status,
        body
      );
    }

    return response;
  }
}

// Z-API aceita o `phone` polimórfico: phone digits para contato, groupId para
// grupo. Conversão E.164 → digits acontece só aqui (regra do CLAUDE.md).
function targetToPhoneField(target: SendTarget): string {
  if (target.kind === "contact") {
    return toZapiDigits(target.externalId) ?? target.externalId.replace(/\D/g, "");
  }
  return target.externalId;
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Z-API tem retornos heterogêneos por endpoint — `messageId` é o mais comum,
// `zaapId` aparece em alguns sends, `id` em outros. Tentamos os 3 nessa ordem.
function extractZapiMessageId(raw: Record<string, unknown>): string | null {
  for (const key of ["messageId", "zaapId", "id"]) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
