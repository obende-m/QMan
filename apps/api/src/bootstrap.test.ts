/**
 * The bootstrap command.
 *
 * Two properties are worth a test each, and both are about what it refuses to
 * do rather than what it does.
 *
 * It creates a platform administrator and nothing else — in particular it holds
 * no code path that creates a hospital, because an organization that appeared
 * from a shell command would have no audit record naming who asked for it.
 *
 * And it refuses to run once a platform administrator exists. Without that,
 * anyone reaching the server's shell could mint an account holding every
 * platform permission, and the audit log would show an account creating itself.
 */
import { describe, expect, it } from "vitest";
import { parseArguments } from "./bootstrap.js";
import { ConfigurationError } from "./config.js";
import { generatePassword } from "./tokens.js";

describe("bootstrap arguments", () => {
  it("reads a username and defaults the display name to it", () => {
    expect(parseArguments(["--username", "root"])).toEqual({
      username: "root",
      displayName: "root",
      recover: false,
    });
  });

  it("accepts --name=value as well as --name value", () => {
    expect(parseArguments(["--username=root", "--name=Platform Root"])).toEqual({
      username: "root",
      displayName: "Platform Root",
      recover: false,
    });
  });

  it("refuses to run without a username rather than inventing one", () => {
    expect(() => parseArguments([])).toThrow(ConfigurationError);
    expect(() => parseArguments(["--username", "  "])).toThrow(/username/);
  });

  it("carries the recovery flag, which the caller must pass deliberately", () => {
    expect(parseArguments(["--username", "root", "--recover"]).recover).toBe(true);
    expect(parseArguments(["--username", "root"]).recover).toBe(false);
  });

  /**
   * There is no argument that creates a hospital, and this asserts that by
   * construction: the parsed shape has three fields and none of them names an
   * organization. A future flag would have to change this test first.
   */
  it("has no argument that could create an organization", () => {
    const parsed = parseArguments([
      "--username",
      "root",
      "--organization",
      "freshsprings",
      "--hospital",
      "anything",
    ]);
    expect(Object.keys(parsed).sort()).toEqual(["displayName", "recover", "username"]);
    expect(JSON.stringify(parsed)).not.toContain("freshsprings");
  });
});

describe("generated passwords", () => {
  it("omits the characters that are misread when transcribed", () => {
    // Read off one screen and typed into another, so O/0 and I/l/1 are out —
    // the same exclusions the domain's Journey Code alphabet makes.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(generatePassword()).not.toMatch(/[Ol01I]/);
    }
  });

  it("is grouped, because a long random run is transcribed wrongly", () => {
    expect(generatePassword()).toMatch(/^[A-Za-z2-9]{5}(-[A-Za-z2-9]{5}){3}$/);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePassword()));
    expect(seen.size).toBe(200);
  });
});
