import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import type amqplib from "amqplib";
import { z } from "zod";
import { env } from "../config/env.ts";
import { jobSchema } from "../jobs/schemas.ts";
import { logger } from "../lib/logger.ts";

const batchSchema = z.array(jobSchema).min(1).max(1000);

const postTasksHeadersSchema = z.object({
  "x-api-key": z.string().min(1),
});

const postTasksRequestSchema = z.object({
  headers: postTasksHeadersSchema,
  body: batchSchema,
});

export type PostTasksRequest = z.infer<typeof postTasksRequestSchema>;

const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2 MB

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.byteLength !== bufB.byteLength) {
    // Compare against itself to keep constant time, then return false
    cryptoTimingSafeEqual(bufA, bufA);
    return false;
  }

  return cryptoTimingSafeEqual(bufA, bufB);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

type BodyParseResult =
  | { success: true; data: unknown }
  | { success: false; status: 400 | 413; error: "Invalid JSON" | "Payload too large" };

async function parseJsonBodyWithLimit(req: Request): Promise<BodyParseResult> {
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE) {
    return { success: false, status: 413, error: "Payload too large" };
  }

  if (!req.body) {
    return { success: false, status: 400, error: "Invalid JSON" };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_SIZE) {
        try {
          await reader.cancel();
        } catch {
          // noop
        }
        return { success: false, status: 413, error: "Payload too large" };
      }

      chunks.push(value);
    }
  } catch {
    return { success: false, status: 400, error: "Invalid JSON" };
  }

  const bodyText = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");

  try {
    return { success: true, data: JSON.parse(bodyText) };
  } catch {
    return { success: false, status: 400, error: "Invalid JSON" };
  }
}

async function handleTasks(req: Request, channel: amqplib.Channel): Promise<Response> {
  // Validate headers
  const rawHeaders = { "x-api-key": req.headers.get("x-api-key") ?? "" };
  const headersResult = postTasksHeadersSchema.safeParse(rawHeaders);
  if (!headersResult.success) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Auth — timing-safe comparison stays outside zod to prevent timing attacks
  if (!timingSafeEqual(headersResult.data["x-api-key"], env.HTTP_API_KEY)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const parsedBody = await parseJsonBodyWithLimit(req);
  if (!parsedBody.success) {
    return json({ error: parsedBody.error }, parsedBody.status);
  }

  // Validate body
  const result = batchSchema.safeParse(parsedBody.data);
  if (!result.success) {
    return json({ error: "Validation failed", details: result.error.flatten() }, 400);
  }

  const jobs = result.data;

  // Publish each job to AMQP
  for (const job of jobs) {
    const buffer = Buffer.from(JSON.stringify(job));
    const sent = channel.sendToQueue(env.AMQP_QUEUE, buffer, { persistent: true });

    if (!sent) {
      logger.warn({ jobId: job.id }, "AMQP backpressure — sendToQueue retornou false");
    }
  }

  logger.info({ count: jobs.length }, "Batch de jobs publicado via HTTP");

  return json({ accepted: jobs.length }, 202);
}

export function startHttpServer(channel: amqplib.Channel): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: env.HTTP_PORT,

    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        return json({ status: "ok" }, 200);
      }

      if (url.pathname === "/tasks" && req.method === "POST") {
        try {
          return await handleTasks(req, channel);
        } catch (err) {
          logger.error({ err }, "Erro inesperado ao processar POST /tasks");
          return json({ error: "Internal server error" }, 500);
        }
      }

      return json({ error: "Not found" }, 404);
    },
  });

  logger.info({ port: server.port }, "HTTP server iniciado");

  return server;
}
