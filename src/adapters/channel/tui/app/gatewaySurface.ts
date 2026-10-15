import type { Gateway } from "../../../../gateway/index.js";

/**
 * TUI 前端实际消费的 gateway 面（`#646` sweep P2.8 拆分产物）。
 *
 * 用 `Pick<>` 而非整体 `Gateway`：拆出的 actions/commands/keys 模块只依赖这 7 个方法，
 * 测试可注入窄 stub（`Gateway` 是 30+ 方法的大接口，全量 mock 会稀释判据）。
 * 完整 `Gateway` 结构性满足本类型，调用点零改动。
 */
export type TuiGatewaySurface = Pick<
  Gateway,
  | "listSessions"
  | "resumeSession"
  | "readSessionMessages"
  | "newSession"
  | "submitTurn"
  | "permissionDecide"
  | "abortTurn"
>;
