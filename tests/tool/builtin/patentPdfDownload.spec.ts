import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
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
  // 注入失败的 fetch：兜底下载也失败 → fallback 条目升格为 failed（不触发真实网络）。
  const fetchImpl: typeof fetch = async () => {
    throw new Error("network down");
  };
  const tool = createPatentPdfDownloadTool({ session: makeSession(runner), fetchImpl });

  const output = await tool.execute({ patents: ["CN115690481A", "US11739244B2"] }, makeContext());

  assert.equal(output.data?.summary.total, 2);
  assert.equal(output.data?.summary.ok, 1);
  assert.equal(output.data?.summary.failed, 1);
  assert.equal(output.data?.results[0]?.status, "ok");
  assert.equal(output.data?.results[0]?.patent, "CN115690481A");
  assert.equal(output.data?.results[0]?.method, "browser");
  assert.equal(output.data?.results[1]?.status, "failed");
  assert.equal(output.data?.results[1]?.patent, "US11739244B2");
  assert.equal(output.data?.results[1]?.pdfUrl, "https://x/US1.pdf");
  assert.ok(output.data?.outputDir?.includes("专利原文"));
  const content = output.content[0];
  assert.equal(content?.type, "text");
  assert.match(content.type === "text" ? content.text : "", /下载完成：1\/2 成功，1 失败/);
  // 脚本包含统一拦截函数与归一化专利号
  const script = runner.calls[0]?.command ?? "";
  assert.ok(script.includes("page.waitForEvent('download'"));
  assert.ok(script.includes("saveAs"));
  assert.ok(script.includes("downloadVia"));
  assert.ok(script.includes("CN115690481A"));
});

test("patent_pdf_download: execute rescues fallback items via fetch to ok/http", async () => {
  const runner = new FakeRunner();
  runner.result = { exitCode: 0, stdout: "", stderr: OK_OUTPUT, timedOut: false, durationMs: 1200 };
  const fetchImpl: typeof fetch = async () =>
    // P1-01：写盘前拒绝 <500 字节的响应，mock 内容需超过阈值
    new Response(`%PDF-1.4 fake pdf content ${"x".repeat(600)}`, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
  const outputDir = mkdtempSync(join(tmpdir(), "sati-pdf-dl-rescue-"));
  const tool = createPatentPdfDownloadTool({ session: makeSession(runner), fetchImpl });

  const output = await tool.execute({ patents: ["CN115690481A", "US11739244B2"], outputDir }, makeContext());

  assert.equal(output.data?.summary.ok, 2);
  assert.equal(output.data?.summary.failed, 0);
  assert.equal(output.data?.results[1]?.status, "ok");
  assert.equal(output.data?.results[1]?.method, "http");
  assert.equal(output.data?.results[1]?.pdfUrl, "https://x/US1.pdf");
  assert.ok(output.data?.results[1]?.path?.endsWith("US11739244B2.pdf"));
  // 文件真实落盘
  const target = output.data?.results[1]?.path;
  assert.ok(target && statSync(target).size > 0);
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
