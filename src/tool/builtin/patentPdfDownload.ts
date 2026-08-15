/**
 * `patent_pdf_download` builtin tool — 基于 ego-browser v1.2.6 下载拦截能力
 * （`page.waitForEvent("download")` + `saveAs`）批量下载 Google Patents PDF。
 *
 * 相比旧 Python 脚本（提取 CDN URL 后用 urllib 下载）：
 * - 下载发生在浏览器上下文内，复用 ego lite 登录态 / Cookie，授权类下载更稳；
 * - 不依赖 DOM 猜测之外的结构，`<a download>` 点击触发真实浏览器下载；
 * - 单次任务空间会话内批量完成，配合 `PROGRESS` 行输出进度；
 * - 可选 screencast 录屏留证（process evidence）。
 *
 * 兼容回退：某篇浏览器下载拦截失败时，提取 CDN URL 后用 fetch 直接下载；
 * 两者都失败则返回 `status: "failed"` 并保留 `pdfUrl` 供手动重试，不中断其余专利。
 */

import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { networkFetch } from "../../network/index.js";
import type { PermissionResult } from "../../permission/index.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolValidationResult } from "../protocol/schema.js";
import type {
  SatiToolAvailability,
  SatiToolAvailabilityContext,
  SatiToolDefinition,
  SatiToolExecutionOutput,
  SatiToolRuntimeContext,
} from "../protocol/types.js";
import { EgoBrowserSession, normalizePatentNumber } from "../../patent/data/nuo/egoSession.js";

const MAX_PATENTS = 50;
const MAX_OUTPUT_BYTES = 500_000;
/** 默认整体超时的推算参数：每篇 25s，下限 60s，上限 180s（inputSchema 硬上限 300s 留给用户显式指定）。 */
const PER_PATENT_TIMEOUT_MS = 25_000;
const MIN_DEFAULT_TIMEOUT_MS = 60_000;
const MAX_DEFAULT_TIMEOUT_MS = 180_000;
/** fetch 兜底下载 CDN PDF 的每篇超时（毫秒）。 */
const FETCH_FALLBACK_TIMEOUT_MS = 60_000;
/**
 * Google Patents CDN（patentimages.storage.googleapis.com）对非浏览器 UA 会返回 403，
 * 因此这里刻意用浏览器 UA——不能复用 Sati 身份 UA（如 WEB_FETCH_USER_AGENT）。
 */
const PATENT_DOWNLOAD_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
/** Google Patents 专利页内提取 PDF CDN 链接的浏览器侧 JS（buildDownloadScript 内嵌）。 */
const PDF_LINK_EXTRACT_JS = String.raw`(() => {
  const links = document.querySelectorAll('a[href*=".pdf"]');
  for (const link of links) {
    if (link.href && (link.href.includes('storage.googleapis.com') || link.href.includes('patentimages'))) return link.href;
  }
  for (const link of links) { if (link.href) return link.href; }
  // Google Patents 新版把 PDF URL 放在某些 data 属性或按钮附近，兜底扫描全部 href
  const allLinks = [...document.querySelectorAll('a[href]')];
  for (const link of allLinks) {
    if (link.href && (link.href.includes('.pdf') || link.href.includes('download'))) return link.href;
  }
  return null;
})()`;

/** 探测页面是否存在 "Download PDF" 按钮/链接（不点击）。 */
const FIND_DOWNLOAD_PDF_JS = String.raw`(() => {
  const candidates = [...document.querySelectorAll('a, button, [role="button"], input[type="button"]')];
  return candidates.some(el => {
    const text = (el.innerText || el.textContent || el.value || el.title || '').toLowerCase();
    return text.includes('download pdf') || (text.includes('download') && text.includes('pdf'));
  });
})()`;

/** 点击页面上的 "Download PDF" 按钮/链接（Google Patents 当前是 JS 触发的空 href 元素）。 */
const CLICK_DOWNLOAD_PDF_JS = String.raw`(() => {
  const candidates = [...document.querySelectorAll('a, button, [role="button"], input[type="button"]')];
  const btn = candidates.find(el => {
    const text = (el.innerText || el.textContent || el.value || el.title || '').toLowerCase();
    return text.includes('download pdf') || (text.includes('download') && text.includes('pdf'));
  });
  if (!btn) return null;
  btn.click();
  return btn.tagName + (btn.innerText ? ':' + btn.innerText.trim().slice(0, 30) : '');
})()`;

export type PatentPdfDownloadInput = {
  /** 专利公开号/授权公告号列表（CN/US/EP/WO…），1-50 篇。 */
  patents: string[];
  /** 输出目录（绝对或相对当前工作空间）；默认 `<cwd>/专利原文/YYYY-MM-DD`。 */
  outputDir?: string;
  /** 每页打开超时（秒），默认 20。 */
  pageTimeoutSec?: number;
  /** 每篇下载拦截超时（毫秒），默认 60_000。 */
  downloadTimeoutMs?: number;
  /** 整体执行超时（毫秒），默认 180_000，上限 300_000。 */
  timeoutMs?: number;
  /** 是否录屏留证（screencast，输出到 outputDir/recording.webm），默认 false。 */
  record?: boolean;
};

/** ego-browser 脚本返回的条目（脚本侧只产生 ok / fallback，由 Sati 侧兜底后升格为公共契约）。 */
type ScriptDownloadItem = {
  patent: string;
  status: "ok" | "fallback";
  path?: string;
  pdfUrl?: string;
  error?: string;
};

export type PatentDownloadItem = {
  patent: string;
  status: "ok" | "failed";
  /** status=ok 时的落盘路径。 */
  path?: string;
  /** 提取到的 CDN PDF 链接（诊断 / 手动重试用）。 */
  pdfUrl?: string;
  error?: string;
  /** 落盘方式：browser=ego-browser 下载拦截（复用登录态），http=fetch 兜底。 */
  method?: "browser" | "http";
};

export type PatentPdfDownloadOutput = {
  results: PatentDownloadItem[];
  summary: { total: number; ok: number; failed: number };
  outputDir: string;
  /** record=true 且录屏成功时的录制文件路径。 */
  recorded?: string;
};

export type CreatePatentPdfDownloadToolOptions = {
  /** 测试缝：注入 session（默认真实 EgoBrowserSession）。 */
  session?: EgoBrowserSession;
  /** 会话级 task space 的 sessionId 前缀（测试可覆盖）。 */
  sessionIdForSpace?: (context: SatiToolRuntimeContext) => string;
  /** 测试缝：fetch 兜底下载使用的 fetch 实现（默认真实网络，经 networkFetch 走全局代理）。 */
  fetchImpl?: typeof fetch;
};

const DESCRIPTION = `Download patent PDFs from Google Patents, preferring the user's ego-browser (ego lite) for in-browser download interception so authorized PDFs work with the browser session's login state. When in-browser interception is unavailable or fails, the tool falls back to fetching the extracted CDN PDF URL directly over HTTP and writes it to disk.

Input \`patents\` is a list of publication numbers (CN123456789A, US11452699B2, EP1234567A1, WO2023123456A1, ...). Files are saved as <outputDir>/<patent>.pdf. Each patent is processed in sequence in a single browser session (task space); \`PROGRESS\` lines report per-patent completion.

Each patent's outcome is \`status: "ok"\` (with \`path\` on disk and \`method\` "browser"|"http" indicating how it was saved) or \`status: "failed"\` (with \`error\`, and \`pdfUrl\` kept for manual retry when one was found). Failures do not interrupt the remaining patents.

Set \`record: true\` to also record the browser session to <outputDir>/recording.webm (screencast) for process evidence.`;

export function createPatentPdfDownloadTool(
  options: CreatePatentPdfDownloadToolOptions = {},
): SatiToolDefinition<PatentPdfDownloadInput, PatentPdfDownloadOutput> {
  const session = options.session ?? new EgoBrowserSession();
  const sessionIdForSpace = options.sessionIdForSpace ?? (context => context.sessionId);
  const fetchImpl = options.fetchImpl;

  return {
    name: "patent_pdf_download",
    outputSchema: {
      type: "object",
      required: ["results", "outputDir"],
      properties: {
        results: { type: "array" },
        summary: { type: "object" },
        outputDir: { type: "string" },
        recorded: { type: "boolean" },
      },
    },
    description: DESCRIPTION,
    kind: "network",
    domain: "patent",
    inputSchema: {
      type: "object",
      required: ["patents"],
      additionalProperties: false,
      properties: {
        patents: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_PATENTS,
          description: "Patent publication numbers to download (1-50).",
        },
        outputDir: {
          type: "string",
          description:
            "Output directory (absolute or relative to the workspace). Defaults to <workspace>/专利原文/YYYY-MM-DD.",
        },
        pageTimeoutSec: {
          type: "integer",
          description: "Per-page open timeout in seconds (default 20).",
        },
        downloadTimeoutMs: {
          type: "integer",
          description: "Per-patent download interception timeout in milliseconds (default 60000).",
        },
        timeoutMs: {
          type: "integer",
          description: "Overall execution timeout in milliseconds (default 180000, max 300000).",
        },
        record: {
          type: "boolean",
          description: "Record the browser session to <outputDir>/recording.webm (default false).",
        },
      },
    },
    maxResultBytes: MAX_OUTPUT_BYTES,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => true,
    checkAvailability: (_context: SatiToolAvailabilityContext): SatiToolAvailability => {
      const availability = session.checkAvailability();
      if (!availability.ok) {
        return { ok: false, code: availability.code, reason: availability.reason };
      }
      return { ok: true };
    },
    checkPermissions: async (input, context): Promise<PermissionResult> => {
      void input;
      void context;
      return {
        type: "ask",
        reason: {
          type: "tool",
          toolName: "patent_pdf_download",
          message: "Downloading patent PDFs to the workspace requires permission.",
        },
        request: {
          toolCallId: "",
          toolName: "patent_pdf_download",
          inputSummary: "download patent PDFs",
          reason: {
            type: "tool",
            toolName: "patent_pdf_download",
            message: "Downloading patent PDFs to the workspace requires permission.",
          },
          options: [
            { id: "allow_once", label: "Allow download" },
            { id: "deny", label: "Deny" },
          ],
        },
      };
    },
    validateInput: async (input, context): Promise<SatiToolValidationResult> => {
      void context;
      if (!input || typeof input !== "object") {
        return { ok: false, issues: [{ path: "", code: "invalid_type", message: "input must be an object" }] };
      }
      const { patents, outputDir, pageTimeoutSec, downloadTimeoutMs, timeoutMs } = input as PatentPdfDownloadInput;

      if (!Array.isArray(patents) || patents.length === 0) {
        return { ok: false, issues: [{ path: "patents", code: "required", message: "patents is required" }] };
      }
      const normalized = patents.map(normalizePatentNumber).filter(n => n.length > 0);
      const unique = [...new Set(normalized)];
      if (unique.length === 0) {
        return {
          ok: false,
          issues: [
            { path: "patents", code: "invalid_schema", message: "patents must contain at least one non-empty number" },
          ],
        };
      }
      if (unique.length > MAX_PATENTS) {
        return {
          ok: false,
          issues: [
            { path: "patents", code: "invalid_schema", message: `patents exceeds the maximum of ${MAX_PATENTS}` },
          ],
        };
      }
      if (outputDir !== undefined && typeof outputDir !== "string") {
        return {
          ok: false,
          issues: [{ path: "outputDir", code: "invalid_type", message: "outputDir must be a string" }],
        };
      }
      if (
        pageTimeoutSec !== undefined &&
        (!Number.isInteger(pageTimeoutSec) || pageTimeoutSec < 5 || pageTimeoutSec > 60)
      ) {
        return {
          ok: false,
          issues: [
            {
              path: "pageTimeoutSec",
              code: "invalid_schema",
              message: "pageTimeoutSec must be an integer between 5 and 60",
            },
          ],
        };
      }
      if (
        downloadTimeoutMs !== undefined &&
        (!Number.isInteger(downloadTimeoutMs) || downloadTimeoutMs < 5_000 || downloadTimeoutMs > 300_000)
      ) {
        return {
          ok: false,
          issues: [
            {
              path: "downloadTimeoutMs",
              code: "invalid_schema",
              message: "downloadTimeoutMs must be between 5000 and 300000",
            },
          ],
        };
      }
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)) {
        return {
          ok: false,
          issues: [{ path: "timeoutMs", code: "invalid_schema", message: "timeoutMs must be between 1 and 300000" }],
        };
      }
      return { ok: true, input: { ...(input as PatentPdfDownloadInput), patents: unique } };
    },
    execute: async (
      input: PatentPdfDownloadInput,
      context: SatiToolRuntimeContext,
    ): Promise<SatiToolExecutionOutput<PatentPdfDownloadOutput>> => {
      const availability = session.checkAvailability();
      if (!availability.ok) {
        throw new SatiToolRuntimeError("setup_required", availability.reason, { tool: "patent_pdf_download" });
      }

      const patents = [...new Set(input.patents.map(normalizePatentNumber).filter(n => n.length > 0))];
      const outputDir = resolveOutputDir(input.outputDir, context.cwd);
      session.ensureDir(outputDir);
      const pageTimeoutSec = input.pageTimeoutSec ?? 20;
      const downloadTimeoutMs = input.downloadTimeoutMs ?? 60_000;
      const timeoutMs =
        input.timeoutMs ??
        Math.min(MAX_DEFAULT_TIMEOUT_MS, Math.max(MIN_DEFAULT_TIMEOUT_MS, patents.length * PER_PATENT_TIMEOUT_MS));
      const record = input.record === true;

      const spaceName = session.taskSpaceName("patent-download", sessionIdForSpace(context).slice(0, 12));
      const recordPath = record ? join(outputDir, "recording.webm") : undefined;
      const script = buildDownloadScript({
        spaceName,
        patents,
        outputDir,
        pageTimeoutSec,
        downloadTimeoutMs,
        record,
        recordPath,
      });

      let result;
      try {
        result = await session.runScript(script, {
          cwd: context.cwd,
          env: context.env,
          timeoutMs,
          signal: context.abortSignal,
        });
      } catch (error) {
        throw new SatiToolRuntimeError(
          "tool_execution_failed",
          `patent_pdf_download failed to start: ${error instanceof Error ? error.message : String(error)}`,
          {
            tool: "patent_pdf_download",
          },
        );
      }
      if (result.timedOut) {
        throw new SatiToolRuntimeError("tool_timeout", `patent_pdf_download timed out after ${timeoutMs}ms`, {
          tool: "patent_pdf_download",
          durationMs: result.durationMs,
        });
      }
      if (result.exitCode !== 0) {
        const detail = (result.output.trim().split("\n").pop() ?? "").slice(0, 1_000);
        throw new SatiToolRuntimeError(
          "tool_execution_failed",
          `patent_pdf_download exited with code ${result.exitCode}. ${detail}`,
          {
            tool: "patent_pdf_download",
            exitCode: result.exitCode,
          },
        );
      }

      const scriptResults = session.extractTaggedJson<ScriptDownloadItem[]>(result.output, "DOWNLOAD_RESULTS") ?? [];
      // 兜底：浏览器拦截不可用或失败时，直接用 fetch 下载 CDN PDF；两者都失败则标记 failed。
      const results = await Promise.all(
        scriptResults.map(item => fetchPdfFallback(item, outputDir, { signal: context.abortSignal, fetchImpl })),
      );
      const summary = summarize(results, patents.length);
      const recorded = record && !result.output.includes("EGO_RECORD_FAILED:") ? recordPath : undefined;
      return {
        content: [
          {
            type: "text",
            text: formatSummary(summary, outputDir, recorded, results),
          },
        ],
        data: {
          results,
          summary,
          outputDir,
          recorded,
        },
        metadata: {
          durationMs: result.durationMs,
          outputBytes: result.output.length,
        },
      };
    },
  };
}

function resolveOutputDir(outputDir: string | undefined, cwd: string): string {
  if (outputDir) {
    return resolve(cwd, outputDir);
  }
  const now = new Date();
  const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return resolve(cwd, "专利原文", datePart);
}

function summarize(results: PatentDownloadItem[], total: number): { total: number; ok: number; failed: number } {
  const ok = results.filter(r => r.status === "ok").length;
  return { total, ok, failed: total - ok };
}

function formatSummary(
  summary: { total: number; ok: number; failed: number },
  outputDir: string,
  recorded: string | undefined,
  results: PatentDownloadItem[],
): string {
  const lines: string[] = [
    `下载完成：${summary.ok}/${summary.total} 成功，${summary.failed} 失败`,
    `输出目录：${outputDir}`,
  ];
  if (recorded) lines.push(`录屏留证：${recorded}`);
  for (const r of results) {
    if (r.status === "failed") {
      const retry = r.pdfUrl ? `；可手动重试：${r.pdfUrl}` : "";
      lines.push(`- ${r.patent}: 失败（${r.error ?? "unknown"}${retry}）`);
    } else {
      const method = r.method === "http" ? "（fetch 兜底）" : "";
      lines.push(`- ${r.patent}: ${r.path ?? "ok"}${method}`);
    }
  }
  return lines.join("\n");
}

/**
 * 浏览器拦截条目兜底：脚本返回 fallback（已提取 CDN URL）时，用 fetch 直接下载落盘。
 * 成功升格为 ok（method=http）；失败或无 URL 可重试则标记 failed（保留 pdfUrl 供手动重试）。
 */
async function fetchPdfFallback(
  item: ScriptDownloadItem,
  outputDir: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<PatentDownloadItem> {
  if (item.status === "ok") {
    return { patent: item.patent, status: "ok", path: item.path, pdfUrl: item.pdfUrl, method: "browser" };
  }
  if (!item.pdfUrl) {
    return { patent: item.patent, status: "failed", error: item.error };
  }
  try {
    const target = join(outputDir, `${item.patent}.pdf`);
    const res = await networkFetch(
      item.pdfUrl,
      { headers: { "User-Agent": PATENT_DOWNLOAD_USER_AGENT, Accept: "application/pdf" } },
      { timeoutMs: FETCH_FALLBACK_TIMEOUT_MS, signal: options.signal, fetchImpl: options.fetchImpl },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) throw new Error("empty PDF response");
    await writeFile(target, buffer);
    return { patent: item.patent, status: "ok", path: target, pdfUrl: item.pdfUrl, method: "http" };
  } catch (fetchErr) {
    const reason = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const base = item.error ? `${item.error}; ` : "";
    return {
      patent: item.patent,
      status: "failed",
      pdfUrl: item.pdfUrl,
      error: `${base}fetch fallback failed: ${reason}`,
    };
  }
}

type DownloadScriptParams = {
  spaceName: string;
  patents: string[];
  outputDir: string;
  pageTimeoutSec: number;
  downloadTimeoutMs: number;
  record: boolean;
  recordPath?: string;
};

/**
 * 构造批量下载的 ego-browser 脚本。
 * 每条专利：打开专利页 → SPA URL 校验 → 提取 CDN PDF 链接 → 拦截下载落盘。
 * 拦截统一走 `downloadVia(trigger)`：注册下载监听后执行触发（优先点页面
 * "Download PDF" 按钮，失效则用 CDN URL 锚点触发），`saveAs` 落盘。
 * 若 harness 不提供 `page.waitForEvent('download')`（较旧 ego lite），返回
 * `status: "fallback"` 与 CDN URL，由 Sati 侧 fetch 兜底。screencast 同理
 * 按能力探测（`typeof page !== 'undefined'`）。
 */
function buildDownloadScript(params: DownloadScriptParams): string {
  const { spaceName, patents, outputDir, pageTimeoutSec, downloadTimeoutMs, record, recordPath } = params;
  const numsJson = JSON.stringify(patents);
  const outDirJson = JSON.stringify(outputDir);
  const lines: string[] = [];

  lines.push(`const task = await useOrCreateTaskSpace(${JSON.stringify(spaceName)});`);
  lines.push(`const nums = ${numsJson};`);
  lines.push(`const outDir = ${outDirJson};`);
  lines.push("const results = [];");
  lines.push("const canIntercept = typeof page !== 'undefined' && typeof page.waitForEvent === 'function';");
  lines.push("const canRecord = typeof page !== 'undefined' && typeof page.screencast !== 'undefined';");
  lines.push("// 统一下载拦截：监听下载事件 → 执行触发 → saveAs 落盘。");
  lines.push("async function downloadVia(trigger, num, pdfUrl) {");
  lines.push(`  const dlPromise = page.waitForEvent('download', { timeout: ${downloadTimeoutMs} });`);
  lines.push("  await trigger();");
  lines.push("  const download = await dlPromise;");
  lines.push("  const target = outDir + '/' + num + '.pdf';");
  lines.push("  await download.saveAs(target);");
  lines.push("  results.push({ patent: num, status: 'ok', path: target, pdfUrl: pdfUrl });");
  lines.push("  return true;");
  lines.push("}");
  lines.push("// CDN URL 锚点触发下载（按钮 href 为空时的备用触发方式）。");
  lines.push(
    "async function triggerAnchorDownload(url) { await js(\"(() => { const a = document.createElement('a'); a.href = \" + JSON.stringify(url) + \"; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); return true; })()\"); }",
  );
  if (record && recordPath) {
    lines.push("if (canRecord) {");
    lines.push("  try {");
    lines.push(`    await page.screencast.start({ path: ${JSON.stringify(recordPath)}, size: 720 });`);
    lines.push("  } catch (e) {");
    lines.push("    cliLog('EGO_RECORD_FAILED:' + String(e && e.message || e));");
    lines.push("  }");
    lines.push("} else {");
    lines.push(
      "  cliLog('EGO_RECORD_FAILED:record unsupported by this ego-browser build; run `ego-browser upgrade`');",
    );
    lines.push("}");
  }
  lines.push("try {");
  lines.push("  for (let i = 0; i < nums.length; i++) {");
  lines.push("    const num = nums[i];");
  lines.push("    let pdfUrl = null;");
  lines.push("    try {");
  lines.push(
    `      await openOrReuseTab('https://patents.google.com/patent/' + num, { wait: true, timeout: ${pageTimeoutSec} });`,
  );
  lines.push("      let onPage = false;");
  lines.push("      const numLower = num.toLowerCase();");
  lines.push("      for (let attempt = 0; attempt < 3 && !onPage; attempt++) {");
  lines.push("        const href = await js(String.raw`location.href.toLowerCase()`);");
  lines.push("        const marker = '/patent/' + numLower;");
  lines.push("        const idx = href.indexOf(marker);");
  lines.push("        if (idx !== -1) {");
  lines.push("          const after = href.charAt(idx + marker.length);");
  lines.push("          onPage = after === '' || after === '/' || after === '?';");
  lines.push("        }");
  lines.push("        if (!onPage) await wait(1);");
  lines.push("      }");
  lines.push("      if (!onPage) throw new Error('page mismatch');");
  // 先提取 CDN PDF 链接：按钮/锚点两条触发路径与 Sati 侧 fetch 兜底共用。
  lines.push(`      pdfUrl = await js(String.raw\`${PDF_LINK_EXTRACT_JS}\`);`);
  lines.push("      if (!pdfUrl) throw new Error('no pdf link');");
  lines.push("      if (!canIntercept) {");
  lines.push(
    "        results.push({ patent: num, status: 'fallback', pdfUrl: pdfUrl, error: 'download interception unavailable; run `ego-browser upgrade`' });",
  );
  lines.push("      } else {");
  // 优先点页面 "Download PDF" 按钮（复用浏览器会话），失败则用 CDN URL 锚点触发。
  lines.push("        try {");
  lines.push(`          const hasBtn = await js(String.raw\`${FIND_DOWNLOAD_PDF_JS}\`);`);
  lines.push("          let saved = false;");
  lines.push("          if (hasBtn) {");
  lines.push("            try {");
  lines.push(`              saved = await downloadVia(() => js(String.raw\`${CLICK_DOWNLOAD_PDF_JS}\`), num, pdfUrl);`);
  lines.push("            } catch (interceptErr) {");
  lines.push(
    "              cliLog('EGO_DOWNLOAD_WARN: button click intercept failed for ' + num + ': ' + interceptErr.message);",
  );
  lines.push("            }");
  lines.push("          }");
  lines.push("          if (!saved) {");
  lines.push("            await downloadVia(() => triggerAnchorDownload(pdfUrl), num, pdfUrl);");
  lines.push("          }");
  lines.push("        } catch (e) {");
  lines.push(
    "          results.push({ patent: num, status: 'fallback', pdfUrl: pdfUrl, error: String(e && e.message || e) });",
  );
  lines.push("        }");
  lines.push("      }");
  lines.push("    } catch (e) {");
  lines.push(
    "      results.push({ patent: num, status: 'fallback', pdfUrl: pdfUrl, error: String(e && e.message || e) });",
  );
  lines.push("    }");
  lines.push("    cliLog('PROGRESS:' + (i + 1) + '/' + nums.length + ':' + num);");
  lines.push("  }");
  if (record) {
    lines.push(
      "  if (canRecord) { try { await page.screencast.stop(); } catch (e) { cliLog('EGO_RECORD_FAILED:' + String(e && e.message || e)); } }",
    );
  }
  lines.push("} finally {");
  lines.push("  await completeTaskSpace(task.id, { keep: false });");
  lines.push("}");
  lines.push("cliLog('EGO_DOWNLOAD_RESULTS:' + JSON.stringify(results));");
  return lines.join("\n");
}
