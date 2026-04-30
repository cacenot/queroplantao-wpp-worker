import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiDeps } from "../api/deps.ts";

// env.ts valida process.env ao ser importado — setar fallbacks antes dos dynamic imports
for (const [k, v] of Object.entries({
  DATABASE_URL: "postgresql://stub",
  AMQP_URL: "amqp://stub",
  REDIS_URL: "redis://stub",
  HTTP_API_KEY: "stub",
  ZAPI_BASE_URL: "https://stub",
  ZAPI_CLIENT_TOKEN: "stub",
  ZAPI_RECEIVED_WEBHOOK_SECRET: "stub",
  QP_ADMIN_API_URL: "https://stub",
  QP_ADMIN_API_TOKEN: "stub",
  QP_ADMIN_API_SERVICE_TOKEN: "stub",
})) {
  process.env[k] ??= v;
}

const { swagger } = await import("@elysiajs/swagger");
const { Elysia } = await import("elysia");
const { composeApp } = await import("../api/app.ts");
const { openApiToBruno } = await import("@usebruno/converters");

const OUTPUT_DIR = join(import.meta.dir, "../../docs/bruno");

// ─── Tipos da coleção Bruno ───────────────────────────────────────────────────

type BrunoApiKey = { key: string; value: string; placement: string };
type BrunoAuth = { mode: string; apikey?: BrunoApiKey };
type BrunoHeader = { name: string; value?: string; enabled?: boolean };
type BrunoParam = { type: "query" | "path"; name: string; value?: string; enabled?: boolean };
type BrunoBody = { mode: string; json?: string };
type BrunoRequest = {
  url: string;
  method: string;
  auth: BrunoAuth;
  headers: BrunoHeader[];
  params: BrunoParam[];
  body: BrunoBody;
};
type BrunoItem = {
  uid: string;
  name: string;
  type: "folder" | "http-request";
  items?: BrunoItem[];
  request: BrunoRequest;
};
type BrunoCollection = {
  name: string;
  items: BrunoItem[];
  root?: { request?: { auth?: BrunoAuth } };
};

// ─── Extrair spec OpenAPI ─────────────────────────────────────────────────────

// Instancia o app só para extração do spec OpenAPI — handlers nunca são chamados
const app = new Elysia()
  .use(
    swagger({
      path: "/docs",
      documentation: {
        info: {
          title: "Messaging API",
          version: "0.1.0",
          description:
            "API interna do messaging-api. Gerencia ingestão de tasks e registry de provider instances.",
        },
        tags: [
          { name: "tasks", description: "Publicação de jobs no AMQP" },
          { name: "providers", description: "Provider instances (CRUD)" },
          { name: "webhooks", description: "Webhooks de providers externos" },
          { name: "groups", description: "Relatórios de grupos por instância" },
          { name: "moderation", description: "Listas de blacklist e bypass por telefone" },
        ],
        components: {
          securitySchemes: {
            ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" },
          },
        },
        security: [{ ApiKeyAuth: [] }],
      },
    })
  )
  .use(composeApp({} as unknown as ApiDeps, { secret: "", enabled: false }));

const res = await app.handle(new Request("http://localhost/docs/json"));
const spec = await res.json();
const collection = openApiToBruno(spec) as BrunoCollection;

// ─── Serializer .bru ──────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
}

function requestToBru(item: BrunoItem, seq: number): string {
  const method = item.request.method.toLowerCase();
  const bodyMode = item.request.body?.mode ?? "none";
  const authMode = item.request.auth?.mode ?? "inherit";

  const out: string[] = [];

  out.push("meta {", `  name: ${item.name}`, "  type: http", `  seq: ${seq}`, "}", "");

  out.push(
    `${method} {`,
    `  url: ${item.request.url}`,
    `  body: ${bodyMode}`,
    `  auth: ${authMode}`,
    "}",
    ""
  );

  // headers — pula x-api-key se auth:apikey estiver presente (evita duplicata)
  const apiKeyName =
    item.request.auth?.apikey?.placement === "header"
      ? item.request.auth.apikey.key.toLowerCase()
      : null;
  const headers = (item.request.headers ?? []).filter(
    (h) => h.enabled !== false && h.name && h.name.toLowerCase() !== apiKeyName
  );
  if (headers.length) {
    out.push("headers {");
    for (const h of headers) out.push(`  ${h.name}: ${h.value ?? ""}`);
    out.push("}", "");
  }

  // query params
  const queryParams = (item.request.params ?? []).filter((p) => p.type === "query");
  if (queryParams.length) {
    out.push("params:query {");
    for (const p of queryParams) {
      const disabled = p.enabled === false ? "~" : "";
      out.push(`  ${disabled}${p.name}: ${p.value ?? ""}`);
    }
    out.push("}", "");
  }

  // path params
  const pathParams = (item.request.params ?? []).filter((p) => p.type === "path");
  if (pathParams.length) {
    out.push("params:path {");
    for (const p of pathParams) out.push(`  ${p.name}: ${p.value ?? ""}`);
    out.push("}", "");
  }

  // body json
  if (bodyMode === "json" && item.request.body?.json) {
    out.push("body:json {", item.request.body.json, "}", "");
  }

  // apikey auth — força {{apiKey}} como valor para consistência com o environment
  if (authMode === "apikey" && item.request.auth?.apikey) {
    const ak = item.request.auth.apikey;
    out.push(
      "auth:apikey {",
      `  key: ${ak.key}`,
      "  value: {{apiKey}}",
      `  placement: ${ak.placement}`,
      "}",
      ""
    );
  }

  return out.join("\n");
}

// ─── Escrever arquivos ────────────────────────────────────────────────────────

if (existsSync(OUTPUT_DIR)) rmSync(OUTPUT_DIR, { recursive: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

writeFileSync(
  join(OUTPUT_DIR, "bruno.json"),
  JSON.stringify({ version: "1", name: collection.name, type: "collection", ignore: [] }, null, 2) +
    "\n"
);

// collection.bru — auth de nível de coleção (herdado por todos os requests com auth:inherit)
const rootAuth = collection.root?.request?.auth;
if (rootAuth?.mode === "apikey" && rootAuth.apikey) {
  const ak = rootAuth.apikey;
  writeFileSync(
    join(OUTPUT_DIR, "collection.bru"),
    [
      "meta {",
      `  name: ${collection.name}`,
      "}",
      "",
      "auth {",
      `  mode: ${rootAuth.mode}`,
      "}",
      "",
      "auth:apikey {",
      `  key: ${ak.key}`,
      `  value: ${ak.value}`,
      `  placement: ${ak.placement}`,
      "}",
      "",
    ].join("\n")
  );
}

mkdirSync(join(OUTPUT_DIR, "environments"), { recursive: true });
writeFileSync(
  join(OUTPUT_DIR, "environments", "local.bru"),
  ["vars {", "  baseUrl: http://localhost:3000", "  apiKey: your-api-key-here", "}", ""].join("\n")
);

let totalRequests = 0;

function writeItems(items: BrunoItem[], dir: string): void {
  items.forEach((item, i) => {
    if (item.type === "folder") {
      const folderDir = join(dir, slugify(item.name));
      mkdirSync(folderDir, { recursive: true });
      if (item.items?.length) writeItems(item.items, folderDir);
    } else if (item.type === "http-request") {
      writeFileSync(join(dir, `${slugify(item.name)}.bru`), requestToBru(item, i + 1));
      totalRequests++;
    }
  });
}

writeItems(collection.items, OUTPUT_DIR);

console.log(`Bruno collection gerada em ${OUTPUT_DIR}`);
console.log(`${collection.items.length} pastas, ${totalRequests} requests`);
