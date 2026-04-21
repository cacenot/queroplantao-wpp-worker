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
  DeleteMessagePayload,
  RemoveParticipantPayload,
  WhatsAppInstance,
  WhatsAppProvider,
} from "../types.ts";
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
