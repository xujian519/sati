import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMMAND_PATH_DENIED_MESSAGE, commandAllowedBases, isUnderBase, resolveCommandPath } from "./commandPaths.js";

const tempDirs = [];

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "sati-command-paths-"));
  tempDirs.push(home);
  return home;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("isUnderBase", () => {
  it("accepts strict descendants", () => {
    expect(isUnderBase("/a/b", "/a/b/c.md")).toBe(true);
    expect(isUnderBase("/a/b", "/a/b/nested/c.md")).toBe(true);
  });

  it("rejects the base directory itself", () => {
    expect(isUnderBase("/a/b", "/a/b")).toBe(false);
  });

  it("rejects parents, siblings and traversal", () => {
    expect(isUnderBase("/a/b", "/a/b/../c.md")).toBe(false);
    expect(isUnderBase("/a/b", "/a")).toBe(false);
    expect(isUnderBase("/a/b", "/a/bc/c.md")).toBe(false);
  });

  it("does not mistake a leading-dot name for traversal", () => {
    // `path.relative` yields "..foo/c.md"; only a real `..` segment is a traversal.
    expect(isUnderBase("/a/b", "/a/b/..foo/c.md")).toBe(true);
  });
});

describe("resolveCommandPath", () => {
  it("allows the Sati home command and skill scopes", () => {
    const home = makeHome();
    const env = { SATI_HOME: home };

    expect(resolveCommandPath(join(home, "commands", "hello.md"), undefined, env)).toBe(
      join(home, "commands", "hello.md"),
    );
    expect(resolveCommandPath(join(home, "skills", "demo", "SKILL.md"), undefined, env)).toBe(
      join(home, "skills", "demo", "SKILL.md"),
    );
  });

  it("allows project scopes only when projectPath is supplied", () => {
    const home = makeHome();
    const project = makeHome();
    const env = { SATI_HOME: home };
    const target = join(project, ".sati", "commands", "deploy.md");

    expect(resolveCommandPath(target, { projectPath: project }, env)).toBe(target);
    // No project context ⇒ strictly smaller whitelist, so the same path is denied.
    expect(resolveCommandPath(target, undefined, env)).toBeNull();
  });

  it("denies arbitrary files under $HOME — the regression this guards", () => {
    const home = makeHome();
    const env = { SATI_HOME: home };
    const secrets = [
      join(home, ".ssh", "id_rsa"),
      join(home, ".aws", "credentials"),
      join(home, ".sati", "config.yaml"),
      join(home, "notes.txt"),
    ];

    for (const secret of secrets) {
      expect(resolveCommandPath(secret, undefined, env), secret).toBeNull();
    }
  });

  it("denies traversal out of an allowed directory", () => {
    const home = makeHome();
    const env = { SATI_HOME: home };

    expect(resolveCommandPath(join(home, "commands", "..", "..", ".ssh", "id_rsa"), undefined, env)).toBeNull();
  });

  it("denies a bare `.sati/commands` directory outside the Sati home", () => {
    const home = makeHome();
    const elsewhere = makeHome();
    const env = { SATI_HOME: home };

    // The old /load check used a substring regex, so any `.sati/commands` path
    // anywhere on disk passed. The whitelist anchors on the actual bases.
    expect(resolveCommandPath(join(elsewhere, ".sati", "commands", "x.md"), undefined, env)).toBeNull();
  });

  it("rejects empty and non-string input", () => {
    const env = { SATI_HOME: makeHome() };
    for (const value of [undefined, null, "", "   ", 42, {}]) {
      expect(resolveCommandPath(value, undefined, env)).toBeNull();
    }
  });
});

describe("commandAllowedBases", () => {
  it("widens only by the project scopes", () => {
    const home = makeHome();
    const project = makeHome();
    const env = { SATI_HOME: home };

    expect(commandAllowedBases(undefined, env)).toEqual([join(home, "commands"), join(home, "skills")]);
    expect(commandAllowedBases({ projectPath: project }, env)).toEqual([
      join(home, "commands"),
      join(home, "skills"),
      join(project, ".sati", "commands"),
      join(project, ".sati", "skills"),
    ]);
  });
});

describe("COMMAND_PATH_DENIED_MESSAGE", () => {
  it("is a non-empty operator-facing string", () => {
    expect(typeof COMMAND_PATH_DENIED_MESSAGE).toBe("string");
    expect(COMMAND_PATH_DENIED_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe("fixture sanity", () => {
  it("creates real directories so the allow cases are not vacuous", () => {
    const home = makeHome();
    mkdirSync(join(home, "commands"), { recursive: true });
    writeFileSync(join(home, "commands", "hello.md"), "hi", "utf8");
    expect(resolveCommandPath(join(home, "commands", "hello.md"), undefined, { SATI_HOME: home })).toBeTruthy();
  });
});
