/**
 * TASK-P1-01 测试：fetch 兜底下载的 PDF 魔数校验 + 原子写盘。
 *
 * 通过 createPatentPdfDownloadTool 的测试缝注入：
 * - session: 继承 EgoBrowserSession 的 mock，runScript 返回固定 fallback 条目
 *   （EGO_DOWNLOAD_RESULTS 标记，extractTaggedJson 用真实实现解析）；
 * - fetchImpl: 注入 mock fetch，构造 403 HTML / 正常 PDF / 空响应 / 错误页各分支。
 *
 * 断言：拒绝的分支 status=failed 且 workspace 无 .pdf / .tmp 残留；
 * 成功的分支落盘内容与响应体完全一致。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EgoBrowserSession, type EgoScriptResult } from "../../../src/patent/data/nuo/egoSession.js";
import {
  createPatentPdfDownloadTool,
  type PatentPdfDownloadOutput,
} from "../../../src/tool/builtin/patentPdfDownload.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const PATENT = "CN115690481A";
const CDN_URL = "https://cdn.example.com/patent.pdf";

/** mock session：runScript 返回预先构造的 fallback 条目，其余走真实实现。 */
class MockEgoSession extends EgoBrowserSession {
  private readonly scriptItems: unknown[];

  constructor(scriptItems: unknown[]) {
    super();
    this.scriptItems = scriptItems;
  }
  override checkAvailability(): { ok: true } {
    return { ok: true };
  }
  // ensureDir 用父类真实实现（mkdirSync recursive），保证输出目录存在
  override async runScript(): Promise<EgoScriptResult> {
    // 模拟 ego-browser cliLog 的裸标记行输出：EGO_DOWNLOAD_RESULTS:<json>
    return {
      output: `EGO_DOWNLOAD_RESULTS:${JSON.stringify(this.scriptItems)}`,
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

/** 执行一次工具调用，返回 output.data。 */
async function runTool(
  cwd: string,
  fetchImpl: typeof fetch,
  scriptItems: unknown[] = [{ patent: PATENT, status: "fallback", pdfUrl: CDN_URL, error: "mock" }],
): Promise<PatentPdfDownloadOutput> {
  const tool = createPatentPdfDownloadTool({
    session: new MockEgoSession(scriptItems),
    fetchImpl,
  });
  const result = await tool.execute({ patents: [PATENT], outputDir: "out" }, makeContext(cwd));
  return result.data as PatentPdfDownloadOutput;
}

test("fetch 兜底：403 HTML 错误页被拒绝（status=failed，无 .pdf 落盘）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-fallback-test-"));
  const fetchImpl = async () =>
    new Response("<html>403 Forbidden</html>", { status: 403, headers: { "content-type": "text/html" } });

  const data = await runTool(cwd, fetchImpl);
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].status, "failed");
  assert.match(data.results[0].error ?? "", /HTTP 403/);
  assert.equal(existsSync(join(cwd, "out", `${PATENT}.pdf`)), false);
  assert.equal(existsSync(join(cwd, "out", `${PATENT}.pdf.tmp`)), false);
});

test("fetch 兜底：200 + text/html 响应头被拒绝（宽松策略的拒绝侧）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-fallback-test-"));
  const htmlBody = "<html>bot check page</html>" + "x".repeat(2000);
  const fetchImpl = async () =>
    new Response(htmlBody, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

  const data = await runTool(cwd, fetchImpl);
  assert.equal(data.results[0].status, "failed");
  assert.match(data.results[0].error ?? "", /Content-Type: text\/html/);
  assert.equal(existsSync(join(cwd, "out", `${PATENT}.pdf`)), false);
});

test("fetch 兜底：正常 PDF 魔数校验通过并成功落盘（内容一致）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-fallback-test-"));
  const pdfBody = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2048, 0x41)]);
  const fetchImpl = async () => new Response(pdfBody, { status: 200, headers: { "content-type": "application/pdf" } });

  const data = await runTool(cwd, fetchImpl);
  assert.equal(data.results[0].status, "ok");
  assert.equal(data.results[0].method, "http");
  const onDisk = readFileSync(join(cwd, "out", `${PATENT}.pdf`));
  assert.deepEqual(onDisk, pdfBody);
  // 无 .tmp 残留
  assert.deepEqual(
    readdirSync(join(cwd, "out")).filter(f => f.endsWith(".tmp")),
    [],
  );
});

test("fetch 兜底：空响应被拒绝（too small）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-fallback-test-"));
  const fetchImpl = async () => new Response(null, { status: 200 });

  const data = await runTool(cwd, fetchImpl);
  assert.equal(data.results[0].status, "failed");
  assert.match(data.results[0].error ?? "", /too small/);
  assert.equal(existsSync(join(cwd, "out", `${PATENT}.pdf`)), false);
});

test("fetch 兜底：非 PDF 内容（魔数错误）被拒绝", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-fallback-test-"));
  const badBody = Buffer.alloc(2000, 0x42); // 足够长但非 %PDF-
  const fetchImpl = async () =>
    new Response(badBody, { status: 200, headers: { "content-type": "application/octet-stream" } });

  const data = await runTool(cwd, fetchImpl);
  assert.equal(data.results[0].status, "failed");
  assert.match(data.results[0].error ?? "", /invalid PDF magic/);
  assert.equal(existsSync(join(cwd, "out", `${PATENT}.pdf`)), false);
  assert.equal(existsSync(join(cwd, "out", `${PATENT}.pdf.tmp`)), false);
});

test("fetch 兜底：分块流式 body 落盘内容完整（P2-04 多 chunk 拼接一致）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-fallback-test-"));
  const chunks = [
    Buffer.from("%PDF-1.7\n"),
    Buffer.alloc(1024, 0x41),
    Buffer.alloc(1024, 0x42),
    Buffer.alloc(512, 0x43),
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new Uint8Array(c));
      controller.close();
    },
  });
  const fetchImpl = async () =>
    new Response(body as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });

  const data = await runTool(cwd, fetchImpl);
  assert.equal(data.results[0].status, "ok");
  const onDisk = readFileSync(join(cwd, "out", `${PATENT}.pdf`));
  assert.deepEqual(onDisk, Buffer.concat(chunks));
});

test("fetch 兜底：browser 拦截成功的条目原样升格 ok（不受校验影响）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-fallback-test-"));
  const fetchImpl = async () => {
    throw new Error("should not be called");
  };

  const data = await runTool(cwd, fetchImpl, [
    { patent: PATENT, status: "ok", path: "/tmp/whatever.pdf", pdfUrl: CDN_URL },
  ]);
  assert.equal(data.results[0].status, "ok");
  assert.equal(data.results[0].method, "browser");
});
