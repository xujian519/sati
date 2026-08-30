import { spawnSync } from "node:child_process";
import type { BrowserBackend, BrowserBackendProbe, BrowserCapabilities } from "./types.js";

const BROWSEROS_NEO_DEFAULT_URL = "http://127.0.0.1:9010/mcp";

/**
 * BrowserOS neo backend —— 全平台备选首选（Track B 脚本兼容后端）。
 * 能力位（对齐 POC §3.1）：下载（download_file）与录屏（会话自动录制+回放）为超集；
 * handoff / siteTools 无对应，需 Sati 层实现。
 */
export class BrowserOsNeoBackend implements BrowserBackend {
  readonly id = "browseros-neo" as const;
  readonly label = "BrowserOS neo";
  readonly capabilities: BrowserCapabilities = {
    downloadInterception: true,
    screencast: true,
    handoff: false,
    siteTools: false,
    loginState: true,
    antiBot: true,
  };

  constructor(private options: { url?: string } = {}) {}

  async probe(): Promise<BrowserBackendProbe> {
    return probeBrowserOsNeo(this.options.url ?? process.env.SATI_BROWSEROS_MCP_URL ?? BROWSEROS_NEO_DEFAULT_URL);
  }
}

/** MCP Streamable HTTP：无 session 的 GET /mcp 返回 4xx/405 —— 任意响应（非 fetch 抛错）即端口有服务。 */
async function probeBrowserOsNeo(url: string): Promise<BrowserBackendProbe> {
  let httpStatus: number | undefined;
  let reachable = true;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    httpStatus = res.status;
  } catch {
    // fetch 抛错（连接拒绝/超时）：按端口不可达处理（fail-safe）
    reachable = false;
  }
  if (!reachable) {
    return {
      status: "missing",
      detail: `${url} — not reachable (install & launch BrowserOS neo, then copy the MCP URL from its new-tab sidebar)`,
      installHint: "https://browseros.com/agents",
    };
  }
  const owner = probePortOwner(new URL(url).port || "80");
  // 404 通常是其它 HTTP 服务占用端口（MCP /mcp 端点对无 session 的 GET 返回 405/406 而非 404），
  // 降级为 warn，避免 resolveBrowserBackend（只认 ok）把非 BrowserOS 的进程误选为后端。
  if (httpStatus === 404) {
    return {
      status: "warn",
      detail: `${url} — responded HTTP 404 (a service is listening on this port, but it is likely not BrowserOS neo)`,
      installHint: "https://browseros.com/agents",
    };
  }
  return {
    status: "ok",
    detail: `${url} — responded HTTP ${httpStatus}${owner ? ` · listening pid=${owner}` : ""}`,
  };
}

/** 只读归属探测（S4 缓解）：打印监听端口的 pid/进程名，供人工确认是 BrowserOS 而非恶意进程。 */
function probePortOwner(port: string): string | undefined {
  try {
    if (process.platform === "win32") {
      const out = spawnSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf-8",
        timeout: 3_000,
        windowsHide: true,
      });
      const line = out.stdout?.split("\n").find(l => l.includes(`:${port}`) && l.includes("LISTENING"));
      if (!line) return undefined;
      const pid = line.trim().split(/\s+/).pop();
      return pid && pid !== "0" ? pid : undefined;
    }
    const out = spawnSync("lsof", ["-nP", "-iTCP", `:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf-8",
      timeout: 3_000,
    });
    const header = out.stdout?.split("\n")[0];
    const first = out.stdout?.split("\n").find(l => !l.includes("COMMAND"));
    if (!header || !first) return undefined;
    const cols = header.split(/\s+/);
    const pidIndex = cols.indexOf("PID");
    const nameIndex = cols.indexOf("COMMAND");
    if (pidIndex < 0) return undefined;
    const parts = first.split(/\s+/);
    const pid = parts[pidIndex];
    const name = nameIndex >= 0 ? parts[nameIndex] : undefined;
    return name ? `${name}(${pid})` : pid;
  } catch {
    // 归属探测失败（命令缺失/超时）：跳过 pid 展示，不影响可用性判定
    return undefined;
  }
}
