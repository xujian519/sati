/**
 * 会话权限 hook / lifecycle 装配（P4a 第十刀，类内拆分）：从 ProjectRuntimeRegistry.prepareSessionRuntime 搬出。
 *
 * 这一段的全部意义在**一条不变式**：交给 gateway 权限 hook 的 `permissionRules.allow` 必须与
 * 稍后交给 `PermissionContext.rules.allow`（见 ./agentSessionConfig.ts）是**同一个数组引用**。
 * 因此本模块的 `getLiveRuleSet` 是取数函数而不是值——注册表在无显式会话覆盖时才会 mint 并缓存
 * per-session 活数组（`fallbackRuleSets`），本模块不得自造数组，否则同 turn 内 `remember=true`
 * 的授权对下一次工具调用不可见（远程客户端尤其明显）。
 */

import { HookRuntime, type SatiHooksSettings } from "../extension/index.js";
import type { InProcessGateway } from "../gateway/index.js";
import {
  createGatewayPermissionHook,
  GATEWAY_PERMISSION_CALLBACK_NAME,
} from "../gateway/permission/createGatewayPermissionHook.js";
import { LifecycleRuntime } from "../lifecycle/index.js";
import type { AgentSessionLiveRuleSet } from "./agentSessionConfig.js";

export type SessionLifecycleInput = {
  sessionKey: string;
  /** 插件贡献点快照的 hooks 段（refresh 之后取，按值传入）。 */
  hooks: SatiHooksSettings;
  /** 装配期读一次：无 gateway 时只装插件 hooks，不注册 gateway 回调。 */
  gateway: InProcessGateway | undefined;
  /** 取数：注册表按 sessionKey mint/缓存活规则集，hook 会就地写回它的 allow。 */
  getLiveRuleSet: () => AgentSessionLiveRuleSet;
};

/** 装配会话 lifecycle：把 gateway 的交互式权限 hook 挂到插件 hooks 之上。 */
export function buildSessionLifecycle(input: SessionLifecycleInput): LifecycleRuntime {
  // Inject the gateway's interactive permission hook so the agent's
  // PermissionRequest lifecycle is round-tripped through whichever
  // client is streaming this session (Web UI, TUI, etc.) instead of
  // returning `permission_required` errors. The hook mutates the
  // session's live `permissionRules.allow` array on `remember=true`,
  // so a subsequent tool call inside the same turn bypasses the ask
  // path without waiting for the next turn.
  //
  // We register unconditionally whenever a gateway is wired up. If no
  // client is actively streaming, `gw.emitForSession()` returns false
  // and the hook auto-denies — better than silently hanging.
  const gw = input.gateway;
  const liveRuleSet = input.getLiveRuleSet();
  const hookSettings: typeof input.hooks = gw
    ? {
        ...input.hooks,
        PermissionRequest: [
          ...(input.hooks.PermissionRequest ?? []),
          {
            hooks: [{ type: "callback", name: GATEWAY_PERMISSION_CALLBACK_NAME }],
          },
        ],
      }
    : input.hooks;
  const hookRuntime = new HookRuntime(hookSettings);
  if (gw) {
    hookRuntime.getCallbackExecutor().register(
      GATEWAY_PERMISSION_CALLBACK_NAME,
      createGatewayPermissionHook({
        sessionKey: input.sessionKey,
        bus: gw.getPermissionBus(),
        emit: event => gw.emitForSession(input.sessionKey, event),
        permissionRules: liveRuleSet.allow,
      }),
    );
  }
  const lifecycle = new LifecycleRuntime(hookRuntime);

  return lifecycle;
}
