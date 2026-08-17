/**
 * TASK-P2-02 测试：fetch 兜底下载的指数退避重试。
 *
 * 复用 networkFetch 内置重试（retry 选项）：HTTP 408/409/425/429/5xx 与
 * 网络错误重试至多 3 次；404/403 与魔数错误属确定性失败，不重试。
 *
 * mock 响应带 `Retry-After: 0` 头让退避延迟归零（networkFetch 优先采用
 * retry-after），用例瞬时完成；fetchImpl 计数断言实际调用次数。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EgoBrowserSession, type EgoScriptResult } from "../../../src/patent/data/nuo/egoSession.js";
import { createPatentPdfDownloadTool } from "../../../src/tool/builtin/patentPdfDownload.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const PATENT = "CN115690481A";
const CDN_URL = "https://cdn.example.com/patent.pdf";

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

/** 构造第 n 次失败、之后成功的 mock fetch；返回调用计数。 */
function makeFetchWithRetries(status: number, failCount: number): { fetchImpl: typeof fetch; callCount: () => number } {
  let calls = 0;
  const pdfBody = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2048, 0x41)]);
  const fetchImpl = (async () => {
    calls += 1;
    if (calls <= failCount) {
      // Retry-After: 0 → networkFetch 退避延迟归零，测试瞬时完成
      return new Response("", { status, headers: { "retry-after": "0" } });
    }
    return new Response(pdfBody, { status: 200, headers: { "content-type": "application/pdf" } });
  }) as typeof fetch;
  return { fetchImpl, callCount: () => calls };
}

/** 执行一次工具调用（fetch 兜底），返回条目。 */
async function runTool(cwd: string, fetchImpl: typeof fetch): Promise<{ status: string; error?: string }> {
  const tool = createPatentPdfDownloadTool({ session: new MockEgoSession(), fetchImpl });
  const result = await tool.execute({ patents: [PATENT], outputDir: "out" }, makeContext(cwd));
  const item = (result.data as { results: Array<{ status: string; error?: string }> }).results[0];
  return item;
}

test("重试：502 后 200 重试成功（fetch 调用 2 次，method=http）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-retry-test-"));
  const { fetchImpl, callCount } = makeFetchWithRetries(502, 1);

  const item = await runTool(cwd, fetchImpl);
  assert.equal(item.status, "ok");
  assert.equal(callCount(), 2, "502 后应重试一次");
  // 落盘内容为最终成功响应
  const onDisk = readFileSync(join(cwd, "out", `${PATENT}.pdf`));
  assert.ok(onDisk.subarray(0, 5).toString() === "%PDF-");
});

test("重试：404 立即失败，不重试（fetch 调用 1 次）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-retry-test-"));
  const { fetchImpl, callCount } = makeFetchWithRetries(404, 100);

  const item = await runTool(cwd, fetchImpl);
  assert.equal(item.status, "failed");
  assert.equal(callCount(), 1, "404 属确定性失败，不应重试");
  assert.match(item.error ?? "", /HTTP 404/);
});

test("重试：连续 502 三次全部失败（fetch 调用 3 次）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-retry-test-"));
  const { fetchImpl, callCount } = makeFetchWithRetries(502, 100);

  const item = await runTool(cwd, fetchImpl);
  assert.equal(item.status, "failed");
  assert.equal(callCount(), 3, "最多 3 次尝试后放弃");
  assert.match(item.error ?? "", /HTTP 502/);
});

test("重试：网络异常（抛 TypeError，如 ECONNRESET 归一化）也会重试后成功", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-retry-test-"));
  let calls = 0;
  const pdfBody = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2048, 0x41)]);
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed: ECONNRESET");
    return new Response(pdfBody, { status: 200, headers: { "content-type": "application/pdf" } });
  }) as typeof fetch;

  const item = await runTool(cwd, fetchImpl);
  assert.equal(item.status, "ok");
  assert.equal(calls, 2, "网络错误应重试一次");
});
