/**
 * 浏览器后端抽象 —— Sprint 2（P1）Track B 的基础设施。
 *
 * 设计约束（对应方案文档评审 §S2 / §S3 / §F7）：
 * - 不抽象「脚本执行」（ego 的透传脚本模式与 MCP 原子 tools 模式冲突），
 *   只抽象「能力探测与能力位」，供路由（cold decision）与下游工具做语义决策。
 * - Backend 选择是 cold decision：只在任务/会话开始前解析一次，运行中禁止切换。
 * - 能力位（capabilities）对齐 POC 报告 §5.2 / §3 的映射评估：
 *   downloadInterception / screencast / handoff / siteTools / loginState / antiBot。
 */

/** 后端标识，同时决定级联顺序（见 buildBackendCandidates）。 */
export type BrowserBackendId = "ego" | "browseros-neo" | "browser-use" | "playwright";

/** 能力位：下游工具（如 patent_pdf_download）据此决定「该后端能否安全承接本任务」。 */
export type BrowserCapabilities = {
  /** 下载拦截（ego `page.waitForEvent('download')` 等价） */
  downloadInterception: boolean;
  /** 录屏留证（ego `page.screencast` 等价；BrowserOS 为自动录制） */
  screencast: boolean;
  /** 人机交接（ego `handOffTaskSpace`/`takeOverTaskSpace` 等价） */
  handoff: boolean;
  /** 站点经验包（ego `site.runTool` 等价） */
  siteTools: boolean;
  /** 登录态继承（真实 Chrome profile / 用户已登录会话） */
  loginState: boolean;
  /** 反爬能力（真实浏览器指纹，而非纯净自动化 Chromium） */
  antiBot: boolean;
};

export type BackendProbeStatus = "ok" | "warn" | "missing";

export type BrowserBackendProbe = {
  status: BackendProbeStatus;
  detail: string;
  installHint?: string;
};

export interface BrowserBackend {
  readonly id: BrowserBackendId;
  readonly label: string;
  /** 平台级 + 安装级可用性探测。约定：不 spawn 浏览器进程、单次 ≤ 5s、只读。 */
  probe(): BrowserBackendProbe | Promise<BrowserBackendProbe>;
  readonly capabilities: BrowserCapabilities;
}
