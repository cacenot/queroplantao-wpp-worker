import pino from "pino";

export const logger = pino({
  name: "wpp-worker",
  level: process.env.LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
});
