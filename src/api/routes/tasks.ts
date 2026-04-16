import { Elysia } from "elysia";
import type { Publisher } from "rabbitmq-client";
import { z } from "zod";
import { env } from "../../config/env.ts";
import { jobSchema } from "../../jobs/schemas.ts";
import { logger } from "../../lib/logger.ts";
import { authPlugin } from "../plugins/auth.ts";

const batchSchema = z.array(jobSchema).min(1).max(1000);

const MAX_BODY_SIZE = 2 * 1024 * 1024;

type BodyParseResult =
  | { success: true; data: unknown }
  | { success: false; status: 400 | 413; error: "Invalid JSON" | "Payload too large" };

async function parseJsonBodyWithLimit(request: Request): Promise<BodyParseResult> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE) {
    return { success: false, status: 413, error: "Payload too large" };
  }

  if (!request.body) {
    return { success: false, status: 400, error: "Invalid JSON" };
  }

  const reader = request.body.getReader();
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

export function tasksRoutes(publisher: Publisher) {
  return new Elysia({ tags: ["tasks"] })
    .use(authPlugin)
    .post(
      "/tasks",
      async ({ request, set }) => {
        const parsedBody = await parseJsonBodyWithLimit(request);
        if (!parsedBody.success) {
          set.status = parsedBody.status;
          return { error: parsedBody.error };
        }

        const result = batchSchema.safeParse(parsedBody.data);
        if (!result.success) {
          set.status = 400;
          return { error: "Validation failed", details: result.error.flatten() };
        }

        const jobs = result.data;

        for (const job of jobs) {
          await publisher.send({ routingKey: env.AMQP_QUEUE, durable: true }, job);
        }

        logger.info({ count: jobs.length }, "Batch de jobs publicado via HTTP");

        set.status = 202;
        return { accepted: jobs.length };
      },
      {
        parse: "none",
        detail: { summary: "Publica um batch de jobs no AMQP" },
      }
    );
}
