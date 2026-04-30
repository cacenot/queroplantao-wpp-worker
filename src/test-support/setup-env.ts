// Preload de testes (bunfig.toml [test].preload).
//
// Bun carrega .env automaticamente antes do preload. O env real do projeto
// pode ter HTTP_API_KEY/secrets de produção, e nossos testes assumem valores
// canônicos. Sobrescrevemos os secrets *unconditionally* aqui e disparamos
// parseEnv() para congelar `env` com esses valores antes de qualquer test
// file importar — isso elimina ordering bugs cross-file.

// Fallbacks só aplicados se a env já não estiver setada (.env / shell vencem).
// Útil pra rodar testes sem .env.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.AMQP_URL ??= "amqp://localhost";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.HTTP_PORT ??= "0";
process.env.ZAPI_BASE_URL ??= "https://test.example.com";
process.env.ZAPI_CLIENT_TOKEN ??= "test-client-token";
process.env.QP_ADMIN_API_URL ??= "https://admin.example.com";
process.env.QP_ADMIN_API_TOKEN ??= "admin-token";
process.env.QP_ADMIN_API_SERVICE_TOKEN ??= "service-token";

// Override unconditional: testes batem o header `x-api-key` contra esse valor
// e o webhook contra esse secret. Tem que ser determinístico, independente do .env.
process.env.HTTP_API_KEY = "test-api-key-secret";
process.env.ZAPI_RECEIVED_WEBHOOK_SECRET = "test-webhook-secret";

// Força o parse do env (singleton) agora, antes de qualquer test file. Sem isso
// o primeiro arquivo que importar `config/env.ts` (transitivamente) congela
// `env` com o que estiver em process.env naquele momento — fonte de race entre
// testes que setam `process.env.HTTP_API_KEY = ...` antes de seus dynamic imports.
await import("../config/env.ts");

export {};
