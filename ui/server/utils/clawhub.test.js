import { describe, expect, it } from "vitest";
import { resolveClawhubPath } from "./clawhub.js";

const POSIX_HOME = "/Users/tester";

function envFor({ platform, home, existing, listDir, PATH, execPath, isFile, extra }) {
  return {
    platform,
    home,
    env: { PATH: PATH ?? "/usr/bin:/bin", ...extra },
    execPath: execPath ?? "/usr/local/bin/node",
    pathExists: candidate => existing.has(candidate),
    isFile: isFile ?? (() => true),
    listDir: listDir ?? (async () => []),
  };
}

describe("resolveClawhubPath", () => {
  it("resolves clawhub from a PATH directory on POSIX", async () => {
    const existing = new Set(["/Users/tester/.npm-global/bin/clawhub"]);
    await expect(resolveClawhubPath(envFor({ platform: "darwin", home: POSIX_HOME, existing }))).resolves.toBe(
      "/Users/tester/.npm-global/bin/clawhub",
    );
  });

  it("honours an explicit SATI_CLAWHUB_PATH override", async () => {
    const existing = new Set(["/opt/custom/bin/clawhub"]);
    await expect(
      resolveClawhubPath(
        envFor({
          platform: "darwin",
          home: POSIX_HOME,
          existing,
          extra: { SATI_CLAWHUB_PATH: "/opt/custom/bin/clawhub" },
        }),
      ),
    ).resolves.toBe("/opt/custom/bin/clawhub");
  });

  it("falls back to PATH when the override points at a missing file", async () => {
    const existing = new Set(["/Users/tester/.npm-global/bin/clawhub"]);
    await expect(
      resolveClawhubPath(
        envFor({
          platform: "darwin",
          home: POSIX_HOME,
          existing,
          extra: { SATI_CLAWHUB_PATH: "/opt/missing/clawhub" },
        }),
      ),
    ).resolves.toBe("/Users/tester/.npm-global/bin/clawhub");
  });

  it("falls back to PATH when the override points at a directory", async () => {
    const existing = new Set(["/Users/tester/.npm-global/bin/clawhub", "/opt/not-a-file/clawhub"]);
    await expect(
      resolveClawhubPath(
        envFor({
          platform: "darwin",
          home: POSIX_HOME,
          existing,
          isFile: candidate => candidate !== "/opt/not-a-file/clawhub",
          extra: { SATI_CLAWHUB_PATH: "/opt/not-a-file/clawhub" },
        }),
      ),
    ).resolves.toBe("/Users/tester/.npm-global/bin/clawhub");
  });

  it("handles quoted PATH entries", async () => {
    const existing = new Set(["/Users/tester/my bin/clawhub"]);
    await expect(
      resolveClawhubPath(
        envFor({ platform: "darwin", home: POSIX_HOME, existing, PATH: '"/Users/tester/my bin":/usr/bin' }),
      ),
    ).resolves.toBe("/Users/tester/my bin/clawhub");
  });

  it("finds clawhub beside the running node (nvm/homebrew global bin)", async () => {
    const existing = new Set(["/opt/homebrew/bin/clawhub"]);
    await expect(
      resolveClawhubPath(
        envFor({ platform: "darwin", home: POSIX_HOME, existing, execPath: "/opt/homebrew/bin/node" }),
      ),
    ).resolves.toBe("/opt/homebrew/bin/clawhub");
  });

  it("finds clawhub under an nvm node version when PATH has no npm bin dir", async () => {
    const nvmRoot = "/Users/tester/.nvm/versions/node";
    const existing = new Set([`${nvmRoot}/v22.22.3/bin/clawhub`]);
    const listDir = async dir => (dir === nvmRoot ? ["v20.11.0", "v22.22.3"] : []);
    await expect(resolveClawhubPath(envFor({ platform: "darwin", home: POSIX_HOME, existing, listDir }))).resolves.toBe(
      `${nvmRoot}/v22.22.3/bin/clawhub`,
    );
  });

  it("sorts nvm versions numerically, not lexicographically (v10 > v9)", async () => {
    const nvmRoot = "/Users/tester/.nvm/versions/node";
    const existing = new Set([`${nvmRoot}/v9.11.0/bin/clawhub`, `${nvmRoot}/v10.0.0/bin/clawhub`]);
    const listDir = async dir => (dir === nvmRoot ? ["v9.11.0", "v10.0.0"] : []);
    await expect(resolveClawhubPath(envFor({ platform: "darwin", home: POSIX_HOME, existing, listDir }))).resolves.toBe(
      `${nvmRoot}/v10.0.0/bin/clawhub`,
    );
  });

  it("sorts unprefixed asdf versions numerically", async () => {
    const asdfRoot = "/Users/tester/.asdf/installs/nodejs";
    const existing = new Set([`${asdfRoot}/9.11.0/bin/clawhub`, `${asdfRoot}/10.0.0/bin/clawhub`]);
    const listDir = async dir => (dir === asdfRoot ? ["9.11.0", "10.0.0"] : []);
    await expect(resolveClawhubPath(envFor({ platform: "darwin", home: POSIX_HOME, existing, listDir }))).resolves.toBe(
      `${asdfRoot}/10.0.0/bin/clawhub`,
    );
  });

  it("prefers the newest nvm version when several have clawhub", async () => {
    const nvmRoot = "/Users/tester/.nvm/versions/node";
    const existing = new Set([`${nvmRoot}/v22.22.3/bin/clawhub`, `${nvmRoot}/v22.23.1/bin/clawhub`]);
    const listDir = async dir => (dir === nvmRoot ? ["v22.22.3", "v22.23.1"] : []);
    await expect(resolveClawhubPath(envFor({ platform: "darwin", home: POSIX_HOME, existing, listDir }))).resolves.toBe(
      `${nvmRoot}/v22.23.1/bin/clawhub`,
    );
  });

  it("prefers the version-manager install over a generic ~/.npm-global one", async () => {
    const nvmRoot = "/Users/tester/.nvm/versions/node";
    const existing = new Set([`${nvmRoot}/v22.22.3/bin/clawhub`, "/Users/tester/.npm-global/bin/clawhub"]);
    const listDir = async dir => (dir === nvmRoot ? ["v22.22.3"] : []);
    await expect(resolveClawhubPath(envFor({ platform: "darwin", home: POSIX_HOME, existing, listDir }))).resolves.toBe(
      `${nvmRoot}/v22.22.3/bin/clawhub`,
    );
  });

  it("finds clawhub under a fnm node version (installation/bin layout)", async () => {
    const fnmRoot = "/Users/tester/.local/share/fnm/node-versions";
    const existing = new Set([`${fnmRoot}/v22.22.3/installation/bin/clawhub`]);
    const listDir = async dir => (dir === fnmRoot ? ["v22.22.3"] : []);
    await expect(resolveClawhubPath(envFor({ platform: "darwin", home: POSIX_HOME, existing, listDir }))).resolves.toBe(
      `${fnmRoot}/v22.22.3/installation/bin/clawhub`,
    );
  });

  it("skips a candidate that exists but is not a regular file", async () => {
    const nvmRoot = "/Users/tester/.nvm/versions/node";
    const existing = new Set(["/Users/tester/bin/clawhub", `${nvmRoot}/v22.22.3/bin/clawhub`]);
    const listDir = async dir => (dir === nvmRoot ? ["v22.22.3"] : []);
    const isFile = candidate => candidate !== "/Users/tester/bin/clawhub";
    await expect(
      resolveClawhubPath(
        envFor({ platform: "darwin", home: POSIX_HOME, existing, listDir, isFile, PATH: "/Users/tester/bin:/usr/bin" }),
      ),
    ).resolves.toBe(`${nvmRoot}/v22.22.3/bin/clawhub`);
  });

  it("returns null when clawhub is nowhere to be found", async () => {
    await expect(
      resolveClawhubPath(envFor({ platform: "darwin", home: POSIX_HOME, existing: new Set() })),
    ).resolves.toBe(null);
  });

  it("resolves clawhub.exe from a Windows PATH directory", async () => {
    const existing = new Set(["C:\\Users\\tester\\AppData\\Roaming\\npm\\clawhub.exe"]);
    await expect(
      resolveClawhubPath(
        envFor({
          platform: "win32",
          home: "C:\\Users\\tester",
          existing,
          PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm",
          execPath: "C:\\Program Files\\nodejs\\node.exe",
        }),
      ),
    ).resolves.toBe("C:\\Users\\tester\\AppData\\Roaming\\npm\\clawhub.exe");
  });

  it("returns null when only clawhub.cmd exists on Windows (bare-name PATHEXT fallback)", async () => {
    const existing = new Set(["C:\\Users\\tester\\AppData\\Roaming\\npm\\clawhub.cmd"]);
    await expect(
      resolveClawhubPath(
        envFor({
          platform: "win32",
          home: "C:\\Users\\tester",
          existing,
          PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm",
          execPath: "C:\\Program Files\\nodejs\\node.exe",
        }),
      ),
    ).resolves.toBe(null);
  });

  it("skips version-manager roots that cannot be listed", async () => {
    const nvmRoot = "/Users/tester/.nvm/versions/node";
    const existing = new Set([`${nvmRoot}/v22.22.3/bin/clawhub`]);
    const listDir = async () => {
      throw new Error("ENOENT");
    };
    await expect(resolveClawhubPath(envFor({ platform: "darwin", home: POSIX_HOME, existing, listDir }))).resolves.toBe(
      null,
    );
  });
});
