import pino from "pino";

export type LogBindings = Record<string, unknown>;

export function createLogger(name: string, bindings?: LogBindings) {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: ["password", "req.headers.authorization", "gdmsPassword"],
      censor: "[REDACTED]",
    },
    ...(bindings ? { base: bindings } : {}),
  });
}
