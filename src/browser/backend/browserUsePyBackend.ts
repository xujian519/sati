import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserBackend, BrowserBackendProbe, BrowserCapabilities } from "./types.js";

/**
 * browser-use backend（Python · MIT）—— 无 BrowserOS 机器上的备选（Track A 后端）。
 * 能力位（对齐 POC §3.2）：登录态（--profile）与反爬为真；下载拦截需 CDP 封装（false）、
 * 录屏需 [video] extra（false）——这两项是 Track A 降级的已知短板。
 */
export class BrowserUsePyBackend implements BrowserBackend {
  readonly id = "browser-use" as const;
  readonly label = "browser-use";
  readonly capabilities: BrowserCapabilities = {
    downloadInterception: false,
    screencast: false,
    handoff: false,
    siteTools: false,
    loginState: true,
    antiBot: true,
  };

  async probe(): Promise<BrowserBackendProbe> {
    return probeBrowserUse();
  }
}

export function probeBrowserUse(): BrowserBackendProbe {
  // browser-use --version 首次运行会创建用户配置目录（~/.config/browser-harness）。
  // 在只读 HOME / sandbox / CI 等受限环境下该写入会失败并导致误报 missing
  //（§10.9 新增发现 M-C 的实测场景）。注入临时 HOME 与 XDG 目录，剥离环境副作用，
  // 只探测 CLI 本身是否可执行。
  const tmpHome = mkdtempSync(join(tmpdir(), "sati-bu-probe-"));
  const result = spawnSync("browser-use", ["--version"], {
    shell: true,
    encoding: "utf-8",
    timeout: 5_000,
    env: {
      ...process.env,
      HOME: tmpHome,
      XDG_CONFIG_HOME: join(tmpHome, ".config"),
      XDG_CACHE_HOME: join(tmpHome, ".cache"),
    },
  });
  rmSync(tmpHome, { recursive: true, force: true });
  if (result.error || result.status !== 0) {
    return {
      status: "missing",
      detail:
        "not found — install with `uv tool install browser-use` (Python >= 3.11; `uvx browser-use install` fetches Chromium on first run)",
      installHint: "https://github.com/browser-use/browser-use",
    };
  }
  return {
    status: "ok",
    detail: result.stdout?.trim() || "available",
  };
}
