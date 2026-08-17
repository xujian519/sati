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

import { createWriteStream, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { brandEnv, ENV_KEY } from "../../env.js";
import { APP_VERSION } from "../../version.js";
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
/**
 * Google Patents 专利页内提取 PDF CDN 链接的浏览器侧 JS（buildDownloadScript 内嵌）。
 * P2-07：唯一事实源为 assets/patent/pdf-link-extract.js（每次 execute 热加载）；
 * 本常量为内嵌回退备份（文件缺失时使用，内容须与文件一致）。
 */
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

/**
 * P2-07：加载单一事实源 assets/patent/pdf-link-extract.js（每次构建脚本时热加载，
 * 改动无需重新构建）。源码态（src/tool/builtin/）上溯 3 级到仓库根，dist 态
 * （dist/src/tool/builtin/）上溯 4 级；两处候选都缺失时回退内嵌备份。
 */
function loadPdfLinkExtractJs(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "assets", "patent", "pdf-link-extract.js"),
    join(here, "..", "..", "..", "..", "assets", "patent", "pdf-link-extract.js"),
  ];
  for (const candidate of candidates) {
    try {
      const js = readFileSync(candidate, "utf8");
      // 与 Python 端对齐：首行须为版本标记，否则视为损坏回退内嵌备份。
      if (/^\/\/ PDF_LINK_EXTRACT_VERSION=\d+$/.test(js.split("\n", 1)[0] ?? "")) {
        return js;
      }
      console.warn(`[patent_pdf_download] ${candidate} 缺少 PDF_LINK_EXTRACT_VERSION 版本标记，回退内嵌备份`);
    } catch {
      // 继续下一个候选路径
    }
  }
  return PDF_LINK_EXTRACT_JS;
}

/**
 * 嵌入 String.raw 模板前的防御性转义：反引号与 `${` 会截断模板字面量。
 * 反斜杠刻意不转义（会破坏 JS 正则语义，如 `/\d+/`）；资产注释已声明内容
 * 不得含反引号/插值占位符，本转义 + 版本标记校验为编辑违约时的兜底。
 */
function escapeTemplateContent(js: string): string {
  return js.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

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
  /** P2-03：忽略 MANIFEST 断点续传，强制重跑全部专利（默认 false）。 */
  force?: boolean;
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
  /**
   * 落盘方式：browser=ego-browser 下载拦截（复用登录态），http=fetch 兜底，
   * skip=P2-03 MANIFEST 断点续传命中（文件已存在且 size 匹配，未发起网络请求）。
   */
  method?: "browser" | "http" | "skip";
  /** P3-02：fetch 兜底路径的下载耗时（毫秒）；browser/脚本侧耗时不可按篇拆分，省略。 */
  durationMs?: number;
};

export type PatentPdfDownloadOutput = {
  results: PatentDownloadItem[];
  summary: { total: number; ok: number; failed: number };
  outputDir: string;
  /** record=true 且录屏成功时的录制文件路径。 */
  recorded?: string;
};

/** 与 pilot config `patents` 节同形的窄类型（避免 tool 层依赖 pilot 包）。 */
export type PatentPdfDownloadPatentsConfig = {
  downloadDir?: string;
};

export type CreatePatentPdfDownloadToolOptions = {
  /** 测试缝：注入 session（默认真实 EgoBrowserSession）。 */
  session?: EgoBrowserSession;
  /** 会话级 task space 的 sessionId 前缀（测试可覆盖）。 */
  sessionIdForSpace?: (context: SatiToolRuntimeContext) => string;
  /** 测试缝：fetch 兜底下载使用的 fetch 实现（默认真实网络，经 networkFetch 走全局代理）。 */
  fetchImpl?: typeof fetch;
  /** 每次执行时读取 `patents.*` 配置（P2-05，runtime-live）：未传 outputDir 时回退到配置的全局下载目录。 */
  patentsConfigProvider?: () => PatentPdfDownloadPatentsConfig | undefined;
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
  const patentsConfigProvider = options.patentsConfigProvider;

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
        force: {
          type: "boolean",
          description: "Ignore the .MANIFEST.jsonl resume state and re-download all patents (default false).",
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
      // P1-02：解析后路径在 workspace 之外时，追加越界提示（保留绝对路径能力，
      // 由用户决定放行或拒绝，而非静默拒绝）。
      const resolved = resolveOutputDir(input?.outputDir, context.cwd, patentsConfigProvider?.());
      const rel = relative(context.cwd, resolved);
      const isOutside = rel !== "" && (rel.startsWith("..") || isAbsolute(rel));
      const outsideNote = isOutside ? " The output directory is outside the current workspace." : "";
      const message = `Downloading patent PDFs to the workspace requires permission.${outsideNote}`;
      return {
        type: "ask",
        reason: {
          type: "tool",
          toolName: "patent_pdf_download",
          message,
        },
        request: {
          toolCallId: "",
          toolName: "patent_pdf_download",
          inputSummary: "download patent PDFs",
          reason: {
            type: "tool",
            toolName: "patent_pdf_download",
            message,
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
      const { patents, outputDir, pageTimeoutSec, downloadTimeoutMs, timeoutMs, force } =
        input as PatentPdfDownloadInput;

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
      // P1-02：归一化（已去除 / 与空白）后仍含 \ 或 .. 的专利号会污染文件名
      // 拼接（Windows 分隔符 / 目录穿越），直接拒绝。
      const traversal = unique.filter(n => n.includes("\\") || n.includes(".."));
      if (traversal.length > 0) {
        return {
          ok: false,
          issues: [
            {
              path: "patents",
              code: "invalid_schema",
              message: `patents contain path traversal characters: ${traversal.join(", ")}`,
            },
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
      if (force !== undefined && typeof force !== "boolean") {
        return {
          ok: false,
          issues: [{ path: "force", code: "invalid_type", message: "force must be a boolean" }],
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
      const outputDir = resolveOutputDir(input.outputDir, context.cwd, patentsConfigProvider?.());
      session.ensureDir(outputDir);
      const pageTimeoutSec = input.pageTimeoutSec ?? 20;
      const downloadTimeoutMs = input.downloadTimeoutMs ?? 60_000;
      const timeoutMs =
        input.timeoutMs ??
        Math.min(MAX_DEFAULT_TIMEOUT_MS, Math.max(MIN_DEFAULT_TIMEOUT_MS, patents.length * PER_PATENT_TIMEOUT_MS));
      const record = input.record === true;
      const force = input.force === true;

      // P2-03 断点续传：加载 MANIFEST（按 patent 去重，最后一条 wins），
      // status=ok 且磁盘 size 匹配的专利跳过，不打开 Google Patents 页；
      // --force 时全部视为未下载。
      const manifest = await loadManifest(outputDir);
      const skipped: PatentDownloadItem[] = [];
      let pending = patents;
      if (!force) {
        pending = [];
        for (const patent of patents) {
          const entry = manifest.get(patent);
          if (entry?.path && entry.size !== undefined && (await fileSizeMatches(entry.path, entry.size))) {
            skipped.push({ patent, status: "ok", path: entry.path, method: "skip" });
          } else {
            pending.push(patent);
          }
        }
      }
      if (pending.length === 0) {
        const summary = { total: patents.length, ok: patents.length, failed: 0 };
        // P3-02：全部命中 MANIFEST 也是批次结束，同样埋点。
        await appendDownloadLog(skipped, summary, context.env);
        return {
          content: [{ type: "text", text: formatSummary(summary, outputDir, undefined, skipped) }],
          data: { results: skipped, summary, outputDir, recorded: undefined },
        };
      }

      const spaceName = session.taskSpaceName("patent-download", sessionIdForSpace(context).slice(0, 12));
      const recordPath = record ? join(outputDir, "recording.webm") : undefined;
      const script = buildDownloadScript({
        spaceName,
        patents: pending,
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
      // P2-03：下载成功的条目追加进 MANIFEST（append 式，加载时按 patent 去重，
      // 最后一条 wins）；下次执行 status=ok 且 size 匹配的直接跳过。
      // 落盘文件不可读（竞态/路径失效）时放弃续传记录，不阻断下载结果。
      for (const r of results) {
        if (r.status === "ok" && r.path) {
          try {
            const st = await stat(r.path);
            await saveManifestEntry(outputDir, {
              patent: r.patent,
              status: "ok",
              path: r.path,
              size: st.size,
              sha1: await sha1OfFile(r.path),
              ts: Date.now(),
            });
          } catch {
            // 续传记录失败不影响本次下载结果
          }
        }
      }
      const allResults = [...skipped, ...results];
      const summary = summarize(allResults, patents.length);
      // P3-02：批次结束追加一行结构化埋点（失败静默）。
      await appendDownloadLog(allResults, summary, context.env);
      const recorded = record && !result.output.includes("EGO_RECORD_FAILED:") ? recordPath : undefined;
      return {
        content: [
          {
            type: "text",
            text: formatSummary(summary, outputDir, recorded, allResults),
          },
        ],
        data: {
          results: allResults,
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

/** P3-02：下载成功率埋点文件（<APP_HOME|~/.sati>/logs/patent-download.jsonl，append 追加式）。 */
const DOWNLOAD_LOG_REL = join("logs", "patent-download.jsonl");

/**
 * P3-02：批次结束后追加一行 JSONL 埋点：{ts, total, ok, failed, perPatent, clientVersion}。
 * 路径用仓库惯例 <APP_HOME|~/.sati>/logs/；目录不存在自动创建；任何失败静默忽略，
 * 遥测尽力而为，不阻断下载主流程。
 */
async function appendDownloadLog(
  results: readonly PatentDownloadItem[],
  summary: { total: number; ok: number; failed: number },
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    const home = brandEnv(env ?? process.env, ENV_KEY.HOME) || join(homedir(), ".sati");
    const logPath = join(home, DOWNLOAD_LOG_REL);
    await mkdir(dirname(logPath), { recursive: true });
    const entry = {
      ts: Date.now(),
      total: summary.total,
      ok: summary.ok,
      failed: summary.failed,
      perPatent: results.map(r => ({
        num: r.patent,
        status: r.status,
        method: r.method,
        durationMs: r.durationMs,
        errorCode: r.error,
      })),
      clientVersion: APP_VERSION,
    };
    await appendFile(logPath, JSON.stringify(entry) + "\n", { encoding: "utf8" });
  } catch {
    // 埋点失败静默（磁盘满/权限问题等不阻断下载结果）
  }
}

/** P2-03：MANIFEST 文件名（<outputDir>/.MANIFEST.jsonl，append 追加式）。 */
const MANIFEST_FILE = ".MANIFEST.jsonl";

/** P2-03：MANIFEST 条目——每行一个 JSON，字段与 Python 侧契约一致。 */
export type PatentManifestEntry = {
  patent: string;
  status: "ok" | "failed";
  path?: string;
  size?: number;
  sha1?: string;
  ts: number;
};

/** P2-03：磁盘文件大小与 MANIFEST 记录一致才算命中续传（不存在/异常视为不匹配）。 */
async function fileSizeMatches(path: string, expectedSize: number): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.size === expectedSize;
  } catch {
    return false;
  }
}

/**
 * P2-03：加载 MANIFEST。按 patent 键去重（append 式积累的重复行最后一条 wins）；
 * 损坏行容忍跳过（仅影响该条目的续传），文件不存在返回空。
 */
async function loadManifest(outputDir: string): Promise<Map<string, PatentManifestEntry>> {
  const manifestPath = join(outputDir, MANIFEST_FILE);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const byPatent = new Map<string, PatentManifestEntry>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as PatentManifestEntry;
      if (entry && typeof entry.patent === "string" && entry.status === "ok") {
        byPatent.set(entry.patent, entry);
      }
    } catch {
      // 单行损坏：跳过该行，其余行仍生效
    }
  }
  return byPatent;
}

/** P2-03：追加一条 MANIFEST 记录（成功后调用；--force 不清除历史，靠去重忽略旧行）。 */
async function saveManifestEntry(outputDir: string, entry: PatentManifestEntry): Promise<void> {
  const manifestPath = join(outputDir, MANIFEST_FILE);
  await appendFile(manifestPath, JSON.stringify(entry) + "\n", "utf8");
}

/** P2-03：计算文件 SHA-1（写 MANIFEST 用；跳过判定只看 size，不读全文）。 */
async function sha1OfFile(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha1").update(data).digest("hex");
}

/** 当天日期子目录名（YYYY-MM-DD）：下载目录按日归档。 */
function datePartOf(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * 展开路径开头的 `~`/`~/` 为 $HOME：Node 的 path.resolve 不自动展开，
 * `downloadDir: ~/Patents` 会被当作 cwd 下的字面量目录（parsePatentsConfig
 * docstring 示例即如此书写）。仅处理 `~` 与 `~/` 前缀（~user 形式罕见不处理）。
 */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function resolveOutputDir(
  outputDir: string | undefined,
  cwd: string,
  patentsConfig: PatentPdfDownloadPatentsConfig | undefined,
): string {
  if (outputDir) {
    return resolve(cwd, outputDir);
  }
  const datePart = datePartOf(new Date());
  if (patentsConfig?.downloadDir) {
    return resolve(expandTilde(patentsConfig.downloadDir), datePart);
  }
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
      const method = METHOD_LABELS[r.method ?? ""] ?? "";
      lines.push(`- ${r.patent}: ${r.path ?? "ok"}${method}`);
    }
  }
  return lines.join("\n");
}

/** PDF 魔数（%PDF-，5 字节）。 */
const PDF_MAGIC = "%PDF-";

/** 落盘方式的中文标注（formatSummary 行内后缀）。 */
const METHOD_LABELS: Record<string, string> = {
  http: "（fetch 兜底）",
  skip: "（已下载，跳过）",
};
/** 错误页判定下限：小于该字节数的响应视为错误页不落盘（与 Python 侧阈值统一）。 */
const MIN_PDF_BYTES = 500;

/**
 * 浏览器拦截条目兜底：脚本返回 fallback（已提取 CDN URL）时，用 fetch 直接下载落盘。
 * 成功升格为 ok（method=http）；失败或无 URL 可重试则标记 failed（保留 pdfUrl 供手动重试）。
 *
 * 落盘安全（P1-01）：写入前校验 PDF 魔数与最小长度，Content-Type 为 text/html 时拒绝
 * （宽松策略，application/octet-stream 等不误杀）；先写 .tmp 再原子 rename，
 * 避免进程中断留下半写文件。
 *
 * 重试（P2-02）：复用 networkFetch 内置重试（指数退避 jitteredBackoff，base 1000ms ×2，
 * 与 Python 侧同参数）——HTTP 408/409/425/429/5xx 与网络错误（ECONNRESET/ETIMEDOUT 等）
 * 重试至多 3 次；404/403 与魔数错误属于确定性失败，不重试立即返回。
 */
const FETCH_RETRY_MAX_ATTEMPTS = 3;

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
  const start = Date.now();
  const target = join(outputDir, `${item.patent}.pdf`);
  const tmp = `${target}.tmp`;
  try {
    const res = await networkFetch(
      item.pdfUrl,
      { headers: { "User-Agent": PATENT_DOWNLOAD_USER_AGENT, Accept: "application/pdf" } },
      {
        timeoutMs: FETCH_FALLBACK_TIMEOUT_MS,
        signal: options.signal,
        fetchImpl: options.fetchImpl,
        retry: { maxRetries: FETCH_RETRY_MAX_ATTEMPTS - 1 },
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("text/html")) {
      throw new Error(`unexpected Content-Type: ${contentType}`);
    }
    if (!res.body) throw new Error(`response too small (0 bytes), likely an error page`);
    // P2-04 流式写盘：先读首个 chunk 校验 PDF 魔数（不匹配立即取消并拒绝），
    // 再把剩余流 pipe 到 .tmp（20MB PDF 不再整读入内存，峰值仅一个 chunk）。
    const reader = res.body.getReader();
    const first = await reader.read();
    const firstBuf = first.done ? Buffer.alloc(0) : Buffer.from(first.value);
    if (firstBuf.length < PDF_MAGIC.length) {
      throw new Error(`response too small (${firstBuf.length} bytes), likely an error page`);
    }
    const magic = firstBuf.subarray(0, PDF_MAGIC.length).toString();
    if (magic !== PDF_MAGIC) {
      await reader.cancel().catch(() => {});
      throw new Error(`invalid PDF magic: ${JSON.stringify(magic)}`);
    }
    let size = firstBuf.length;
    const rest = new Readable({
      read() {
        reader.read().then(
          ({ done, value }) => {
            if (done) {
              this.push(null);
              return;
            }
            size += value.length;
            this.push(Buffer.from(value));
          },
          (err: unknown) => this.destroy(err instanceof Error ? err : new Error(String(err))),
        );
      },
    });
    const out = createWriteStream(tmp);
    out.write(firstBuf);
    await pipeline(rest, out);
    if (size < MIN_PDF_BYTES) throw new Error(`response too small (${size} bytes), likely an error page`);
    await rename(tmp, target);
    return {
      patent: item.patent,
      status: "ok",
      path: target,
      pdfUrl: item.pdfUrl,
      method: "http",
      durationMs: Date.now() - start,
    };
  } catch (fetchErr) {
    await unlink(tmp).catch(() => {});
    const reason = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const base = item.error ? `${item.error}; ` : "";
    return {
      patent: item.patent,
      status: "failed",
      pdfUrl: item.pdfUrl,
      error: `${base}fetch fallback failed: ${reason}`,
      durationMs: Date.now() - start,
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
  lines.push(`      pdfUrl = await js(String.raw\`${escapeTemplateContent(loadPdfLinkExtractJs())}\`);`);
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
