/**
 * TASK-P3-04 测试：e2e 覆盖下载通道 4 条主路径。
 *
 * 用 CreatePatentPdfDownloadToolOptions 注入 mock session + fetchImpl（不引入 nock）：
 * 1. ok                — browser 拦截成功，原样升格，fetch 不被调用；
 * 2. fallback+fetch 成功 — browser 不可用 → http 兜底落盘，内容一致；
 * 3. fallback+fetch 失败 — browser 不可用 + http 403 → failed，无 .pdf；
 * 4. 魔数错误            — browser 不可用 + http 返回非 PDF → failed（invalid PDF magic）。
 *
 * 每条路径断言 execute 全链路产物：summary 计数、results 字段（status/method/error）、
 * workspace 落盘状态（成功有 .pdf、失败无 .pdf/.tmp 残留）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
const PDF_BODY = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2048, 0x41)]);

/** mock session：runScript 返回预构造脚本条目，其余走真实实现。 */
class MockEgoSession extends EgoBrowserSession {
  private readonly scriptItems: unknown[];
  constructor(scriptItems: unknown[]) {
    super();
    this.scriptItems = scriptItems;
  }
  override checkAvailability(): { ok: true } {
    return { ok: true };
  }
  override async runScript(): Promise<EgoScriptResult> {
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

async function runTool(cwd: string, scriptItems: unknown[], fetchImpl: typeof fetch): Promise<PatentPdfDownloadOutput> {
  const tool = createPatentPdfDownloadTool({
    session: new MockEgoSession(scriptItems),
    fetchImpl,
  });
  const result = await tool.execute({ patents: [PATENT], outputDir: "out" }, makeContext(cwd));
  const data = result.data;
  assert.ok(data, "data 应存在");
  return data;
}

function assertNoArtifacts(cwd: string): void {
  const dir = join(cwd, "out");
  assert.equal(existsSync(join(dir, `${PATENT}.pdf`)), false, "不应有 .pdf 落盘");
  if (existsSync(dir)) {
    assert.deepEqual(
      readdirSync(dir).filter(f => f.endsWith(".tmp")),
      [],
      "不应有 .tmp 残留",
    );
  }
}

test("ok 通道：browser 拦截成功原样升格，fetch 不被调用", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-e2e-ok-"));
  const browserPath = join(cwd, "out", `${PATENT}.pdf`);
  mkdirSync(join(cwd, "out"), { recursive: true });
  writeFileSync(browserPath, PDF_BODY);

  const data = await runTool(cwd, [{ patent: PATENT, status: "ok", path: browserPath, pdfUrl: CDN_URL }], async () => {
    throw new Error("ok 通道不应触发 fetch 兜底");
  });

  assert.equal(data.summary.total, 1);
  assert.equal(data.summary.ok, 1);
  assert.equal(data.summary.failed, 0);
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].status, "ok");
  assert.equal(data.results[0].method, "browser");
  assert.equal(data.results[0].path, browserPath);
});

test("fallback 通道：fetch 兜底成功，http 落盘内容与响应体一致", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-e2e-fallback-ok-"));
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return new Response(PDF_BODY, { status: 200, headers: { "content-type": "application/pdf" } });
  };

  const data = await runTool(cwd, [{ patent: PATENT, status: "fallback", pdfUrl: CDN_URL, error: "mock" }], fetchImpl);

  assert.equal(fetchCalls, 1, "fetch 兜底应被调用一次");
  assert.equal(data.summary.ok, 1);
  assert.equal(data.summary.failed, 0);
  assert.equal(data.results[0].status, "ok");
  assert.equal(data.results[0].method, "http");
  assert.deepEqual(readFileSync(join(cwd, "out", `${PATENT}.pdf`)), PDF_BODY, "落盘内容与响应体一致");
});

test("fallback 通道：fetch 兜底失败（403），failed + 无落盘", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-e2e-fallback-403-"));
  const fetchImpl = async () =>
    new Response("<html>403 Forbidden</html>", { status: 403, headers: { "content-type": "text/html" } });

  const data = await runTool(cwd, [{ patent: PATENT, status: "fallback", pdfUrl: CDN_URL, error: "mock" }], fetchImpl);

  assert.equal(data.summary.total, 1);
  assert.equal(data.summary.ok, 0);
  assert.equal(data.summary.failed, 1);
  assert.equal(data.results[0].status, "failed");
  assert.match(data.results[0].error ?? "", /HTTP 403/);
  assert.equal(data.results[0].pdfUrl, CDN_URL, "失败时保留 pdfUrl 供手动重试");
  assertNoArtifacts(cwd);
});

test("fallback 通道：fetch 返回非 PDF（魔数错误），failed + 无落盘", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-e2e-badmagic-"));
  const badBody = Buffer.alloc(2000, 0x42); // 足够长但非 %PDF-
  const fetchImpl = async () =>
    new Response(badBody, { status: 200, headers: { "content-type": "application/octet-stream" } });

  const data = await runTool(cwd, [{ patent: PATENT, status: "fallback", pdfUrl: CDN_URL, error: "mock" }], fetchImpl);

  assert.equal(data.summary.failed, 1);
  assert.equal(data.results[0].status, "failed");
  assert.match(data.results[0].error ?? "", /invalid PDF magic/);
  assertNoArtifacts(cwd);
});

test("fallback 无 pdfUrl：直接 failed，透传脚本侧 error（不发起 fetch）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-e2e-nourl-"));
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error("不应调用 fetch");
  };

  const data = await runTool(cwd, [{ patent: PATENT, status: "fallback", error: "link extraction failed" }], fetchImpl);

  assert.equal(fetchCalls, 0, "无 pdfUrl 不应发起 fetch");
  assert.equal(data.summary.failed, 1);
  assert.equal(data.results[0].status, "failed");
  assert.equal(data.results[0].error, "link extraction failed");
  assertNoArtifacts(cwd);
});

test("fallback 兜底：流式总量 <500 字节（魔数合法但过短），failed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-e2e-toosmall-"));
  // 首块含合法魔数、但整体 < MIN_PDF_BYTES(500)：通过魔数校验后总量校验拒绝
  const shortBody = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(100, 0x41)]);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(shortBody));
      controller.close();
    },
  });
  const fetchImpl = async () =>
    new Response(body as unknown as BodyInit, { status: 200, headers: { "content-type": "application/pdf" } });

  const data = await runTool(cwd, [{ patent: PATENT, status: "fallback", pdfUrl: CDN_URL, error: "mock" }], fetchImpl);

  assert.equal(data.summary.failed, 1);
  assert.equal(data.results[0].status, "failed");
  assert.match(data.results[0].error ?? "", /response too small \(109 bytes\)/);
  assertNoArtifacts(cwd);
});

test("fallback 兜底：空流 body（读即 done），failed + 无落盘", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-e2e-emptystream-"));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  const fetchImpl = async () =>
    new Response(body as unknown as BodyInit, { status: 200, headers: { "content-type": "application/pdf" } });

  const data = await runTool(cwd, [{ patent: PATENT, status: "fallback", pdfUrl: CDN_URL, error: "mock" }], fetchImpl);

  assert.equal(data.summary.failed, 1);
  assert.equal(data.results[0].status, "failed");
  assert.match(data.results[0].error ?? "", /response too small \(0 bytes\)/);
  assertNoArtifacts(cwd);
});

test("fallback 兜底失败：脚本侧无 error 时，错误信息以 fetch fallback failed 开头", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-e2e-noerr-"));
  const fetchImpl = async () =>
    new Response("<html>403 Forbidden</html>", { status: 403, headers: { "content-type": "text/html" } });

  // 脚本侧条目不带 error 字段（下载拦截不可用且未附加说明）
  const data = await runTool(cwd, [{ patent: PATENT, status: "fallback", pdfUrl: CDN_URL }], fetchImpl);

  assert.equal(data.summary.failed, 1);
  assert.equal(data.results[0].status, "failed");
  assert.match(data.results[0].error ?? "", /^fetch fallback failed: HTTP 403/);
  assertNoArtifacts(cwd);
});

test("fallback 兜底失败：fetch 抛非 Error 值（字符串）也能归一到 failed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-e2e-nonerror-"));
  // 网络层透传的异常可能是任意类型（fetchImpl 抛字符串），String() 归一
  const fetchImpl = async () => {
    throw "boom-string";
  };

  const data = await runTool(cwd, [{ patent: PATENT, status: "fallback", pdfUrl: CDN_URL, error: "mock" }], fetchImpl);

  assert.equal(data.summary.failed, 1);
  assert.equal(data.results[0].status, "failed");
  assert.equal(data.results[0].error, "mock; fetch fallback failed: boom-string");
  assertNoArtifacts(cwd);
});
