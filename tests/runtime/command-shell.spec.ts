import assert from "node:assert/strict";
import test from "node:test";
import { resolveDefaultCommandShell } from "../../src/runtime/index.js";

function resolverFixture(overrides: {
  platform: string;
  paths?: string[];
  pathDirs?: string[];
  env?: Record<string, string | undefined>;
}) {
  const paths = new Set(overrides.paths ?? []);
  const pathDirs = overrides.pathDirs ?? [];
  const env: Record<string, string | undefined> = {
    PATH: pathDirs.join(overrides.platform === "win32" ? ";" : ":"),
    ...(overrides.env ?? {}),
  };
  return (options: { platform?: string; env?: NodeJS.ProcessEnv } = {}) =>
    resolveDefaultCommandShell({
      platform: overrides.platform,
      env: { ...env, ...(options.env ?? {}) } as NodeJS.ProcessEnv,
      existsSync: candidate => paths.has(candidate),
      ...options,
    });
}

test("posix prefers /bin/bash when present", () => {
  const resolve = resolverFixture({ platform: "darwin", paths: ["/bin/bash"], pathDirs: ["/usr/bin"] });
  const shell = resolve();
  assert.equal(shell.kind, "bash");
  assert.equal(shell.shell, "/bin/bash");
  assert.deepEqual(shell.args("echo hi"), ["-c", "echo hi"]);
  assert.equal(shell.windowsVerbatimArguments, false);
});

test("posix falls back to PATH bash then /bin/sh", () => {
  const viaPath = resolverFixture({ platform: "linux", paths: ["/usr/local/bin/bash"], pathDirs: ["/usr/local/bin"] });
  assert.equal(viaPath().shell, "/usr/local/bin/bash");

  const viaSh = resolverFixture({ platform: "linux", pathDirs: ["/usr/bin"] });
  assert.equal(viaSh().kind, "sh");
  assert.equal(viaSh().shell, "/bin/sh");
});

test("windows prefers Git Bash from default install paths", () => {
  const resolve = resolverFixture({
    platform: "win32",
    paths: ["C:\\Program Files\\Git\\bin\\bash.exe"],
    pathDirs: ["C:\\Windows\\System32"],
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  });
  const shell = resolve();
  assert.equal(shell.kind, "bash");
  assert.equal(shell.shell, "C:\\Program Files\\Git\\bin\\bash.exe");
});

test("windows falls back to ComSpec cmd with verbatim args", () => {
  const resolve = resolverFixture({
    platform: "win32",
    paths: ["C:\\Windows\\System32\\cmd.exe"],
    pathDirs: ["C:\\Windows\\System32"],
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  });
  const shell = resolve();
  assert.equal(shell.kind, "cmd");
  assert.deepEqual(shell.args("echo hi"), ["/d", "/s", "/c", "echo hi"]);
  assert.equal(shell.windowsVerbatimArguments, true);
});

test("windows falls back to pwsh when cmd is unavailable", () => {
  const resolve = resolverFixture({
    platform: "win32",
    paths: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"],
    pathDirs: ["C:\\Program Files\\PowerShell\\7"],
  });
  const shell = resolve();
  assert.equal(shell.kind, "pwsh");
  assert.deepEqual(shell.args("echo hi"), ["-Command", "echo hi"]);
});

test("windows without any supported shell fails loudly", () => {
  const resolve = resolverFixture({ platform: "win32", pathDirs: [] });
  assert.throws(() => resolve(), /No supported Sati command shell found/);
});

test("SATI_SHELL_PATH overrides discovery and is honored by basename", () => {
  const resolve = resolverFixture({
    platform: "win32",
    paths: ["D:\\tools\\busybox.exe"],
    env: { SATI_SHELL_PATH: "D:\\tools\\busybox.exe" },
  });
  assert.equal(resolve().kind, "custom");

  const bashOverride = resolverFixture({
    platform: "darwin",
    paths: ["/opt/homebrew/bin/bash"],
    env: { SATI_SHELL_PATH: "/opt/homebrew/bin/bash" },
  });
  assert.equal(bashOverride().kind, "bash");
});

test("SATI_SHELL_PATH pointing at a missing binary fails loudly", () => {
  const resolve = resolverFixture({ platform: "darwin", env: { SATI_SHELL_PATH: "/no/such/bash" } });
  assert.throws(() => resolve(), /Configured Sati shell was not found/);
});
