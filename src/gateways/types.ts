export interface MessagingInstance {
  id: string;
}

export interface MessagingLeasedExecution {
  kind: "leased";
}

export interface MessagingPassthroughExecution {
  kind: "passthrough";
}

export type MessagingProviderExecution = MessagingLeasedExecution | MessagingPassthroughExecution;

export interface MessagingProvider {
  readonly instance: MessagingInstance;
  readonly execution?: MessagingProviderExecution;
}

export type ProviderExecutor<T extends MessagingProvider> = {
  execute<R>(fn: (provider: T) => Promise<R>): Promise<R>;
};
