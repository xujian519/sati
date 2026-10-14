/**
 * `sati server` 的可变运行时状态（P2.7 从 `cli/sati.ts` 的 `main` 闭包 `let` 绑定搬出）。
 *
 * 原实现用闭包可变绑定表达三件事：① 子系统热重载会**整体替换** `alwaysOn` / `cron`；
 * ② `serverRef` 在 server 监听成功后写入，供 `setPrepareWeixinLogin`、适配器热重载与
 * cron 结果投递在**事件发生时**读取；③ `deferredBroadcast` 在 server 就绪前是 undefined，
 * 调用方一律走 `?.()`（静默丢弃启动前的事件）。改为具名属性后**读取时机完全不变**
 * （都在回调或后续语句里读），故构造期的先后依赖逐字保留。
 */

import type { AlwaysOnManager } from "../../always-on/index.js";
import type { CronManager } from "../../cron/index.js";
import type { startSatiServer } from "../satiServer.js";

export type SatiServerHandle = Awaited<ReturnType<typeof startSatiServer>>;

export type ServerRuntimeState = {
  alwaysOn?: AlwaysOnManager;
  cron?: CronManager;
  server?: SatiServerHandle;
  /** server 未就绪时是 no-op（等价原 `deferredBroadcast?.()` 的可选调用语义）。 */
  broadcast(name: string, payload?: unknown): void;
};

export function createServerRuntimeState(): ServerRuntimeState {
  const state: ServerRuntimeState = {
    broadcast: () => {},
  };
  state.broadcast = (name, payload) => {
    state.server?.broadcastNotification(name, payload);
  };
  return state;
}
