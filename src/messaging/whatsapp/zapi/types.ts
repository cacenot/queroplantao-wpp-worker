import type { MessagingProviderExecution } from "../../types.ts";

export interface ZApiInstanceRecord {
  instance_id: string;
  instance_token: string;
}

export interface ZApiInstanceConfig extends ZApiInstanceRecord {
  client_token: string;
  execution?: MessagingProviderExecution;
}
