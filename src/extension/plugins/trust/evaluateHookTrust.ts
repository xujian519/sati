/**
 * 项目级 hook 信任评估（1.2a 只评估；1.2b 起评估结果决定是否装载）。
 *
 * 评估面 = `source === "project"` 且**实际声明了 hook** 的插件。只算项目来源的理由：
 * 威胁形态是「打开/克隆一个仓库即执行任意命令」，而 `global` 在用户自己的
 * `~/.sati/plugins` 下、`builtin` 随发行版而来，都不在这个形态里。
 */
import { createHash } from "node:crypto";
import type { SatiHookEvent } from "../../hooks/protocol/events.js";
import type { SatiHookMatcher, SatiHooksSettings } from "../../hooks/protocol/settings.js";
import { findCanonicalProjectRoot } from "../../../shared/paths/findCanonicalProjectRoot.js";
import type { SatiLoadedPlugin } from "../protocol/plugin.js";
import { computeHookBundleDigest, type HookBundleDigestComputer } from "./hookBundleDigest.js";
import { hookTrustKey } from "./HookTrustStore.js";
import type { HookTrustEntry, HookTrustEvaluation, HookTrustFile } from "./protocol.js";

/**
 * 工作区身份键 = 规范化项目根的 sha256 摘要（32 hex）。
 *
 * 为什么取摘要而不是路径：存储与日志都不该出现本机绝对路径（同「命令与路径不落库」的
 * 纪律）。为什么走 canonical：worktree 与主仓库要落到同一身份，否则同一个仓库在不同
 * worktree 下会各自要求授权；`findGitRoot` 有 LRU 缓存，装配期开销可忽略。
 */
export async function computeWorkspaceIdentityKey(projectRoot: string): Promise<string> {
  const canonical = await findCanonicalProjectRoot(projectRoot);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function declaresHooks(plugin: SatiLoadedPlugin): boolean {
  return Object.values(plugin.hooksConfig ?? {}).some(matchers => (matchers?.length ?? 0) > 0);
}

export async function evaluateProjectHookTrust(input: {
  plugins: SatiLoadedPlugin[];
  workspaceIdentityKey: string;
  trustFile: HookTrustFile;
  /**
   * 摘要计算入口（#538）。默认 `computeHookBundleDigest`（纯内容哈希，**强制路径必须用
   * 这个**：会话装配装载、授权决策）。报告/面板的**可见性**路径可注入
   * `computeHookBundleDigestForReport`（进程内 memo）以跳过重复全量读盘——但 memo 按
   * `(size, mtime)` 签名失效、不含内容，绝不可喂给强制路径（见 `hookBundleDigest.ts` 头注）。
   */
  computeDigest?: HookBundleDigestComputer;
}): Promise<HookTrustEvaluation> {
  const computeDigest = input.computeDigest ?? computeHookBundleDigest;
  const entries: HookTrustEntry[] = [];
  for (const plugin of input.plugins) {
    if (plugin.source !== "project" || !declaresHooks(plugin)) continue;
    entries.push(await evaluatePlugin(plugin, input.workspaceIdentityKey, input.trustFile, computeDigest));
  }
  // 稳定顺序：报告签名按内容比对，顺序抖动不该造成「内容变了」的假象。
  entries.sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0));
  return { workspaceIdentityKey: input.workspaceIdentityKey, entries };
}

async function evaluatePlugin(
  plugin: SatiLoadedPlugin,
  workspaceIdentityKey: string,
  trustFile: HookTrustFile,
  computeDigest: HookBundleDigestComputer,
): Promise<HookTrustEntry> {
  const pluginId = `${plugin.name}@${plugin.source}`;
  const base = { pluginId, pluginName: plugin.name, source: plugin.source };
  const bundle = await computeDigest(plugin.path, plugin.manifest);
  if (bundle.kind === "blocked") {
    return { ...base, status: "blocked", detail: bundle.detail, blockedReason: bundle.reason };
  }
  const record = trustFile.entries[hookTrustKey(workspaceIdentityKey, pluginId)];
  if (record === undefined) {
    return { ...base, status: "pending", digest: bundle.digest, detail: "hook declaration was never reviewed" };
  }
  // 撤销先于摘要比对：撤销是对「这个插件」的处置，不该因为内容回到旧版本而复活。
  if (record.decision === "revoked") {
    return { ...base, status: "revoked", digest: bundle.digest, detail: "hook declaration review was revoked" };
  }
  if (record.digest !== bundle.digest) {
    return {
      ...base,
      status: "stale",
      digest: bundle.digest,
      detail: "hook declaration changed since it was reviewed",
    };
  }
  return { ...base, status: "trusted", digest: bundle.digest };
}

/**
 * 只保留「来源可信」的 hook matcher（1.2b 强制期的执行面）。
 *
 * - `project` 来源：必须在评估里是 `trusted`（授权记录 + 摘要一致）才保留；
 *   其余状态（pending / stale / revoked / blocked）一律剔除。缺 `pluginId` 的
 *   project matcher 同样剔除——无法对应到评估记录就不算有证据。
 * - 其他来源（宿主注入的 gateway 权限回调、global、builtin）原样保留：它们不在
 *   「打开仓库即执行」的威胁形态里（global 属用户自己、builtin 随发行版、宿主回调
 *   是交互式提问通道）。
 *
 * 评估失败时**不要**调用退回原设置：调用方的 fail-closed 语义是「拿不到证据即按
 * 未评审处理」，即传空评估（见 `ProjectRuntimeRegistry.resolveTrustedHookSettings`）。
 */
export function retainTrustedHookMatchers(
  settings: SatiHooksSettings,
  evaluation: HookTrustEvaluation,
): SatiHooksSettings {
  const trusted = new Set(evaluation.entries.filter(entry => entry.status === "trusted").map(entry => entry.pluginId));
  const retained: SatiHooksSettings = {};
  for (const [event, matchers] of Object.entries(settings) as Array<[SatiHookEvent, SatiHookMatcher[] | undefined]>) {
    const kept = (matchers ?? []).filter(
      matcher => matcher.source !== "project" || (matcher.pluginId !== undefined && trusted.has(matcher.pluginId)),
    );
    if (kept.length > 0) retained[event] = kept;
  }
  return retained;
}
