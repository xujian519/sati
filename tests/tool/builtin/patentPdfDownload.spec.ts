import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EgoBrowserSession } from "../../../src/patent/data/nuo/egoSession.js";
import type {
  SatiCommandOptions,
  SatiCommandResult,
  SatiCommandRunner,
} from "../../../src/tool/builtin/bash/commandRunner.js";
import { createPatentPdfDownloadTool } from "../../../src/tool/builtin/patentPdfDownload.js";
import { SatiToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";

class FakeRunner implements SatiCommandRunner {
  calls: Array<{ command: string; options: SatiCommandOptions }> = [];
  result: Partial<SatiCommandResult> = {};

  async run(command: string, options: SatiCommandOptions): Promise<SatiCommandResult> {
    this.calls.push({ command, options });
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 42, ...this.result };
  }
}

function makeContext(overrides?: Partial<SatiToolRuntimeContext>): SatiToolRuntimeContext {
  return {
    sessionId: "sess-1",
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
    env: { PATH: "/usr/bin:/bin" },
    ...overrides,
  };
}

function makeSession(runner: SatiCommandRunner, platform: NodeJS.Platform = "darwin"): EgoBrowserSession {
  const base = mkdtempSync(join(tmpdir(), "sati-pdf-dl-"));
  const bin = join(base, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const cli = join(bin, "ego-browser");
  writeFileSync(cli, "#!/bin/sh\nexit 0\n");
  chmodSync(cli, 0o755);
  return new EgoBrowserSession({ runner, homeDir: base, platform });
}

const OK_OUTPUT = [
  "PROGRESS:1/2:CN115690481A",
  "PROGRESS:2/2:US11739244B2",
  'EGO_DOWNLOAD_RESULTS:[{"patent":"CN115690481A","status":"ok","path":"/tmp/out/CN115690481A.pdf","pdfUrl":"https://x/CN1.pdf"},{"patent":"US11739244B2","status":"fallback","pdfUrl":"https://x/US1.pdf","error":"download canceled"}]',
  "",
].join("\n");

test("patent_pdf_download: validateInput rejects empty/oversized/invalid inputs", async () => {
  const tool = createPatentPdfDownloadTool({ session: makeSession(new FakeRunner()) });

  const missing = await tool.validateInput?.({} as never, makeContext());
  assert.equal(missing?.ok, false);
  assert.deepEqual(missing?.issues[0]?.path, "patents");

  const empty = await tool.validateInput?.({ patents: [] } as never, makeContext());
  assert.equal(empty?.ok, false);

  const tooMany = await tool.validateInput?.(
    { patents: Array.from({ length: 51 }, (_, i) => `CN${i}`) } as never,
    makeContext(),
  );
  assert.equal(tooMany?.ok, false);
  assert.match(tooMany?.issues[0]?.message ?? "", /maximum of 50/);

  const badTimeout = await tool.validateInput?.({ patents: ["CN1"], timeoutMs: 300_001 } as never, makeContext());
  assert.equal(badTimeout?.ok, false);

  const badPageTimeout = await tool.validateInput?.({ patents: ["CN1"], pageTimeoutSec: 1 } as never, makeContext());
  assert.equal(badPageTimeout?.ok, false);

  const valid = await tool.validateInput?.({ patents: ["cn-1", "CN-1", "US1"] } as never, makeContext());
  assert.equal(valid?.ok, true);
  // 去重 + 归一化
  const normalized = (valid?.ok ? valid.input : null) as { patents?: string[] } | null;
  assert.deepEqual(normalized?.patents, ["CN1", "US1"]);
});

test("patent_pdf_download: execute parses results and summary on success", async () => {
  const runner = new FakeRunner();
  runner.result = { exitCode: 0, stdout: "", stderr: OK_OUTPUT, timedOut: false, durationMs: 1200 };
  const tool = createPatentPdfDownloadTool({ session: makeSession(runner) });

  const output = await tool.execute({ patents: ["CN115690481A", "US11739244B2"] }, makeContext());

  assert.equal(output.data?.summary.total, 2);
  assert.equal(output.data?.summary.ok, 1);
  assert.equal(output.data?.summary.fallback, 1);
  assert.equal(output.data?.summary.failed, 0);
  assert.equal(output.data?.results[0]?.status, "ok");
  assert.equal(output.data?.results[0]?.patent, "CN115690481A");
  assert.equal(output.data?.results[1]?.status, "fallback");
  assert.ok(output.data?.outputDir?.includes("专利原文"));
  const content = output.content[0];
  assert.equal(content?.type, "text");
  assert.match(content.type === "text" ? content.text : "", /下载完成：1\/2 成功/);
  // 脚本包含下载拦截关键步骤与归一化专利号
  const script = runner.calls[0]?.command ?? "";
  assert.ok(script.includes("page.waitForEvent('download'"));
  assert.ok(script.includes("saveAs"));
  assert.ok(script.includes("CN115690481A"));
});

test("patent_pdf_download: execute throws setup_required when session unavailable", async () => {
  const tool = createPatentPdfDownloadTool({ session: makeSession(new FakeRunner(), "linux") });
  await assert.rejects(
    () => tool.execute({ patents: ["CN1"] }, makeContext()),
    (error: unknown) => {
      assert.ok(error instanceof SatiToolRuntimeError);
      assert.equal(error.code, "setup_required");
      return true;
    },
  );
});

test("patent_pdf_download: execute throws tool_timeout on runner timeout", async () => {
  const runner = new FakeRunner();
  runner.result = { exitCode: null, stdout: "", stderr: "", timedOut: true, durationMs: 90_000 };
  const tool = createPatentPdfDownloadTool({ session: makeSession(runner) });
  await assert.rejects(
    () => tool.execute({ patents: ["CN1"] }, makeContext()),
    (error: unknown) => {
      assert.ok(error instanceof SatiToolRuntimeError);
      assert.equal(error.code, "tool_timeout");
      return true;
    },
  );
});

test("patent_pdf_download: execute throws tool_execution_failed on non-zero exit", async () => {
  const runner = new FakeRunner();
  runner.result = { exitCode: 127, stdout: "", stderr: "command not found", timedOut: false, durationMs: 30 };
  const tool = createPatentPdfDownloadTool({ session: makeSession(runner) });
  await assert.rejects(
    () => tool.execute({ patents: ["CN1"] }, makeContext()),
    (error: unknown) => {
      assert.ok(error instanceof SatiToolRuntimeError);
      assert.equal(error.code, "tool_execution_failed");
      assert.match(error.message, /127/);
      return true;
    },
  );
});

test("patent_pdf_download: checkPermissions asks for permission", async () => {
  const tool = createPatentPdfDownloadTool({ session: makeSession(new FakeRunner()) });
  const permission = await tool.checkPermissions?.({ patents: ["CN1"] }, makeContext());
  assert.equal(permission?.type, "ask");
});

test("patent_pdf_download: registry registers by default and can be disabled", () => {
  const registry = createBuiltinRegistry();
  assert.equal(registry.has("patent_pdf_download"), true);

  const without = createBuiltinRegistry({ patentPdfDownload: false });
  assert.equal(without.has("patent_pdf_download"), false);
});
