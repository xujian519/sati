/**
 * TASK-P2-07 测试：PDF 链接提取 JS 单一事实源一致性。
 *
 * - assets/patent/pdf-link-extract.js 存在且首行版本标记格式正确；
 * - 文件满足 String.raw 嵌入约束（无反引号、无 ${）；
 * - TS 内嵌备份（patentPdfDownload.ts PDF_LINK_EXTRACT_JS）与文件 IIFE 主体逐字符一致；
 * - Python 内嵌备份（download_patent_ego.py）与文件 IIFE 主体逐字符一致；
 * - 集成：生成脚本热加载文件内容（含版本标记行，证明来自文件而非备份）。
 *
 * 读源码的断言在 dist 产物模式（node --test dist/tests/...，build 不复制源码）下
 * 跳过；资产文件与集成断言两种模式均可跑（build 已拷贝 assets/patent）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { EgoBrowserSession, type EgoScriptResult } from "../../../src/patent/data/nuo/egoSession.js";
import { createPatentPdfDownloadTool } from "../../../src/tool/builtin/patentPdfDownload.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const here = dirname(fileURLToPath(import.meta.url));

/** 候选根：源码态（tests/patent/tool/ 上溯 3 级）与 dist 态（上溯 4 级）。 */
const ROOTS = [join(here, "..", "..", ".."), join(here, "..", "..", "..", "..")];

function findRepoFile(rel: string): string | undefined {
  for (const root of ROOTS) {
    const candidate = join(root, rel);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const EXTRACT_JS_REL = "assets/patent/pdf-link-extract.js";

function readExtractJs(): string {
  const path = findRepoFile(EXTRACT_JS_REL);
  assert.ok(path, "pdf-link-extract.js 应存在");
  // CRLF 检出（Windows autocrlf）不影响内容语义：统一为 LF 再断言
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/** 去掉头部注释行后的 IIFE 主体（与两端内嵌备份比对用）。 */
function extractIife(source: string): string {
  const lines = source.split("\n");
  const bodyStart = lines.findIndex(l => l.startsWith("(() => {"));
  assert.ok(bodyStart !== -1, "文件应包含 IIFE 主体");
  return lines.slice(bodyStart).join("\n").replace(/\n$/, "");
}

test("单一事实源文件：存在、版本标记、IIFE 结构与嵌入约束", () => {
  const source = readExtractJs();

  assert.match(source, /^\/\/ PDF_LINK_EXTRACT_VERSION=\d+\n/, "首行应为版本标记");
  assert.ok(source.includes("(() => {"), "应包含 IIFE 开头");
  assert.ok(source.includes("})()"), "应包含 IIFE 结尾");
  assert.ok(!source.includes("`"), "不得包含反引号（String.raw 嵌入约束）");
  assert.ok(!source.includes("${"), "不得包含 ${（String.raw 嵌入约束）");
});

test("TS 内嵌备份与文件 IIFE 主体逐字符一致", t => {
  const tsPath = findRepoFile("src/tool/builtin/patentPdfDownload.ts");
  if (!tsPath) {
    t.skip("dist 产物不含源码，跳过一致性断言");
    return;
  }
  // Windows autocrlf 检出为 CRLF：与文件侧统一为 LF 再逐字符比对
  const tsSource = readFileSync(tsPath, "utf8").replace(/\r\n/g, "\n");
  const match = /const PDF_LINK_EXTRACT_JS = String\.raw`([\s\S]*?)`;/.exec(tsSource);
  assert.ok(match, "应找到 PDF_LINK_EXTRACT_JS 常量");

  assert.equal(match[1], extractIife(readExtractJs()), "TS 备份应与文件 IIFE 主体一致");
});

test("Python 内嵌备份与文件 IIFE 主体逐字符一致", t => {
  const pyPath = findRepoFile("skills/patent-download/scripts/download_patent_ego.py");
  if (!pyPath) {
    t.skip("dist 产物不含 Python 源码，跳过一致性断言");
    return;
  }
  // Windows autocrlf 检出为 CRLF：与文件侧统一为 LF 再逐字符比对
  const pySource = readFileSync(pyPath, "utf8").replace(/\r\n/g, "\n");
  const match = /_PDF_LINK_EXTRACT_JS_BACKUP = '''([\s\S]*?)'''/.exec(pySource);
  assert.ok(match, "应找到 _PDF_LINK_EXTRACT_JS_BACKUP 常量");

  assert.equal(match[1], extractIife(readExtractJs()), "Python 备份应与文件 IIFE 主体一致");
});

const PATENT = "CN115690481A";
const PDF_BODY = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(1024, 0x41)]);

class CapturingEgoSession extends EgoBrowserSession {
  captured: string[] = [];
  override checkAvailability(): { ok: true } {
    return { ok: true };
  }
  override async runScript(script: string): Promise<EgoScriptResult> {
    this.captured.push(script);
    return {
      output: `EGO_DOWNLOAD_RESULTS:${JSON.stringify([
        { patent: PATENT, status: "fallback", pdfUrl: "https://cdn.example.com/patent.pdf", error: "mock" },
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

test("集成：生成脚本热加载文件内容（含版本标记行）", async () => {
  // 临时 cwd 避免命中 /tmp 下残留 MANIFEST 的断点续传早退分支。
  const cwd = mkdtempSync(join(tmpdir(), "pdf-extractjs-test-"));
  const session = new CapturingEgoSession();
  const fetchImpl = async () => new Response(PDF_BODY, { status: 200, headers: { "content-type": "application/pdf" } });
  const tool = createPatentPdfDownloadTool({ session, fetchImpl });

  await tool.execute({ patents: [PATENT] }, makeContext(cwd));

  assert.ok(session.captured.length > 0, "应执行至少一次 ego 脚本");
  // 热加载的是磁盘原始内容（Windows CRLF 检出）；与 LF 化的 IIFE 主体比对前统一换行。
  const downloadScript = (session.captured[session.captured.length - 1] ?? "").replace(/\r\n/g, "\n");
  // 版本标记行只存在于文件（备份无此注释行）——出现即证明热加载读到单一事实源。
  assert.ok(downloadScript.includes("PDF_LINK_EXTRACT_VERSION=1"), "脚本应内嵌文件内容（热加载）");
  assert.ok(downloadScript.includes(extractIife(readExtractJs())), "脚本应包含完整 IIFE 主体");
});
