import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

export function createLogger(name: string) {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: pino.stdSerializers.errWithCause,
    },
    ...(!isProd && {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      },
    }),
  });
}

// Singleton lido por todos os módulos compartilhados.
// SERVICE_NAME é definida pelo script de start de cada entry point.
export const logger = createLogger(process.env.SERVICE_NAME ?? "messaging-worker");
