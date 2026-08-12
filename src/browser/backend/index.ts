import { BrowserOsNeoBackend } from "./browserosNeoBackend.js";
import { BrowserUsePyBackend } from "./browserUsePyBackend.js";
import { EgoBackend } from "./egoBackend.js";
import { PlaywrightMcpBackend } from "./playwrightBackend.js";
import type { BrowserBackend, BrowserBackendId, BrowserBackendProbe } from "./types.js";

export * from "./types.js";
export { BROWSEROS_NEO_DEFAULT_URL, probeBrowserOsNeo } from "./browserosNeoBackend.js";
export { probeBrowserUse } from "./browserUsePyBackend.js";
export { EgoBackend } from "./egoBackend.js";
export { BrowserOsNeoBackend } from "./browserosNeoBackend.js";
export { BrowserUsePyBackend } from "./browserUsePyBackend.js";
export { PlaywrightMcpBackend } from "./playwrightBackend.js";

export type BackendRouteOptions = {
  /** 平台覆盖（测试用），默认 process.platform。 */
  platform?: NodeJS.Platform;
  /** 是否执行 ego 连接探针（更慢但更准）。 */
  doctorCheck?: boolean;
  /** BrowserOS neo MCP endpoint（默认 127.0.0.1:9010/mcp，可用 env SATI_BROWSEROS_MCP_URL 覆盖）。 */
  browserosUrl?: string;
  /** 用户显式偏好（sati.yaml `browser.preferredBackend`），优先排序。 */
  prefer?: BrowserBackendId;
  /** 排除的候选（测试/配置用）。 */
  exclude?: BrowserBackendId[];
};

/**
 * 生成有序候选列表（cold decision 数据源）。
 *
 * 默认优先级 = 方案文档 §5.1 级联顺序：ego → BrowserOS neo → browser-use → @playwright/mcp。
 * `prefer` 将指定后端提到最前（唯一允许的排序调整）。平台适配由各后端 probe 自洽
 * （eg. EgoBackend 在非 darwin 上自然 probe 为 missing），路由器不重复判断平台。
 */
export function buildBackendCandidates(options: BackendRouteOptions = {}): BrowserBackend[] {
  const backends: BrowserBackend[] = [
    new EgoBackend({ platform: options.platform, doctorCheck: options.doctorCheck }),
    new BrowserOsNeoBackend({ url: options.browserosUrl }),
    new BrowserUsePyBackend(),
    new PlaywrightMcpBackend(),
  ];
  const exclude = options.exclude ?? [];
  const filtered = exclude.length ? backends.filter(b => !exclude.includes(b.id)) : backends;
  if (!options.prefer) return filtered;
  const preferred = filtered.find(b => b.id === options.prefer);
  if (!preferred) {
    // prefer 目标被 exclude 排除：静默丢弃会让用户显式偏好失效，给出诊断
    console.warn(
      `sati: preferred browser backend "${options.prefer}" is excluded by the exclude list — ignoring prefer.`,
    );
    return filtered;
  }
  return [preferred, ...filtered.filter(b => b.id !== options.prefer)];
}

/**
 * Cold decision 解析：取第一个 probe ok 的后端。
 * 只允许在任务/会话开始前调用一次；任务运行中禁止再调（评审 §S3 的 warm-switch 禁令）。
 * 全部不可用时抛错，错误信息引导 `sati browsers`。
 */
export async function resolveBrowserBackend(options: BackendRouteOptions = {}): Promise<BrowserBackend> {
  for (const backend of buildBackendCandidates(options)) {
    let probe: BrowserBackendProbe;
    try {
      probe = await backend.probe();
    } catch {
      continue; // probe 异常按不可用处理，不阻断级联
    }
    if (probe.status === "ok") return backend;
  }
  throw new Error(
    "No browser backend available on this machine. Run `sati browsers` for the per-backend install guide.",
  );
}

export type BackendProbeResult = {
  backend: BrowserBackend;
  probe: BrowserBackendProbe;
};

/** 探测全部候选（`sati browsers` 使用），不短路。 */
export async function probeAllBackends(options: BackendRouteOptions = {}): Promise<BackendProbeResult[]> {
  const results: BackendProbeResult[] = [];
  for (const backend of buildBackendCandidates(options)) {
    let probe: BrowserBackendProbe;
    try {
      probe = await backend.probe();
    } catch (error) {
      probe = { status: "warn", detail: `probe error: ${error instanceof Error ? error.message : String(error)}` };
    }
    results.push({ backend, probe });
  }
  return results;
}
