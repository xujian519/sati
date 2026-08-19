/**
 * team_* 工具 barrel（M3）：当前阶段仅导出共享纯函数，9 工具由 T5-T8 各自追加 export
 * 并经 createLocalGateway 的 createBuiltinRegistry options.team 装配接线。
 */
export type { TeamToolsOptions } from "./teamUtils.js";
export {
  parseTeamSessionKey,
  isCaptainSession,
  resolveActor,
  requireTeamMember,
  requireCaptain,
  requireRegisteredRole,
  defaultModelRoute,
} from "./teamUtils.js";
