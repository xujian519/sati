import { spawnSync } from "node:child_process";
import { createLogger } from "../../telemetry/index.js";
import type { BrowserBackend, BrowserBackendProbe, BrowserCapabilities } from "./types.js";

const logger = createLogger("sati");

/**
 * 官方稳定标签。标签构建的 `lightpanda version` 只打印这一行。
 * 探测做精确比较，不下载、不接受 nightly。
 * 来源：lightpanda-io/browser 发布标签 1.0.3（2026-11-05）。
 */
export const LIGHTPANDA_VERSION_PIN = "1.0.3";

/**
 * Lightpanda —— 可选的纯内容后端。
 *
 * 只声明内容抓取。`--dump pdf` / `--dump png` 在上游是文本排版导出，
 * 不作为 PDF 或真实截图能力。探测只跑 `version`，不打开页面、不读 cookie。
 * 遥测默认关闭（LIGHTPANDA_DISABLE_TELEMETRY）。不复用 ego 的 profile。
 * 版本必须等于 LIGHTPANDA_VERSION_PIN，否则记 warn 并让级联继续。
 */
export const LIGHTPANDA_SESSION_POLICY = {
  telemetryDisabled: true,
  versionPin: LIGHTPANDA_VERSION_PIN,
  cookieFile: null,
  cookieJar: null,
  sharesEgoProfile: false,
} as const;

/** 内容 fetch 的硬截止。比 version 探测的 5s 宽，仍由 --terminate-ms 先停掉空转脚本。 */
const LIGHTPANDA_FETCH_TIMEOUT_MS = 20_000;
const LIGHTPANDA_TERMINATE_MS = "15000";

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

export type LightpandaCommandResult = {
  error?: Error;
  status: number | null;
  stdout: string;
  stderr: string;
};

export type LightpandaCommandRunner = (
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => LightpandaCommandResult;

/** 内容格式。structured 对应上游 `--dump structured_data`（JSON-LD / OpenGraph / meta）。 */
export type LightpandaContentFormat = "markdown" | "structured";

export type LightpandaContentRequest = {
  url: string;
  format: LightpandaContentFormat;
};

export type LightpandaContentResult = {
  url: string;
  format: LightpandaContentFormat;
  dump: "markdown" | "structured_data";
  text: string;
  structured?: unknown;
};

export class LightpandaContentError extends Error {
  readonly exitStatus: number | null;
  readonly stderr: string;

  constructor(message: string, options: { cause?: unknown; exitStatus?: number | null; stderr?: string } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LightpandaContentError";
    this.exitStatus = options.exitStatus ?? null;
    this.stderr = options.stderr ?? "";
  }
}

const VERSION_ARGS = ["version"] as const;

/** 子进程环境。强制关闭 Lightpanda 遥测，不继承调用方的打开开关。 */
export function lightpandaChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, LIGHTPANDA_DISABLE_TELEMETRY: "true" };
}

/** 只接受 http(s)。file: 与其它协议不进入内容抓取。 */
export function assertLightpandaContentUrl(url: string): void {
  if (/[\u0000-\u001f\u007f]/.test(url)) {
    throw new LightpandaContentError(`content URL contains control characters: ${url}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new LightpandaContentError(`invalid content URL: ${url}`, { cause: error });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LightpandaContentError(`content URL must be http(s): ${url}`);
  }
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
      spawnCommand?: LightpandaCommandRunner;
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
    const actual = firstLine(probe.stdout);
    if (actual !== LIGHTPANDA_VERSION_PIN) {
      // 版本不符不下载替换二进制，只让 cold decision 继续下一个候选。
      logger.warn(
        `browser backend "lightpanda" version ${actual || "unknown"} does not match pinned release ${LIGHTPANDA_VERSION_PIN}; not selected and not downloaded`,
      );
      return {
        status: "warn",
        detail: `version ${actual || "unknown"} does not match pinned release ${LIGHTPANDA_VERSION_PIN} (this backend does not download a replacement)`,
        installHint: `https://github.com/lightpanda-io/browser/releases/tag/${LIGHTPANDA_VERSION_PIN}`,
      };
    }
    return {
      status: "ok",
      detail: actual,
    };
  }

  /** 冷启动抓取。不传 cookie / cookie-jar / http-cache-dir，因此不承接 ego 或其他后端的会话。 */
  fetchContent(request: LightpandaContentRequest): LightpandaContentResult {
    assertLightpandaContentUrl(request.url);
    const platform = this.options.platform ?? process.platform;
    if (platform === "win32") {
      throw new LightpandaContentError("no native Windows build (this backend does not launch Lightpanda on win32)");
    }
    const bin = this.options.bin ?? "lightpanda";
    const dump = dumpFormat(request.format);
    const args = contentFetchArgs(request.url, dump);
    const result = (this.options.spawnCommand ?? defaultFetch)(bin, args, lightpandaChildEnv());
    if (result.error || result.status !== 0) {
      const detail = (result.error?.message ?? (result.stderr.trim() || "non-zero exit")).slice(0, 500);
      throw new LightpandaContentError(`lightpanda fetch failed (status ${result.status ?? "null"}): ${detail}`, {
        ...(result.error ? { cause: result.error } : {}),
        exitStatus: result.status,
        stderr: result.stderr,
      });
    }
    if (dump === "structured_data") {
      return {
        url: request.url,
        format: request.format,
        dump,
        text: result.stdout,
        structured: parseStructuredDump(result.stdout),
      };
    }
    return {
      url: request.url,
      format: request.format,
      dump,
      text: result.stdout,
    };
  }
}

function firstLine(stdout: string): string {
  return stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function dumpFormat(format: LightpandaContentFormat): "markdown" | "structured_data" {
  switch (format) {
    case "markdown":
      return "markdown";
    case "structured":
      return "structured_data";
    default: {
      const exhaustive: never = format;
      throw new LightpandaContentError(`unknown content format: ${String(exhaustive)}`);
    }
  }
}

function contentFetchArgs(url: string, dump: "markdown" | "structured_data"): readonly string[] {
  return [
    "fetch",
    "--dump",
    dump,
    "--fail-on-http-error",
    "--log-level",
    "error",
    "--terminate-ms",
    LIGHTPANDA_TERMINATE_MS,
    "--obey-robots",
    url,
  ];
}

function parseStructuredDump(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new LightpandaContentError("structured extract was not valid JSON", { cause: error });
  }
  if (value === null || typeof value !== "object") {
    throw new LightpandaContentError("structured extract was not a JSON object or array");
  }
  return value;
}

function defaultVersionProbe(bin: string, args: readonly ["version"], env: NodeJS.ProcessEnv): LightpandaVersionProbe {
  const result = spawnSync(bin, [...args], {
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

function defaultFetch(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): LightpandaCommandResult {
  const result = spawnSync(bin, [...args], {
    encoding: "utf-8",
    timeout: LIGHTPANDA_FETCH_TIMEOUT_MS,
    env,
    windowsHide: true,
  });
  return {
    ...(result.error ? { error: result.error } : {}),
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
