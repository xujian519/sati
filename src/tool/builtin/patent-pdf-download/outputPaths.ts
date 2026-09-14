import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { normalizePatentNumber } from "../../../patent/data/nuo/egoSession.js";
import type { PatentPdfDownloadPatentsConfig } from "./types.js";

/** 归一化（去空格/分隔符）并按号去重：validateInput 与 execute 共用，保持两处契约一致。 */
export function normalizeUniquePatents(patents: string[]): string[] {
  return [...new Set(patents.map(normalizePatentNumber).filter(n => n.length > 0))];
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

export function resolveOutputDir(
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
