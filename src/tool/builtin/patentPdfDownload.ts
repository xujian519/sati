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

import { isAbsolute, relative } from "node:path";
import { EgoBrowserSession } from "../../patent/data/nuo/egoSession.js";
import type { PermissionResult } from "../../permission/index.js";
import type {
  SatiToolAvailability,
  SatiToolAvailabilityContext,
  SatiToolDefinition,
  SatiToolExecutionOutput,
  SatiToolRuntimeContext,
} from "../protocol/types.js";
import { MAX_OUTPUT_BYTES, MAX_PATENTS } from "./patent-pdf-download/constants.js";
import { runPatentPdfDownload } from "./patent-pdf-download/execute.js";
import { resolveOutputDir } from "./patent-pdf-download/outputPaths.js";
import { validatePatentPdfDownloadInput } from "./patent-pdf-download/validate.js";
import type {
  CreatePatentPdfDownloadToolOptions,
  PatentPdfDownloadInput,
  PatentPdfDownloadOutput,
} from "./patent-pdf-download/types.js";

export type {
  CreatePatentPdfDownloadToolOptions,
  PatentDownloadItem,
  PatentPdfDownloadInput,
  PatentPdfDownloadOutput,
  PatentPdfDownloadPatentsConfig,
} from "./patent-pdf-download/types.js";
export type { PatentManifestEntry } from "./patent-pdf-download/manifest.js";

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
    validateInput: async (input, context) => validatePatentPdfDownloadInput(input, context),
    execute: async (
      input: PatentPdfDownloadInput,
      context: SatiToolRuntimeContext,
    ): Promise<SatiToolExecutionOutput<PatentPdfDownloadOutput>> =>
      runPatentPdfDownload({ session, sessionIdForSpace, fetchImpl, patentsConfigProvider }, input, context),
  };
}
