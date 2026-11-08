import { spawnSync } from "node:child_process";
import type { BrowserBackend, BrowserBackendProbe, BrowserCapabilities } from "./types.js";

/**
 * Lightpanda —— 可选的纯内容后端。
 *
 * 只声明内容抓取。`--dump pdf` / `--dump png` 在上游是文本排版导出，
 * 不作为 PDF 或真实截图能力。探测只跑 `version`，不打开页面、不读 cookie。
 * 遥测默认关闭（LIGHTPANDA_DISABLE_TELEMETRY）。不复用 ego 的 profile。
 * versionPin 为 null：不比较、不下载发行版。
 */
export const LIGHTPANDA_SESSION_POLICY = {
  telemetryDisabled: true,
  versionPin: null,
  cookieFile: null,
  cookieJar: null,
  sharesEgoProfile: false,
} as const;

export type LightpandaVersionProbe = {
  error?: Error;
  status: number | null;
  stdout: string;
};

export type LightpandaVersionProber = (
  bin: string,
  args: readonly ["version"],
  env: NodeJS.ProcessEnv,
) => LightpandaVersionProbe;

const VERSION_ARGS = ["version"] as const;

/** 子进程环境。强制关闭 Lightpanda 遥测，不继承调用方的打开开关。 */
export function lightpandaChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, LIGHTPANDA_DISABLE_TELEMETRY: "true" };
}

export class LightpandaBackend implements BrowserBackend {
  readonly id = "lightpanda" as const;
  readonly label = "Lightpanda";
  readonly capabilities: BrowserCapabilities = {
    downloadInterception: false,
    screencast: false,
    handoff: false,
    siteTools: false,
    loginState: false,
    antiBot: false,
    contentCapable: true,
    pdf: false,
    trueScreenshot: false,
  };

  constructor(
    private options: {
      platform?: NodeJS.Platform;
      bin?: string;
      spawnVersion?: LightpandaVersionProber;
    } = {},
  ) {}

  probe(): BrowserBackendProbe {
    const platform = this.options.platform ?? process.platform;
    if (platform === "win32") {
      return {
        status: "missing",
        detail: "no native Windows build (this backend does not launch Lightpanda on win32)",
        installHint: "https://github.com/lightpanda-io/browser",
      };
    }
    const bin = this.options.bin ?? "lightpanda";
    const probe = (this.options.spawnVersion ?? defaultVersionProbe)(bin, VERSION_ARGS, lightpandaChildEnv());
    if (probe.error || probe.status !== 0) {
      return {
        status: "missing",
        detail: `not found — optional content backend; \`${bin} version\` failed`,
        installHint: "https://github.com/lightpanda-io/browser",
      };
    }
    return {
      status: "ok",
      detail: probe.stdout.trim() || "available",
    };
  }
}

function defaultVersionProbe(bin: string, args: readonly ["version"], env: NodeJS.ProcessEnv): LightpandaVersionProbe {
  const result = spawnSync(bin, args, {
    encoding: "utf-8",
    timeout: 5_000,
    env,
    windowsHide: true,
  });
  return {
    ...(result.error ? { error: result.error } : {}),
    status: result.status,
    stdout: result.stdout ?? "",
  };
}
