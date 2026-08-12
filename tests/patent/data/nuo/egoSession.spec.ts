import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  SatiCommandOptions,
  SatiCommandResult,
  SatiCommandRunner,
} from "../../../../src/tool/builtin/bash/commandRunner.js";
import { EgoBrowserSession, normalizePatentNumber } from "../../../../src/patent/data/nuo/egoSession.js";

class FakeRunner implements SatiCommandRunner {
  calls: Array<{ command: string; options: SatiCommandOptions }> = [];
  result: Partial<SatiCommandResult> = {};

  async run(command: string, options: SatiCommandOptions): Promise<SatiCommandResult> {
    this.calls.push({ command, options });
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 10, ...this.result };
  }
}

function makeFakeHomeDir(): { homeDir: string } {
  const base = mkdtempSync(join(tmpdir(), "sati-ego-session-"));
  const bin = join(base, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const cli = join(bin, "ego-browser");
  writeFileSync(cli, "#!/bin/sh\nexit 0\n");
  chmodSync(cli, 0o755);
  return { homeDir: base };
}

test("egoSession: checkAvailability ok on darwin with CLI present", () => {
  const { homeDir } = makeFakeHomeDir();
  const session = new EgoBrowserSession({ homeDir, platform: "darwin" });
  assert.deepEqual(session.checkAvailability(), { ok: true });
});

test("egoSession: checkAvailability unavailable on non-darwin", () => {
  const { homeDir } = makeFakeHomeDir();
  const session = new EgoBrowserSession({ homeDir, platform: "linux" });
  const result = session.checkAvailability();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unavailable");
});

test("egoSession: checkAvailability setup_required when CLI missing", () => {
  const base = mkdtempSync(join(tmpdir(), "sati-ego-session-missing-"));
  const session = new EgoBrowserSession({
    homeDir: base,
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin" },
  });
  const result = session.checkAvailability();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "setup_required");
    assert.match(result.reason, /lite\.ego\.app/);
  }
});

test("egoSession: runScript builds quoted heredoc, injects ~/.local/bin into PATH, merges stderr", async () => {
  const runner = new FakeRunner();
  runner.result = { exitCode: 0, stdout: "", stderr: "TITLE: demo\n", timedOut: false, durationMs: 30 };
  const session = new EgoBrowserSession({ runner, homeDir: "/Users/tester", platform: "darwin" });

  const result = await session.runScript("cliLog('x')", { cwd: "/tmp", timeoutMs: 10_000 });

  assert.equal(runner.calls.length, 1);
  const { command, options } = runner.calls[0]!;
  assert.match(command, /^ego-browser nodejs <<'EGO_SCRIPT_EOF'\n/);
  assert.match(command, /\nEGO_SCRIPT_EOF$/);
  assert.ok(options.env?.PATH?.includes("/Users/tester/.local/bin"));
  assert.equal(options.timeoutMs, 10_000);
  assert.equal(result.output, "TITLE: demo\n");
  assert.equal(result.exitCode, 0);
});

test("egoSession: runScript truncates oversized output", async () => {
  const runner = new FakeRunner();
  runner.result = { exitCode: 0, stdout: "A".repeat(1_000), stderr: "", timedOut: false, durationMs: 5 };
  const session = new EgoBrowserSession({ runner, homeDir: "/Users/tester", platform: "darwin", maxOutputBytes: 100 });

  const result = await session.runScript("cliLog('x')", { cwd: "/tmp" });
  assert.ok(result.output.includes("[output truncated]"));
});

test("egoSession: extractTaggedJson parses EGO_<TAG>: payload", () => {
  const session = new EgoBrowserSession({ platform: "darwin" });
  const output = 'PROGRESS: 1/2:CN1\nEGO_DOWNLOAD_RESULTS:[{"patent":"CN1","status":"ok"}]\n';
  const parsed = session.extractTaggedJson<Array<{ patent: string; status: string }>>(output, "DOWNLOAD_RESULTS");
  assert.deepEqual(parsed, [{ patent: "CN1", status: "ok" }]);
});

test("egoSession: extractTaggedJson returns null when tag missing or payload invalid", () => {
  const session = new EgoBrowserSession({ platform: "darwin" });
  assert.equal(session.extractTaggedJson("no tag here", "DOWNLOAD_RESULTS"), null);
  assert.equal(session.extractTaggedJson("EGO_DOWNLOAD_RESULTS:not-json", "DOWNLOAD_RESULTS"), null);
});

test("egoSession: taskSpaceName is session-scoped and stable", () => {
  const session = new EgoBrowserSession({ platform: "darwin" });
  assert.equal(session.taskSpaceName("patent-download", "abc123"), "sati-patent-download-abc123");
  assert.equal(session.taskSpaceName("patent-download"), "sati-patent-download");
});

test("egoSession: runConnectionProbe succeeds when probe marker present", async () => {
  const runner = new FakeRunner();
  runner.result = { exitCode: 0, stdout: "", stderr: "EGO_DOCTOR_OK\n", timedOut: false, durationMs: 200 };
  const session = new EgoBrowserSession({ runner, platform: "darwin" });

  assert.equal(await session.runConnectionProbe(5_000), true);
  assert.match(runner.calls[0]?.command ?? "", /nodejs -e "cliLog\('EGO_DOCTOR_OK'\)"/);
});

test("egoSession: runConnectionProbe fails on non-zero exit or timeout", async () => {
  const runner = new FakeRunner();
  runner.result = { exitCode: 1, stdout: "", stderr: "boom", timedOut: false, durationMs: 100 };
  const session = new EgoBrowserSession({ runner, platform: "darwin" });
  assert.equal(await session.runConnectionProbe(5_000), false);

  const timeoutRunner = new FakeRunner();
  timeoutRunner.result = { exitCode: null, stdout: "", stderr: "", timedOut: true, durationMs: 8_000 };
  const timeoutSession = new EgoBrowserSession({ runner: timeoutRunner, platform: "darwin" });
  assert.equal(await timeoutSession.runConnectionProbe(5_000), false);
});

test("normalizePatentNumber strips separators and upper-cases", () => {
  assert.equal(normalizePatentNumber(" cn115690481a "), "CN115690481A");
  assert.equal(normalizePatentNumber("US-11739244-B2"), "US11739244B2");
  assert.equal(normalizePatentNumber("ep 1234567 a1"), "EP1234567A1");
});
