import { describe, expect, it } from "vitest";
import { checkOrigin } from "../src/http/origin.js";

describe("checkOrigin", () => {
  const allowed: Array<string | undefined> = [
    undefined, // non-browser clients send no Origin
    "http://127.0.0.1:3711",
    "http://localhost:3711",
    // any loopback port variant is fine (phase doc)
    "http://127.0.0.1:8080",
    "http://localhost:1234",
    "http://localhost", // default port
    "http://127.0.0.1",
    // https loopback (e.g. a locally-served https dev page)
    "https://127.0.0.1:3711",
    "https://localhost:3711",
  ];

  const denied: string[] = [
    "https://evil.example.com",
    "http://evil.example.com:3711",
    "https://agent.tinyfish.ai",
    "http://127.0.0.2:3711", // other loopback addresses are not allowlisted
    "http://127.0.0.1.evil.com:3711", // prefix-spoofed hostname
    "http://localhost.evil.com:3711",
    "http://[::1]:3711", // IPv6 loopback — server binds IPv4 loopback only
    "null", // sandboxed iframe / file:// pages
    "file:///etc/passwd",
    "chrome-extension://abcdefghijklmnop",
    "ws://127.0.0.1:3711", // non-http(s) scheme
    "not a url",
    "",
  ];

  for (const origin of allowed) {
    it(`allows ${origin === undefined ? "<absent Origin>" : `"${origin}"`}`, () => {
      expect(checkOrigin(origin)).toBe(true);
    });
  }

  for (const origin of denied) {
    it(`denies "${origin}"`, () => {
      expect(checkOrigin(origin)).toBe(false);
    });
  }
});
