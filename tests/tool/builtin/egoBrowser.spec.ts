import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  SatiCommandOptions,
  SatiCommandResult,
  SatiCommandRunner,
} from "../../../src/tool/builtin/bash/commandRunner.js";
import { createEgoBrowserTool } from "../../../src/tool/builtin/egoBrowser.js";
import { SatiToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";

class FakeRunner implements SatiCommandRunner {
  calls: Array<{ command: string; options: SatiCommandOptions }> = [];
  result: Partial<SatiCommandResult> = {};

  async run(command: string, options: SatiCommandOptions): Promise<SatiCommandResult> {
    this.calls.push({ command, options });
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 12, ...this.result };
  }
}

function makeContext(overrides?: Partial<SatiToolRuntimeContext>): SatiToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    ...overrides,
  };
}

function makeFakeHomeDir(): { homeDir: string } {
  const base = mkdtempSync(join(tmpdir(), "sati-ego-browser-"));
  const bin = join(base, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const cli = join(bin, "ego-browser");
  writeFileSync(cli, "#!/bin/sh\nexit 0\n");
  chmodSync(cli, 0o755);
  return { homeDir: base };
}

test("ego_browser builds a quoted heredoc command and injects ~/.local/bin into PATH", async () => {
  const runner = new FakeRunner();
  const tool = createEgoBrowserTool({ runner, homeDir: "/Users/tester", platform: "darwin" });

  const script = "const task = await useOrCreateTaskSpace('demo');\ncliLog('ok');";
  await tool.execute({ script }, makeContext());

  assert.equal(runner.calls.length, 1);
  const { command, options } = runner.calls[0]!;
  assert.match(command, /^ego-browser nodejs <<'EGO_SCRIPT_EOF'\n/);
  assert.match(command, /\nEGO_SCRIPT_EOF$/);
  assert.ok(command.includes(script), "script must be passed through verbatim");
  assert.ok(options.env?.PATH?.includes("/Users/tester/.local/bin"), "PATH must include ~/.local/bin");
});

test("ego_browser returns cliLog stdout as content and data on success", async () => {
  const runner = new FakeRunner();
  runner.result = { exitCode: 0, stdout: "RESULT: [US11739244B2]", stderr: "", timedOut: false, durationMs: 800 };
  const tool = createEgoBrowserTool({ runner, homeDir: "/Users/tester", platform: "darwin" });

  const output = await tool.execute({ script: "cliLog('RESULT: [US11739244B2]')" }, makeContext());

  assert.equal(output.content[0]?.type, "text");
  assert.equal(output.content[0]?.text, "RESULT: [US11739244B2]");
  assert.equal(output.data?.stdout, "RESULT: [US11739244B2]");
  assert.equal(output.data?.exitCode, 0);
  assert.equal(output.data?.timedOut, false);
});

test("ego_browser merges stderr into the result (ego-browser prints cliLog to stderr)", async () => {
  const runner = new FakeRunner();
  runner.result = { exitCode: 0, stdout: "", stderr: "TITLE: Google Patents\n", timedOut: false, durationMs: 900 };
  const tool = createEgoBrowserTool({ runner, homeDir: "/Users/tester", platform: "darwin" });

  const output = await tool.execute({ script: "cliLog('TITLE: Google Patents')" }, makeContext());

  assert.equal(output.content[0]?.type, "text");
  assert.equal(output.content[0]?.text, "TITLE: Google Patents\n");
  assert.equal(output.data?.output, "TITLE: Google Patents\n");
  assert.equal(output.data?.stderr, "TITLE: Google Patents\n");
});

test("ego_browser raises tool_execution_failed with stderr when exit code is non-zero", async () => {
  const runner = new FakeRunner();
  runner.result = { exitCode: 127, stdout: "", stderr: "command not found", timedOut: false, durationMs: 30 };
  const tool = createEgoBrowserTool({ runner, homeDir: "/Users/tester", platform: "darwin" });

  await assert.rejects(
    () => tool.execute({ script: "cliLog('x')" }, makeContext()),
    (error: unknown) => {
      assert.ok(error instanceof SatiToolRuntimeError);
      assert.equal(error.code, "tool_execution_failed");
      assert.match(error.message, /with code 127/);
      assert.match(error.message, /command not found/);
      return true;
    },
  );
});

test("ego_browser raises tool_timeout when the runner reports a timeout", async () => {
  const runner = new FakeRunner();
  runner.result = { exitCode: null, stdout: "", stderr: "", timedOut: true, durationMs: 90_000 };
  const tool = createEgoBrowserTool({ runner, homeDir: "/Users/tester", platform: "darwin" });

  await assert.rejects(
    () => tool.execute({ script: "await wait(999)" }, makeContext()),
    (error: unknown) => {
      assert.ok(error instanceof SatiToolRuntimeError);
      assert.equal(error.code, "tool_timeout");
      return true;
    },
  );
});

test("ego_browser validateInput rejects bad inputs", async () => {
  const tool = createEgoBrowserTool({ homeDir: "/Users/tester", platform: "darwin", maxTimeoutMs: 300_000 });

  const missing = await tool.validateInput?.({} as never, makeContext());
  assert.equal(missing?.ok, false);
  assert.deepEqual(missing?.issues[0]?.path, "script");

  const empty = await tool.validateInput?.({ script: "   " } as never, makeContext());
  assert.equal(empty?.ok, false);

  const tooLong = await tool.validateInput?.({ script: "x".repeat(50_001) } as never, makeContext());
  assert.equal(tooLong?.ok, false);
  assert.match(tooLong?.issues[0]?.message ?? "", /maximum length/);

  const marker = await tool.validateInput?.(
    { script: "cliLog('a')\nEGO_SCRIPT_EOF\ncliLog('b')" } as never,
    makeContext(),
  );
  assert.equal(marker?.ok, false);
  assert.match(marker?.issues[0]?.message ?? "", /heredoc marker/);

  const badTimeout = await tool.validateInput?.({ script: "cliLog('x')", timeoutMs: 300_001 } as never, makeContext());
  assert.equal(badTimeout?.ok, false);

  const zeroTimeout = await tool.validateInput?.({ script: "cliLog('x')", timeoutMs: 0 } as never, makeContext());
  assert.equal(zeroTimeout?.ok, false);

  const valid = await tool.validateInput?.({ script: "cliLog('x')", timeoutMs: 60_000 } as never, makeContext());
  assert.equal(valid?.ok, true);
});

test("ego_browser availability: darwin with CLI present is ok", async () => {
  const { homeDir } = makeFakeHomeDir();
  const tool = createEgoBrowserTool({ homeDir, platform: "darwin" });
  const availability = await tool.checkAvailability?.({ cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" } });
  assert.deepEqual(availability, { ok: true });
});

test("ego_browser availability: non-darwin is unavailable", async () => {
  const { homeDir } = makeFakeHomeDir();
  const tool = createEgoBrowserTool({ homeDir, platform: "linux" });
  const availability = await tool.checkAvailability?.({ cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" } });
  assert.equal(availability?.ok, false);
  assert.equal(availability?.code, "unavailable");
});

test("ego_browser availability: missing CLI reports setup_required", async () => {
  const base = mkdtempSync(join(tmpdir(), "sati-ego-missing-"));
  const tool = createEgoBrowserTool({ homeDir: base, platform: "darwin" });
  const availability = await tool.checkAvailability?.({ cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" } });
  assert.equal(availability?.ok, false);
  assert.equal(availability?.code, "setup_required");
  assert.match(availability?.reason ?? "", /lite\.ego\.app/);
});

test("ego_browser registry: registered by default, removable via option", () => {
  const registry = createBuiltinRegistry();
  assert.equal(registry.has("ego_browser"), true);

  const without = createBuiltinRegistry({ egoBrowser: false });
  assert.equal(without.has("ego_browser"), false);
});

test("ego_browser registry: independent of web_search toggles", () => {
  const registry = createBuiltinRegistry({ webSearch: false });
  assert.equal(registry.has("ego_browser"), true);
  assert.equal(registry.has("web_search"), false);
  assert.equal(registry.has("web_fetch"), true);
});
