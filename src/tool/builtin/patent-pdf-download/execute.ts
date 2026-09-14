import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { EgoBrowserSession } from "../../../patent/data/nuo/egoSession.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import type { SatiToolExecutionOutput, SatiToolRuntimeContext } from "../../protocol/types.js";
import { buildDownloadScript } from "./browserDriver.js";
import { MAX_DEFAULT_TIMEOUT_MS, MIN_DEFAULT_TIMEOUT_MS, PER_PATENT_TIMEOUT_MS } from "./constants.js";
import { fetchPdfFallback } from "./fetchFallback.js";
import { fileSizeMatches, loadManifest, saveManifestEntry, sha1OfFile } from "./manifest.js";
import { normalizeUniquePatents, resolveOutputDir } from "./outputPaths.js";
import { appendDownloadLog, formatSummary, summarize } from "./reporting.js";
import type {
  PatentDownloadItem,
  PatentPdfDownloadInput,
  PatentPdfDownloadOutput,
  PatentPdfDownloadPatentsConfig,
  ScriptDownloadItem,
} from "./types.js";

/** 工厂注入的运行期依赖（测试缝与 runtime-live 配置读取）。 */
export type PatentPdfDownloadRuntime = {
  session: EgoBrowserSession;
  sessionIdForSpace: (context: SatiToolRuntimeContext) => string;
  fetchImpl?: typeof fetch;
  patentsConfigProvider?: () => PatentPdfDownloadPatentsConfig | undefined;
};

/** 批量下载主流程：MANIFEST 续传筛选 → ego-browser 脚本 → fetch 兜底 → 埋点与汇总。 */
export async function runPatentPdfDownload(
  runtime: PatentPdfDownloadRuntime,
  input: PatentPdfDownloadInput,
  context: SatiToolRuntimeContext,
): Promise<SatiToolExecutionOutput<PatentPdfDownloadOutput>> {
  const { session, sessionIdForSpace, fetchImpl, patentsConfigProvider } = runtime;
  const availability = session.checkAvailability();
  if (!availability.ok) {
    throw new SatiToolRuntimeError("setup_required", availability.reason, { tool: "patent_pdf_download" });
  }

  const patents = normalizeUniquePatents(input.patents);
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
  const script = await buildDownloadScript({
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
}
