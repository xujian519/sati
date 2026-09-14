import type { EgoBrowserSession } from "../../../patent/data/nuo/egoSession.js";
import type { SatiToolRuntimeContext } from "../../protocol/types.js";

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
export type ScriptDownloadItem = {
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
