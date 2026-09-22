/**
 * 项目级 hook 信任（1.2a 报告期）的类型契约。
 *
 * 缺口：项目目录里的 `.sati/plugins/<plugin>/hooks/hooks.json` 被无条件发现并装载，
 * `type: "command"` 直接 spawn shell——克隆一个带该文件的仓库等于执行任意命令，
 * 用户既不被询问、也看不到来源。本阶段只让风险**可见**（评估 + 上报），
 * 不改变任何执行行为；未信任即不装载、以及审批交互属于 1.2b。
 */
import type { SatiPluginSourceKind } from "../protocol/plugin.js";

/** 信任存储版本：未知版本一律按空表处理（读路径 fail-closed）。 */
export const HOOK_TRUST_STORE_VERSION = 1;

export type HookTrustDecision = "granted" | "revoked";

export type HookTrustRecord = {
  /** `${name}@${source}`，与 `SatiHookMatcher.pluginId` 同口径。 */
  pluginId: string;
  decision: HookTrustDecision;
  /** 授权时的插件目录内容摘要（`sha256:<hex>`）。 */
  digest: string;
  grantedAt: string;
  /** 授权时看到的插件目录绝对路径：只落本地存储，不进日志/遥测。 */
  sourcePath: string;
};

export type HookTrustFile = {
  version: number;
  /** key = `${workspaceIdentityKey}|${pluginId}`（见 `hookTrustKey`）。 */
  entries: Record<string, HookTrustRecord>;
};

/**
 * - `trusted`：有授权记录且内容摘要一致。
 * - `pending`：从未评审过（无记录）。
 * - `stale`：同一槽位有记录但摘要不同——声明被改过，授权不作数。
 * - `revoked`：记录为撤销（即使摘要一致也不是信任）。
 * - `blocked`：无法建立可信摘要（声明指向插件目录之外、含符号链接、超出哈希上限）。
 */
export type HookTrustStatus = "trusted" | "pending" | "stale" | "revoked" | "blocked";

export type HookTrustEntry = {
  pluginId: string;
  pluginName: string;
  source: SatiPluginSourceKind;
  status: HookTrustStatus;
  /** 证据缺失/失效的原因（`trusted` 之外才有：没有原因就无法人工复核）。 */
  detail?: string;
  /** 本次看到的目录内容摘要；`blocked` 时缺省（算不出来）。 */
  digest?: string;
};

export type HookTrustEvaluation = {
  /** 工作区身份摘要，见 `computeWorkspaceIdentityKey`。 */
  workspaceIdentityKey: string;
  entries: HookTrustEntry[];
};
