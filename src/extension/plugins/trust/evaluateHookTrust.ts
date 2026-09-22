/**
 * 项目级 hook 信任评估（1.2a：只评估，不做任何拦截）。
 *
 * 评估面 = `source === "project"` 且**实际声明了 hook** 的插件。只算项目来源的理由：
 * 威胁形态是「打开/克隆一个仓库即执行任意命令」，而 `global` 在用户自己的
 * `~/.sati/plugins` 下、`builtin` 随发行版而来，都不在这个形态里。
 */
import { createHash } from "node:crypto";
import { findCanonicalProjectRoot } from "../../../shared/paths/findCanonicalProjectRoot.js";
import type { SatiLoadedPlugin } from "../protocol/plugin.js";
import { computeHookBundleDigest } from "./hookBundleDigest.js";
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
}): Promise<HookTrustEvaluation> {
  const entries: HookTrustEntry[] = [];
  for (const plugin of input.plugins) {
    if (plugin.source !== "project" || !declaresHooks(plugin)) continue;
    entries.push(await evaluatePlugin(plugin, input.workspaceIdentityKey, input.trustFile));
  }
  // 稳定顺序：报告签名按内容比对，顺序抖动不该造成「内容变了」的假象。
  entries.sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0));
  return { workspaceIdentityKey: input.workspaceIdentityKey, entries };
}

async function evaluatePlugin(
  plugin: SatiLoadedPlugin,
  workspaceIdentityKey: string,
  trustFile: HookTrustFile,
): Promise<HookTrustEntry> {
  const pluginId = `${plugin.name}@${plugin.source}`;
  const base = { pluginId, pluginName: plugin.name, source: plugin.source };
  const bundle = await computeHookBundleDigest(plugin.path, plugin.manifest);
  if (bundle.kind === "blocked") {
    return { ...base, status: "blocked", detail: bundle.detail };
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
