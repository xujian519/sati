/**
 * team_* 工具 barrel（M3）：管理面 3 工具（T5）已导出，作业面/邮箱/状态/归档 6 工具由 T6-T8 追加 export，
 * 并经 createLocalGateway 的 createBuiltinRegistry options.team 装配接线。
 */
export { createTeamCreateTool, createTeamAddMemberTool, createTeamRemoveMemberTool } from "./teamManagement.js";
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
