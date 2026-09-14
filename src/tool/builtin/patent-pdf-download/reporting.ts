import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { brandEnv, ENV_KEY } from "../../../env.js";
import { APP_VERSION } from "../../../version.js";
import type { PatentDownloadItem } from "./types.js";

/** P3-02：下载成功率埋点文件（<APP_HOME|~/.sati>/logs/patent-download.jsonl，append 追加式）。 */
const DOWNLOAD_LOG_REL = join("logs", "patent-download.jsonl");

/**
 * P3-02：批次结束后追加一行 JSONL 埋点：{ts, total, ok, failed, perPatent, clientVersion}。
 * 路径用仓库惯例 <APP_HOME|~/.sati>/logs/；目录不存在自动创建；任何失败静默忽略，
 * 遥测尽力而为，不阻断下载主流程。
 */
export async function appendDownloadLog(
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

export function summarize(results: PatentDownloadItem[], total: number): { total: number; ok: number; failed: number } {
  const ok = results.filter(r => r.status === "ok").length;
  return { total, ok, failed: total - ok };
}

export function formatSummary(
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

/** 落盘方式的中文标注（formatSummary 行内后缀）。 */
const METHOD_LABELS: Record<string, string> = {
  http: "（fetch 兜底）",
  skip: "（已下载，跳过）",
};
