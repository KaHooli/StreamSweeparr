/**
 * Minimal levelled logger for server-side background work.
 *
 * Everything the app logs outside a request (scheduler ticks, the Title ID map
 * refresh, run failures) goes through here so the output has a consistent shape
 * — `[level] [scope] message` — and so `no-console` stays enforced everywhere
 * else rather than being disabled line by line.
 *
 * LOG_LEVEL (debug | info | warn | error) sets the floor; the default is info.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = process.env.LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
  return ORDER[configured ?? "info"] ?? ORDER.info;
}

/* eslint-disable no-console */
const SINKS: Record<LogLevel, (msg: string) => void> = {
  debug: (m) => console.debug(m),
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};
/* eslint-enable no-console */

function emit(level: LogLevel, scope: string, message: string) {
  if (ORDER[level] < threshold()) return;
  SINKS[level](`[${level}] [${scope}] ${message}`);
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * A logger tagged with a subsystem name, e.g. `logger("schedule").info(...)`
 * prints `[info] [schedule] …`.
 */
export function logger(scope: string): Logger {
  return {
    debug: (m) => emit("debug", scope, m),
    info: (m) => emit("info", scope, m),
    warn: (m) => emit("warn", scope, m),
    error: (m) => emit("error", scope, m),
  };
}
