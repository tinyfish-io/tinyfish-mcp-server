import { describe, expect, it } from "vitest";
import {
  API_KEY_GUIDANCE,
  ConfigError,
  DEFAULT_PORT,
  DEFAULT_UPSTREAM_URL,
  parseConfig,
} from "../src/config.js";

const validEnv = { TINYFISH_API_KEY: "sk-test-123" };

describe("parseConfig", () => {
  it("parses a fully specified env", () => {
    const config = parseConfig({
      TINYFISH_API_KEY: "sk-test-123",
      PORT: "8080",
      TINYFISH_UPSTREAM_URL: "https://example.com/mcp",
    });
    expect(config).toEqual({
      apiKey: "sk-test-123",
      port: 8080,
      upstreamUrl: "https://example.com/mcp",
    });
  });

  it("applies defaults for PORT and upstream URL", () => {
    const config = parseConfig(validEnv);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.port).toBe(3711);
    expect(config.upstreamUrl).toBe(DEFAULT_UPSTREAM_URL);
    expect(config.upstreamUrl).toBe("https://agent.tinyfish.ai/mcp");
  });

  it("ignores unrelated env vars", () => {
    const config = parseConfig({ ...validEnv, HOME: "/home/user", PATH: "/usr/bin" });
    expect(config.apiKey).toBe("sk-test-123");
  });

  describe("TINYFISH_API_KEY", () => {
    it("rejects a missing key with the actionable guidance", () => {
      expect(() => parseConfig({})).toThrowError(ConfigError);
      expect(() => parseConfig({})).toThrowError(API_KEY_GUIDANCE);
      expect(() => parseConfig({})).toThrowError(
        "Set TINYFISH_API_KEY — get a key at https://agent.tinyfish.ai"
      );
    });

    it("rejects an empty key with the same guidance", () => {
      expect(() => parseConfig({ TINYFISH_API_KEY: "" })).toThrowError(API_KEY_GUIDANCE);
    });

    it("never includes the key value in error messages", () => {
      try {
        parseConfig({ TINYFISH_API_KEY: "sk-super-secret", PORT: "not-a-port" });
        expect.unreachable("parseConfig should have thrown");
      } catch (err) {
        expect((err as Error).message).not.toContain("sk-super-secret");
      }
    });
  });

  describe("PORT", () => {
    it.each(["0", "65536", "-1", "abc", "37.11", "3711abc", ""])(
      "rejects invalid PORT %j",
      (port) => {
        expect(() => parseConfig({ ...validEnv, PORT: port })).toThrowError(ConfigError);
        expect(() => parseConfig({ ...validEnv, PORT: port })).toThrowError(
          /must be an integer between 1 and 65535/
        );
      }
    );

    it.each([
      ["1", 1],
      ["65535", 65535],
      ["3711", 3711],
    ])("accepts boundary/typical PORT %j", (raw, expected) => {
      expect(parseConfig({ ...validEnv, PORT: raw }).port).toBe(expected);
    });
  });

  describe("TINYFISH_UPSTREAM_URL", () => {
    it("rejects a non-URL value", () => {
      expect(() =>
        parseConfig({ ...validEnv, TINYFISH_UPSTREAM_URL: "not a url" })
      ).toThrowError(/must be an absolute URL/);
    });

    it("rejects http for non-loopback hosts", () => {
      expect(() =>
        parseConfig({ ...validEnv, TINYFISH_UPSTREAM_URL: "http://example.com/mcp" })
      ).toThrowError(ConfigError);
      expect(() =>
        parseConfig({ ...validEnv, TINYFISH_UPSTREAM_URL: "http://192.168.1.10:3000/mcp" })
      ).toThrowError(/scheme must be https/);
    });

    it("rejects non-http(s) schemes", () => {
      expect(() =>
        parseConfig({ ...validEnv, TINYFISH_UPSTREAM_URL: "ftp://127.0.0.1/mcp" })
      ).toThrowError(ConfigError);
    });

    it.each([
      "http://127.0.0.1:9999/mcp",
      "http://localhost:9999/mcp",
      "http://localhost/mcp",
    ])("accepts http loopback URL %s", (url) => {
      expect(parseConfig({ ...validEnv, TINYFISH_UPSTREAM_URL: url }).upstreamUrl).toBe(url);
    });

    it("accepts https for any host", () => {
      expect(
        parseConfig({ ...validEnv, TINYFISH_UPSTREAM_URL: "https://sandbox.tinyfish.ai/mcp" })
          .upstreamUrl
      ).toBe("https://sandbox.tinyfish.ai/mcp");
    });
  });
});
