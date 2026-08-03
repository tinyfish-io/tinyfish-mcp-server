/**
 * Minimal leveled logger. Writes to stderr only — stdout stays clean for a
 * future stdio transport. Callers must never pass the API key into a message.
 */

export type LogLevel = "info" | "warn" | "error";

function write(level: LogLevel, message: string): void {
  process.stderr.write(`tinyfish-mcp [${level}] ${message}\n`);
}

export const log = {
  info(message: string): void {
    write("info", message);
  },
  warn(message: string): void {
    write("warn", message);
  },
  error(message: string): void {
    write("error", message);
  },
};
