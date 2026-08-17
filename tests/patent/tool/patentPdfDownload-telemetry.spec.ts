/**
 * TASK-P3-02 测试：下载成功率 JSONL 埋点。
 *
 * - 批次结束后 <APP_HOME|~/.sati>/logs/patent-download.jsonl 追加一行合法 JSON；
 * - 字段契约：ts/total/ok/failed/perPatent[{num,status,method,durationMs,errorCode}]/clientVersion；
 * - 混合结果（ok+failed）计数正确，http 路径带 durationMs；
 * - 全部 MANIFEST 命中（早退分支）同样埋点；
 * - 埋点失败静默（不可写目录不阻断下载结果）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EgoBrowserSession, type EgoScriptResult } from "../../../src/patent/data/nuo/egoSession.js";
import {
  createPatentPdfDownloadTool,
  type PatentPdfDownloadOutput,
} from "../../../src/tool/builtin/patentPdfDownload.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const PATENT_A = "CN115690481A";
const PATENT_B = "CN115690482B";
const CDN_URL = "https://cdn.example.com/patent.pdf";
const PDF_BODY = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(1024, 0x41)]);

class MockEgoSession extends EgoBrowserSession {
  items: Array<{ patent: string; status: string; pdfUrl?: string; error?: string }>;
  constructor(items: Array<{ patent: string; status: string; pdfUrl?: string; error?: string }>) {
    super();
    this.items = items;
  }
  override checkAvailability(): { ok: true } {
    return { ok: true };
  }
  override async runScript(): Promise<EgoScriptResult> {
    return {
      output: `EGO_DOWNLOAD_RESULTS:${JSON.stringify(this.items)}`,
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 5,
    };
  }
}

function makeContext(cwd: string, env: NodeJS.ProcessEnv): SatiToolRuntimeContext {
  return {
    cwd,
    env,
    abortSignal: new AbortController().signal,
    sessionId: "test-session",
  } as unknown as SatiToolRuntimeContext;
}

/** 生成隔离的 APP_HOME 临时目录，返回 { env, home, logPath }。 */
function isolateHome(): { env: NodeJS.ProcessEnv; home: string; logPath: string } {
  const home = mkdtempSync(join(tmpdir(), "pdf-telemetry-home-"));
  const env = { ...process.env, APP_HOME: home };
  return { env, home, logPath: join(home, "logs", "patent-download.jsonl") };
}

function readLogLines(logPath: string): unknown[] {
  assert.ok(existsSync(logPath), "埋点文件应存在");
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as unknown);
}

function stripResultData(result: { data?: PatentPdfDownloadOutput }): PatentPdfDownloadOutput {
  assert.ok(result.data, "data 应存在");
  return result.data;
}

test("批次结束追加一行合法 JSON，字段契约完整", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-telemetry-cwd-"));
  const { env, logPath } = isolateHome();
  const fetchImpl = async () => new Response(PDF_BODY, { status: 200, headers: { "content-type": "application/pdf" } });
  const tool = createPatentPdfDownloadTool({
    session: new MockEgoSession([
      { patent: PATENT_A, status: "fallback", pdfUrl: CDN_URL, error: "mock" },
      { patent: PATENT_B, status: "fallback", pdfUrl: CDN_URL, error: "mock" },
    ]),
    fetchImpl,
  });

  const result = await tool.execute({ patents: [PATENT_A, PATENT_B] }, makeContext(cwd, env));
  const summary = stripResultData(result).summary;
  assert.equal(summary.ok, 2);

  const lines = readLogLines(logPath);
  assert.equal(lines.length, 1, "每次批次结束只追加一行");
  const entry = lines[0] as Record<string, unknown>;
  assert.equal(typeof entry.ts, "number");
  assert.equal(entry.total, 2);
  assert.equal(entry.ok, 2);
  assert.equal(entry.failed, 0);
  assert.equal(typeof entry.clientVersion, "string");
  assert.ok(entry.clientVersion && (entry.clientVersion as string).length > 0, "clientVersion 非空");
  const perPatent = entry.perPatent as Array<Record<string, unknown>>;
  assert.equal(perPatent.length, 2);
  for (const p of perPatent) {
    assert.equal(p.status, "ok");
    assert.equal(p.method, "http");
    assert.equal(typeof p.durationMs, "number", "http 路径应带 durationMs");
    assert.equal(p.errorCode, undefined);
  }
});

test("混合结果：ok/failed 计数正确，失败条目带 errorCode", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-telemetry-cwd-"));
  const { env, logPath } = isolateHome();
  const fetchImpl = async (url: string | URL | Request) =>
    String(url).includes("missing")
      ? new Response("<!doctype html><p>error</p>", { status: 403 })
      : new Response(PDF_BODY, { status: 200, headers: { "content-type": "application/pdf" } });
  const tool = createPatentPdfDownloadTool({
    session: new MockEgoSession([
      { patent: PATENT_A, status: "fallback", pdfUrl: CDN_URL, error: "mock" },
      { patent: PATENT_B, status: "fallback", pdfUrl: "https://cdn.example.com/missing.pdf", error: "mock" },
    ]),
    fetchImpl,
  });

  await tool.execute({ patents: [PATENT_A, PATENT_B] }, makeContext(cwd, env));

  const entry = readLogLines(logPath)[0] as Record<string, unknown>;
  assert.equal(entry.ok, 1);
  assert.equal(entry.failed, 1);
  const perPatent = entry.perPatent as Array<Record<string, unknown>>;
  const failed = perPatent.find(p => p.num === PATENT_B);
  assert.ok(failed && typeof failed.errorCode === "string" && (failed.errorCode as string).length > 0);
});

test("全部 MANIFEST 命中（早退分支）同样埋点", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-telemetry-cwd-"));
  const { env, logPath } = isolateHome();
  // 第一次执行落盘 → 第二次全命中 MANIFEST 走早退分支
  const fetchImpl = async () => new Response(PDF_BODY, { status: 200, headers: { "content-type": "application/pdf" } });
  const tool = createPatentPdfDownloadTool({
    session: new MockEgoSession([{ patent: PATENT_A, status: "fallback", pdfUrl: CDN_URL, error: "mock" }]),
    fetchImpl,
  });
  await tool.execute({ patents: [PATENT_A] }, makeContext(cwd, env));
  await tool.execute({ patents: [PATENT_A] }, makeContext(cwd, env));

  const lines = readLogLines(logPath);
  assert.equal(lines.length, 2, "两次批次各一行");
  const second = lines[1] as Record<string, unknown>;
  assert.equal(second.total, 1);
  assert.equal(second.ok, 1);
  const perPatent = second.perPatent as Array<Record<string, unknown>>;
  assert.equal(perPatent[0]?.method, "skip");
});

test("埋点失败静默：不可写日志目录不阻断下载结果", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdf-telemetry-cwd-"));
  const { env } = isolateHome();
  const fetchImpl = async () => new Response(PDF_BODY, { status: 200, headers: { "content-type": "application/pdf" } });
  const tool = createPatentPdfDownloadTool({
    session: new MockEgoSession([{ patent: PATENT_A, status: "fallback", pdfUrl: CDN_URL, error: "mock" }]),
    fetchImpl,
  });
  // APP_HOME 指向一个已存在的"文件"（mkdir logs 会失败）
  const blockedHome = join(tmpdir(), "pdf-telemetry-blocked");
  const envBlocked = { ...env, APP_HOME: blockedHome };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(blockedHome, "not a directory");

  const result = await tool.execute({ patents: [PATENT_A] }, makeContext(cwd, envBlocked));
  const summary = stripResultData(result).summary;
  assert.equal(summary.ok, 1, "埋点失败不应阻断下载");
});
