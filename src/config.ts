import { z } from "zod";

export const DEFAULT_PORT = 3711;
export const DEFAULT_UPSTREAM_URL = "https://agent.tinyfish.ai/mcp";

export const API_KEY_GUIDANCE = "Set TINYFISH_API_KEY — get a key at https://agent.tinyfish.ai";

export interface Config {
  /** Never log this field. */
  apiKey: string;
  port: number;
  upstreamUrl: string;
}

/** Thrown by parseConfig; `message` is the actionable stderr line(s) for the user. */
export class ConfigError extends Error {}

const envSchema = z.object({
  TINYFISH_API_KEY: z
    .string({ error: API_KEY_GUIDANCE })
    .min(1, { error: API_KEY_GUIDANCE }),
  PORT: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return DEFAULT_PORT;
      const port = /^\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        ctx.addIssue({
          code: "custom",
          message: `Invalid PORT "${value}" — must be an integer between 1 and 65535`,
        });
        return z.NEVER;
      }
      return port;
    }),
  TINYFISH_UPSTREAM_URL: z
    .string()
    .optional()
    .transform((value, ctx) => {
      const raw = value ?? DEFAULT_UPSTREAM_URL;
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: `Invalid TINYFISH_UPSTREAM_URL "${raw}" — must be an absolute URL`,
        });
        return z.NEVER;
      }
      const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
        ctx.addIssue({
          code: "custom",
          message:
            `Invalid TINYFISH_UPSTREAM_URL "${raw}" — scheme must be https ` +
            `(http is allowed only for 127.0.0.1/localhost)`,
        });
        return z.NEVER;
      }
      return raw;
    }),
});

/**
 * Pure env → Config parser. Throws ConfigError with an actionable message on
 * invalid input; performs no I/O and never touches process state.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => issue.message).join("\n"));
  }
  return {
    apiKey: parsed.data.TINYFISH_API_KEY,
    port: parsed.data.PORT,
    upstreamUrl: parsed.data.TINYFISH_UPSTREAM_URL,
  };
}
