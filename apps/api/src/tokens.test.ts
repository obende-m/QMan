import { describe, expect, it } from "vitest";
import { hashToken, hashesMatch, issueToken } from "./tokens.js";

describe("session tokens", () => {
  it("issues distinct tokens with room to spare", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => issueToken()));
    expect(tokens.size).toBe(500);
    // 32 bytes base64url, unpadded.
    expect([...tokens][0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is safe in a cookie, a header and a URL without escaping", () => {
    for (let i = 0; i < 100; i += 1) {
      const token = issueToken();
      expect(encodeURIComponent(token)).toBe(token);
      expect(token).not.toMatch(/[+/=;,\s]/);
    }
  });

  it("hashes deterministically, and does not reveal the token", () => {
    const token = issueToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toBe(hashToken(issueToken()));
  });

  it("compares hashes without a length-independent shortcut", () => {
    const hash = hashToken("a");
    expect(hashesMatch(hash, hash)).toBe(true);
    expect(hashesMatch(hash, hashToken("b"))).toBe(false);
    expect(hashesMatch(hash, "short")).toBe(false);
  });
});
