import { env } from "../../../config/env.ts";
import { toZapiDigits } from "../../../lib/phone.ts";
import type { MessagingProviderExecution } from "../../types.ts";
import type {
  DeleteMessagePayload,
  RemoveParticipantPayload,
  WhatsAppInstance,
  WhatsAppProvider,
} from "../types.ts";
import type { ZApiInstanceConfig } from "./types.ts";

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

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${env.ZAPI_BASE_URL}/instances/${this.config.instance_id}/token/${this.config.instance_token}/${path}`;

    const headers = new Headers(options.headers);
    headers.set("Client-Token", this.config.client_token);

    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(url, { ...options, headers });

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
