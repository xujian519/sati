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
    description:
      "下载 Google Patents 专利 PDF（优先 ego-browser 登录态，回退 CDN 直链）。逐篇写入 <outputDir>/<专利号>.pdf；" +
      "单篇失败保留 pdfUrl 且不中断整批。非只读。" +
      "详见 skills/patent-illustrator/references/patent-tool-contracts/drafting-evidence.md。",
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
          description: "要下载的专利公开号列表（1-50 篇）",
        },
        outputDir: {
          type: "string",
          description: "输出目录（绝对或相对工作区）；默认 <workspace>/专利原文/YYYY-MM-DD",
        },
        pageTimeoutSec: {
          type: "integer",
          description: "单页打开超时秒（默认 20）",
        },
        downloadTimeoutMs: {
          type: "integer",
          description: "单篇下载超时毫秒（默认 60000）",
        },
        timeoutMs: {
          type: "integer",
          description: "整体超时毫秒（默认 180000，最大 300000）",
        },
        record: {
          type: "boolean",
          description: "录屏保存到 <outputDir>/recording.webm（默认 false）",
        },
        force: {
          type: "boolean",
          description: "忽略 .MANIFEST.jsonl 续跑状态（默认 false）",
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
