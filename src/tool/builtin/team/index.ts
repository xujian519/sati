/** team_* 工具 barrel（M3）：9 工具由 createLocalGateway 经 createBuiltinRegistry options.team 装配。 */
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
