/** Minimal structured logger. Swap for pino/etc. later; the interface is the
 * contract the rest of the code depends on. */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, message, ...meta });
  // Logs go to stderr; stdout is reserved for any structured data output.
  process.stderr.write(line + "\n");
}

export const consoleLogger: Logger = {
  info: (message, meta) => emit("info", message, meta),
  warn: (message, meta) => emit("warn", message, meta),
  error: (message, meta) => emit("error", message, meta),
};

/** A logger that discards everything — the default in tests and libraries. */
export const nullLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
