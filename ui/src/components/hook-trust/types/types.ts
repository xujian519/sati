/**
 * 项目级 hook 信任（协议 1.12）的 UI 类型。
 *
 * 与 `src/gateway/protocol/types.ts` 的 `GatewayHookTrust*` 手工镜像——两侧编译期
 * 互不约束（边界铁律：`ui/` 不导入 `src/`），入口处在 `parseHookTrustSnapshot` 收窄一次形状。
 */

export type HookTrustStatus = "trusted" | "pending" | "stale" | "revoked" | "blocked";

/** `blocked` 的结构化原因（#538）：与 `GatewayHookTrustEntry.blockedReason` 同口径。 */
export type HookTrustBlockedReason = "over_limit" | "unsafe_content";

export type HookDeclaration = {
  event: string;
  matcher?: string;
  kind: string;
  summary: string;
  condition?: string;
};

export type HookTrustEntry = {
  pluginId: string;
  pluginName: string;
  pluginRoot: string;
  status: HookTrustStatus;
  detail?: string;
  /** 仅 `status === "blocked"` 时有值；面板据此本地化提示（而非只渲染英文 `detail`）。 */
  blockedReason?: HookTrustBlockedReason;
  digest?: string;
  hooks: HookDeclaration[];
};

export type HookTrustSnapshot = {
  workspaceIdentityKey: string;
  entries: HookTrustEntry[];
};

export type HookTrustVerdict = "grant" | "revoke";
