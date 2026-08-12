import { loadBuiltinPlugins } from "../../extension/plugins/builtin/loadBuiltinPlugins.js";
import type { BrowserBackend, BrowserBackendProbe, BrowserCapabilities } from "./types.js";

/** 内置 @playwright/mcp 插件的插件名（src/extension/plugins/builtin/browser-use/plugin.json）。 */
const PLAYWRIGHT_MCP_PLUGIN_NAME = "browser-use";

/**
 * @playwright/mcp backend —— 全平台兜底（Track A）。永远命中（插件随 Sati 分发）。
 * 能力位：录屏为真（browser_start_trace/video，随版本）；下载拦截（L-D 实测 2026-08-12）：
 * 无独立 download 工具，仅可经 browser_run_code_unsafe（RCE 等价、需启用 unsafe caps）
 * 实现 → 能力位保守标 false；默认无登录态、非真实浏览器指纹 → loginState/antiBot 为 false。
 */
export class PlaywrightMcpBackend implements BrowserBackend {
  readonly id = "playwright" as const;
  readonly label = "@playwright/mcp";
  readonly capabilities: BrowserCapabilities = {
    downloadInterception: false,
    screencast: true,
    handoff: false,
    siteTools: false,
    loginState: false,
    antiBot: false,
  };

  probe(): BrowserBackendProbe {
    const plugins = loadBuiltinPlugins();
    const present = plugins.some(p => p.name === PLAYWRIGHT_MCP_PLUGIN_NAME);
    return {
      status: present ? "ok" : "warn",
      detail: present
        ? "built-in plugin (Chrome for Testing download is optional)"
        : "built-in plugin not found in the plugin registry",
      installHint: "https://playwright.dev/mcp/introduction",
    };
  }
}
