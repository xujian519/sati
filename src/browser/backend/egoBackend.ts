import { EgoBrowserSession } from "../../patent/data/nuo/egoSession.js";
import type { BrowserBackend, BrowserBackendProbe, BrowserCapabilities } from "./types.js";

/**
 * ego lite backend —— macOS 首选（P0）。能力位全开（对齐 POC §3 评估）：
 * 下载拦截 / 录屏 / 人机交接 / 站点经验包 / 登录态 / 反爬 均原生支持。
 */
export class EgoBackend implements BrowserBackend {
  readonly id = "ego" as const;
  readonly label = "ego lite";
  readonly capabilities: BrowserCapabilities = {
    downloadInterception: true,
    screencast: true,
    handoff: true,
    siteTools: true,
    loginState: true,
    antiBot: true,
  };

  constructor(private options: { platform?: NodeJS.Platform; doctorCheck?: boolean } = {}) {}

  async probe(): Promise<BrowserBackendProbe> {
    const session = new EgoBrowserSession({ platform: this.options.platform });
    const availability = session.checkAvailability();
    if (!availability.ok) {
      return {
        status: "missing",
        detail: availability.reason,
        installHint: "https://lite.ego.app/",
      };
    }
    if (this.options.doctorCheck) {
      const ok = await session.runConnectionProbe();
      if (!ok) {
        return {
          status: "warn",
          detail: "CLI present but connection probe failed — launch ego lite and retry, or run `ego-browser --doctor`.",
        };
      }
    }
    return {
      status: "ok",
      detail: "macOS · CLI available" + (this.options.doctorCheck ? " · connection probe ok" : ""),
    };
  }
}
