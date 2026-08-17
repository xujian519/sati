/**
 * TASK-P2-03 测试：MANIFEST 断点续传。
 *
 * - 首次执行落盘 .MANIFEST.jsonl（patent/status/path/size/sha1/ts）；
 * - 二次执行 status=ok 且磁盘 size 匹配的专利跳过（method=skip，不发起网络请求）；
 * - 手动修改文件大小 → size 不匹配 → 重新下载；
 * - force=true → 忽略 MANIFEST 全部重下；
 * - 损坏 MANIFEST：整体损坏视为无历史；损坏行容忍，有效行仍生效（按 patent 去重，最后一条 wins）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EgoBrowserSession, type EgoScriptResult } from "../../../src/patent/data/nuo/egoSession.js";
import { createPatentPdfDownloadTool } from "../../../src/tool/builtin/patentPdfDownload.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const PATENT = "CN115690481A";
const CDN_URL = "https://cdn.example.com/patent.pdf";
const PDF_BODY = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2048, 0x41)]);

class MockEgoSession extends EgoBrowserSession {
  scriptCalls = 0;

  override checkAvailability(): { ok: true } {
    return { ok: true };
  }
  override async runScript(): Promise<EgoScriptResult> {
    this.scriptCalls += 1;
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

function makeFetch(callLog: number[]): typeof fetch {
  return (async () => {
    callLog.push(1);
    return new Response(PDF_BODY, { status: 200, headers: { "content-type": "application/pdf" } });
  }) as typeof fetch;
}

/** 执行一次工具调用，返回 { data, session, fetchCalls }。 */
async function runOnce(
  cwd: string,
  fetchCalls: number[],
  force?: boolean,
): Promise<{ session: MockEgoSession; results: Array<{ status: string; method?: string }> }> {
  const session = new MockEgoSession();
  const tool = createPatentPdfDownloadTool({ session, fetchImpl: makeFetch(fetchCalls) });
  const result = await tool.execute({ patents: [PATENT], outputDir: "out", force }, makeContext(cwd));
  return { session, results: (result.data as { results: Array<{ status: string; method?: string }> }).results };
}

test("首次执行：落盘 PDF + 生成 MANIFEST（字段完整）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-manifest-test-"));
  const fetchCalls: number[] = [];
  const { results } = await runOnce(cwd, fetchCalls);

  assert.equal(results[0].status, "ok");
  assert.equal(fetchCalls.length, 1);
  const manifestPath = join(cwd, "out", ".MANIFEST.jsonl");
  assert.ok(existsSync(manifestPath), "应生成 .MANIFEST.jsonl");
  const line = readFileSync(manifestPath, "utf8").trim();
  const entry = JSON.parse(line);
  assert.equal(entry.patent, PATENT);
  assert.equal(entry.status, "ok");
  assert.equal(entry.size, PDF_BODY.length);
  assert.ok(typeof entry.sha1 === "string" && entry.sha1.length === 40, "应记录 sha1");
  assert.ok(typeof entry.ts === "number");
});

test("二次执行：MANIFEST 命中 → method=skip，不发起网络与浏览器请求", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-manifest-test-"));
  const fetchCalls: number[] = [];
  await runOnce(cwd, fetchCalls);
  assert.equal(fetchCalls.length, 1);

  // 第二次执行：同一目录，重新构造 session（统计 runScript 调用）
  const { session, results } = await runOnce(cwd, fetchCalls);
  assert.equal(results[0].status, "ok");
  assert.equal(results[0].method, "skip");
  assert.equal(fetchCalls.length, 1, "命中续传不应再发起 fetch");
  assert.equal(session.scriptCalls, 0, "命中续传不应再调用 ego-browser");
});

test("size 不匹配：手动修改已下载 PDF → 重新下载", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-manifest-test-"));
  const fetchCalls: number[] = [];
  await runOnce(cwd, fetchCalls);

  // 手动改大小（追加内容）
  const onDisk = join(cwd, "out", `${PATENT}.pdf`);
  writeFileSync(onDisk, Buffer.concat([readFileSync(onDisk), Buffer.alloc(10)]));

  const { results } = await runOnce(cwd, fetchCalls);
  assert.equal(results[0].status, "ok");
  assert.equal(results[0].method, "http", "size 不匹配应重新下载");
  assert.equal(fetchCalls.length, 2);
});

test("force=true：忽略 MANIFEST 全部重新下载", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-manifest-test-"));
  const fetchCalls: number[] = [];
  await runOnce(cwd, fetchCalls);

  const { results } = await runOnce(cwd, fetchCalls, true);
  assert.equal(results[0].status, "ok");
  assert.equal(results[0].method, "http", "force 应重新下载");
  assert.equal(fetchCalls.length, 2);
});

test("损坏 MANIFEST：整体损坏（无有效行）视为无历史，全部下载", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-manifest-test-"));
  const outDir = join(cwd, "out");
  mkdirSync(outDir, { recursive: true });
  // 预置全部乱码行
  writeFileSync(join(outDir, ".MANIFEST.jsonl"), "{not json\n|||\n");

  const fetchCalls: number[] = [];
  const { results } = await runOnce(cwd, fetchCalls);
  assert.equal(results[0].status, "ok");
  assert.equal(fetchCalls.length, 1, "整体损坏应重新下载");
});

test("损坏 MANIFEST：单行损坏容忍，有效行仍生效（按 patent 去重，最后一条 wins）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-manifest-test-"));
  const outDir = join(cwd, "out");
  mkdirSync(outDir, { recursive: true });
  // 乱码行 + 两条同 patent 记录（旧 size 与新 size）——最后一条 wins
  const oldEntry = JSON.stringify({ patent: PATENT, status: "ok", path: "/nowhere/x.pdf", size: 1, ts: 1 });
  const newEntry = JSON.stringify({ patent: PATENT, status: "ok", path: "/nowhere/y.pdf", size: 999, ts: 2 });
  writeFileSync(join(outDir, ".MANIFEST.jsonl"), `garbage line\n${oldEntry}\n${newEntry}\n`);

  // path 指向 /nowhere（不存在）→ size 匹配失败 → 应重新下载
  const fetchCalls: number[] = [];
  const { results } = await runOnce(cwd, fetchCalls);
  assert.equal(results[0].status, "ok");
  assert.equal(fetchCalls.length, 1, "损坏行被容忍且最后一条生效后 size 不匹配 → 重新下载");
});

test("损坏 MANIFEST：有效行命中真实文件 → 跳过", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-manifest-test-"));
  const outDir = join(cwd, "out");
  // 先正常下载一次，再在 manifest 前塞乱码行（append 后乱码行在前）
  const fetchCalls: number[] = [];
  await runOnce(cwd, fetchCalls);
  const manifestPath = join(outDir, ".MANIFEST.jsonl");
  const original = readFileSync(manifestPath, "utf8");
  writeFileSync(manifestPath, "garbage line\n" + original);

  const { results } = await runOnce(cwd, fetchCalls);
  assert.equal(results[0].status, "ok");
  assert.equal(results[0].method, "skip", "乱码行不应影响有效行续传");
  assert.equal(fetchCalls.length, 1, "命中续传不应再发起 fetch");
});
