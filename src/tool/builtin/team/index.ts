/**
 * team_* 工具 barrel（M3）：管理面 3 工具（T5）+ 任务池 3 工具（T6）已导出，
 * 邮箱/状态/归档 3 工具由 T7-T8 追加 export，并经 createLocalGateway 的 createBuiltinRegistry options.team 装配接线。
 */
export { createTeamCreateTool, createTeamAddMemberTool, createTeamRemoveMemberTool } from "./teamManagement.js";
export { createTeamCreateTaskTool, createTeamUpdateTaskTool, createTeamReassignTaskTool } from "./teamTasks.js";
export { createTeamSendMessageTool } from "./teamMailbox.js";
export { createTeamStatusTool } from "./teamStatus.js";
export { createTeamArchiveTool } from "./teamArchive.js";
export type { TeamToolsOptions } from "./teamUtils.js";
export {
  parseTeamSessionKey,
  isCaptainSession,
  resolveActor,
  requireTeamMember,
  requireCaptain,
  requireTeamCaptain,
  requireRegisteredRole,
  assertTeamActive,
  defaultModelRoute,
} from "./teamUtils.js";
