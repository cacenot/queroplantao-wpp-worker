import type { MessageAnalysis } from "../ai/moderator.ts";

export class QpAdminApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "QpAdminApiError";
  }
}

export class QpAdminApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  async submitMessageAnalysis(hash: string, analysis: MessageAnalysis): Promise<void> {
    const response = await this.request(`api/internal/message-analysis/${hash}`, {
      method: "POST",
      body: JSON.stringify(analysis),
    });

    const body = (await response.json()) as { success: boolean };
    if (!body.success) {
      throw new QpAdminApiError(
        `QP Admin API retornou success=false para hash ${hash}`,
        response.status,
        body
      );
    }
  }

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl}/${path}`;

    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("Content-Type", "application/json");

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text();
      }

      throw new QpAdminApiError(
        `QP Admin API retornou erro: ${response.status} ${response.statusText}`,
        response.status,
        body
      );
    }

    return response;
  }
}
