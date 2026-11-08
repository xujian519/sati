import { createLogger } from "../../telemetry/index.js";
import { BrowserOsNeoBackend } from "./browserosNeoBackend.js";
import { BrowserUsePyBackend } from "./browserUsePyBackend.js";
import { EgoBackend } from "./egoBackend.js";
import { LightpandaBackend } from "./lightpandaBackend.js";
import type { LightpandaVersionProber } from "./lightpandaBackend.js";
import { PlaywrightMcpBackend } from "./playwrightBackend.js";
import type {
  BrowserBackend,
  BrowserBackendId,
  BrowserBackendProbe,
  BrowserTaskNeed,
  BrowserTaskNeeds,
} from "./types.js";

const logger = createLogger("sati");

export * from "./types.js";
export { EgoBackend } from "./egoBackend.js";
export { BrowserOsNeoBackend } from "./browserosNeoBackend.js";
export { BrowserUsePyBackend } from "./browserUsePyBackend.js";
export { LightpandaBackend, LIGHTPANDA_SESSION_POLICY, lightpandaChildEnv } from "./lightpandaBackend.js";
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
  /**
   * 把可选的 Lightpanda 追加到级联末尾。默认关闭，因此不会插到
   * ego → browseros-neo → browser-use → playwright 前面。
   * `prefer: "lightpanda"` 同样视为显式启用。
   */
  includeLightpanda?: boolean;
  /** 任务能力需求。不满足的后端直接跳过，继续后面的候选。 */
  needs?: BrowserTaskNeeds;
  /** Lightpanda 可执行文件路径（测试 / 非 PATH 安装）。 */
  lightpandaBin?: string;
  /** 测试注入：替换 `lightpanda version` 探测。 */
  lightpandaSpawn?: LightpandaVersionProber;
};

/**
 * 生成有序候选列表（cold decision 数据源）。
 *
 * 默认优先级 = 方案文档 §5.1 级联顺序：ego → BrowserOS neo → browser-use → @playwright/mcp。
 * Lightpanda 默认不进入该列表；显式启用时只追加在末尾，再由 `prefer` 决定是否提前。
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
  if (options.includeLightpanda === true || options.prefer === "lightpanda") {
    backends.push(
      new LightpandaBackend({
        platform: options.platform,
        ...(options.lightpandaBin ? { bin: options.lightpandaBin } : {}),
        ...(options.lightpandaSpawn ? { spawnVersion: options.lightpandaSpawn } : {}),
      }),
    );
  }
  const exclude = options.exclude ?? [];
  const filtered = exclude.length ? backends.filter(b => !exclude.includes(b.id)) : backends;
  if (!options.prefer) return filtered;
  const preferred = filtered.find(b => b.id === options.prefer);
  if (!preferred) {
    // prefer 目标被 exclude 排除：静默丢弃会让用户显式偏好失效，给出诊断
    logger.warn(`preferred browser backend "${options.prefer}" is excluded by the exclude list — ignoring prefer.`);
    return filtered;
  }
  return [preferred, ...filtered.filter(b => b.id !== options.prefer)];
}

const BROWSER_TASK_NEEDS = [
  "content",
  "loginState",
  "antiBot",
  "pdf",
  "trueScreenshot",
  "handoff",
] as const satisfies readonly BrowserTaskNeed[];

function capabilityForNeed(backend: BrowserBackend, need: BrowserTaskNeed): boolean {
  switch (need) {
    case "content":
      return backend.capabilities.contentCapable;
    case "loginState":
      return backend.capabilities.loginState;
    case "antiBot":
      return backend.capabilities.antiBot;
    case "pdf":
      return backend.capabilities.pdf;
    case "trueScreenshot":
      return backend.capabilities.trueScreenshot;
    case "handoff":
      return backend.capabilities.handoff;
    default: {
      const exhaustive: never = need;
      throw new Error(`unknown browser task need: ${String(exhaustive)}`);
    }
  }
}

/** 候选是否满足全部为 true 的需求。未声明的能力位不参与。 */
export function backendMeetsNeeds(backend: BrowserBackend, needs: BrowserTaskNeeds): boolean {
  for (const need of BROWSER_TASK_NEEDS) {
    if (needs[need] === true && !capabilityForNeed(backend, need)) return false;
  }
  return true;
}

/** 按级联顺序取第一个满足需求的后端。不做 probe。 */
export function selectBackendForTask(
  candidates: readonly BrowserBackend[],
  needs: BrowserTaskNeeds = {},
): BrowserBackend | undefined {
  return candidates.find(backend => backendMeetsNeeds(backend, needs));
}

function formatNeeds(needs: BrowserTaskNeeds): string {
  return BROWSER_TASK_NEEDS.filter(need => needs[need] === true).join(", ");
}

/**
 * Cold decision 解析：取第一个能力匹配且 probe ok 的后端。
 * 只允许在任务/会话开始前调用一次；任务运行中禁止再调（评审 §S3 的 warm-switch 禁令）。
 * 能力不匹配或 probe 失败都继续下一个候选。全部不可用时抛错，错误信息引导 `sati browsers`。
 */
export async function resolveBrowserBackend(options: BackendRouteOptions = {}): Promise<BrowserBackend> {
  for (const backend of buildBackendCandidates(options)) {
    if (options.needs && !backendMeetsNeeds(backend, options.needs)) {
      const unmet = formatNeeds(options.needs) || "none";
      logger.warn(`browser backend "${backend.id}" skipped: capabilities do not meet task needs (${unmet})`);
      continue;
    }
    let probe: BrowserBackendProbe;
    try {
      probe = await backend.probe();
    } catch {
      continue; // probe 异常按不可用处理，不阻断级联
    }
    if (probe.status === "ok") return backend;
  }
  const needs = options.needs ? formatNeeds(options.needs) : "";
  const needsClause = needs ? ` Task needs not met by any available candidate: ${needs}.` : "";
  const hint = "Run `sati browsers` for the per-backend install guide.";
  throw new Error(`No browser backend available on this machine.${needsClause} ${hint}`);
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
