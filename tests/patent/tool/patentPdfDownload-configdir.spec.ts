/**
 * TASK-P2-05 测试：全局下载目录（patents.downloadDir）优先级。
 *
 * 优先级：入参 outputDir > config.patents.downloadDir > 旧规则 <cwd>/专利原文/YYYY-MM-DD。
 * 配置经 patentsConfigProvider 注入（runtime-live：每次执行时读取）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { EgoBrowserSession, type EgoScriptResult } from "../../../src/patent/data/nuo/egoSession.js";
import {
  createPatentPdfDownloadTool,
  type PatentPdfDownloadOutput,
} from "../../../src/tool/builtin/patentPdfDownload.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const PATENT = "CN115690481A";
const CDN_URL = "https://cdn.example.com/patent.pdf";
const PDF_BODY = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2048, 0x41)]);

class MockEgoSession extends EgoBrowserSession {
  override checkAvailability(): { ok: true } {
    return { ok: true };
  }
  override async runScript(): Promise<EgoScriptResult> {
    return {
      output: `EGO_DOWNLOAD_RESULTS:${JSON.stringify([
        { patent: PATENT, status: "fallback", pdfUrl: CDN_URL, error: "mock" },
      ])}`,
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 5,
    };
  }
}

function makeContext(cwd: string): SatiToolRuntimeContext {
  return {
    cwd,
    env: process.env,
    abortSignal: new AbortController().signal,
    sessionId: "test-session",
  } as unknown as SatiToolRuntimeContext;
}

/** 今天的日期子目录（与 resolveOutputDir 同规则）。 */
function datePart(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function runTool(
  cwd: string,
  options: { outputDir?: string; downloadDir?: string } = {},
): Promise<{ data: PatentPdfDownloadOutput; onDisk: string }> {
  const fetchImpl = async () => new Response(PDF_BODY, { status: 200, headers: { "content-type": "application/pdf" } });
  const tool = createPatentPdfDownloadTool({
    session: new MockEgoSession(),
    fetchImpl,
    ...(options.downloadDir !== undefined
      ? { patentsConfigProvider: () => ({ downloadDir: options.downloadDir }) }
      : {}),
  });
  const result = await tool.execute(
    { patents: [PATENT], ...(options.outputDir !== undefined ? { outputDir: options.outputDir } : {}) },
    makeContext(cwd),
  );
  const data = result.data as PatentPdfDownloadOutput;
  return { data, onDisk: join(data.outputDir, `${PATENT}.pdf`) };
}

test("未配置：回退旧规则 <cwd>/专利原文/YYYY-MM-DD", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-configdir-test-"));

  const { data, onDisk } = await runTool(cwd);

  assert.equal(data.outputDir, resolve(cwd, "专利原文", datePart()));
  assert.ok(existsSync(onDisk), "文件应落在默认目录");
});

test("配置 downloadDir：落到 <downloadDir>/YYYY-MM-DD（仍追加日期子目录）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-configdir-test-"));
  const downloadDir = mkdtempSync(join(tmpdir(), "pdf-global-"));
  const expected = resolve(downloadDir, datePart());

  const { data, onDisk } = await runTool(cwd, { downloadDir });

  assert.equal(data.outputDir, expected);
  assert.ok(existsSync(onDisk), "文件应落在全局配置目录");
});

test("配置 downloadDir 含 ~/ 前缀：展开到 $HOME（review#1）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-configdir-test-"));
  const expected = resolve(homedir(), "pdf-tilde-test", datePart());

  const { data, onDisk } = await runTool(cwd, { downloadDir: "~/pdf-tilde-test" });

  assert.equal(data.outputDir, expected);
  assert.ok(existsSync(onDisk), "文件应落在 $HOME 展开后的目录");
});

test("优先级：入参 outputDir 覆盖配置 downloadDir", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-configdir-test-"));
  const downloadDir = mkdtempSync(join(tmpdir(), "pdf-global-"));
  const explicitOut = "explicit-out";

  const { data, onDisk } = await runTool(cwd, { downloadDir, outputDir: explicitOut });

  assert.equal(data.outputDir, resolve(cwd, explicitOut));
  assert.ok(existsSync(onDisk), "文件应落在入参目录");
});

test("配置在每次执行时读取（provider 每次调用）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-configdir-test-"));
  let providerCalls = 0;
  const fetchImpl = async () => new Response(PDF_BODY, { status: 200, headers: { "content-type": "application/pdf" } });
  const tool = createPatentPdfDownloadTool({
    session: new MockEgoSession(),
    fetchImpl,
    patentsConfigProvider: () => {
      providerCalls += 1;
      return undefined;
    },
  });

  const result = await tool.execute({ patents: [PATENT] }, makeContext(cwd));
  const data = result.data as PatentPdfDownloadOutput;

  assert.ok(providerCalls >= 1, "execute 时应读取配置");
  assert.equal(data.outputDir, resolve(cwd, "专利原文", datePart()));
});
