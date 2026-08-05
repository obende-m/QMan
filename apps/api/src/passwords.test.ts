import { describe, expect, it } from "vitest";
import { CURRENT, hashPassword, needsRehash, verifyPassword } from "./passwords.js";

// Cheap parameters. The property under test is the protocol, not the cost.
const FAST = { N: 1024, r: 8, p: 1, keyLength: 64 };

describe("password hashing", () => {
  it("accepts the right password and rejects the wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple", FAST);
    expect(await verifyPassword("correct horse battery staple", stored.hash, stored.salt)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", stored.hash, stored.salt)).toBe(false);
  });

  /** Equal passwords must not produce equal digests, or the table becomes a lookup. */
  it("salts every password separately", async () => {
    const a = await hashPassword("same password", FAST);
    const b = await hashPassword("same password", FAST);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(await verifyPassword("same password", b.hash, b.salt)).toBe(true);
  });

  it("records the cost that produced the digest", async () => {
    const stored = await hashPassword("a password long enough", FAST);
    expect(stored.hash.startsWith("scrypt$1024$8$1$")).toBe(true);
  });

  /**
   * Without this, raising the cost would invalidate every password in the
   * hospital at once — every member of staff locked out on the deploy.
   */
  it("verifies digests created at an older cost", async () => {
    const old = await hashPassword("still my password", { N: 512, r: 8, p: 1, keyLength: 64 });
    expect(await verifyPassword("still my password", old.hash, old.salt)).toBe(true);
    expect(needsRehash(old.hash, FAST)).toBe(true);
    expect(needsRehash((await hashPassword("x", FAST)).hash, FAST)).toBe(false);
  });

  /**
   * Directory-backed accounts hold no password here. Throwing would make them
   * distinguishable from a wrong password by anyone watching responses.
   */
  it("returns false rather than throwing for absent or malformed digests", async () => {
    expect(await verifyPassword("anything", null, null)).toBe(false);
    expect(await verifyPassword("anything", "not-a-digest", "abcd")).toBe(false);
    expect(await verifyPassword("anything", "scrypt$x$y$z$ff", "abcd")).toBe(false);
    expect(await verifyPassword("anything", "scrypt$1024$8$1$", "abcd")).toBe(false);
  });

  it("uses parameters that stay inside Node's default scrypt memory ceiling", async () => {
    // 128 * N * r bytes. Above 32MB, Node refuses and every sign-in fails.
    expect(128 * CURRENT.N * CURRENT.r).toBeLessThan(32 * 1024 * 1024);
    const stored = await hashPassword("real cost path", CURRENT);
    expect(await verifyPassword("real cost path", stored.hash, stored.salt)).toBe(true);
  });
});
