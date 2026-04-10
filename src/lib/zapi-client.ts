import { env } from "../config/env.ts";
import type { DeleteMessagePayload, RemoveParticipantPayload } from "../jobs/types.ts";
import type { ZApiInstance } from "../zapi/types.ts";

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
 * Client HTTP para a Z-API.
 *
 * Centraliza: base URL, construção de endpoint, headers de autenticação
 * e tratamento básico de erro HTTP.
 *
 * A instância é passada no construtor — a responsabilidade de selecioná-la
 * é do instance-selector, não deste client.
 *
 * Cada método público corresponde a um endpoint da Z-API. As actions usam
 * estes métodos e ficam livres para adicionar lógica de negócio ao redor.
 */
export class ZApiClient {
  constructor(private readonly instance: ZApiInstance) {}

  /**
   * Apaga uma mensagem.
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
   * Remove participantes de um grupo.
   * POST /remove-participant
   * Docs: https://developer.z-api.io/group/remove-participant
   */
  async removeParticipant(payload: RemoveParticipantPayload): Promise<{ value: boolean }> {
    const response = await this.request("remove-participant", {
      method: "POST",
      body: JSON.stringify({
        groupId: payload.groupId,
        phones: payload.phones,
      }),
    });

    return response.json() as Promise<{ value: boolean }>;
  }

  // ---------------------------------------------------------------------------
  // Infraestrutura HTTP interna — não exposta às actions
  // ---------------------------------------------------------------------------

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${env.ZAPI_BASE_URL}/instances/${this.instance.instance_id}/token/${this.instance.instance_token}/${path}`;

    const headers = new Headers(options.headers);
    headers.set("Client-Token", this.instance.client_token);

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
