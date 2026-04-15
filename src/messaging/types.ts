export interface MessagingInstance {
  id: string;
}

export interface MessagingProvider {
  readonly instance: MessagingInstance;
}

export type ProviderExecutor<T extends MessagingProvider> = {
  execute<R>(fn: (provider: T) => Promise<R>): Promise<R>;
};
