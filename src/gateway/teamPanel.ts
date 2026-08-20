/**
 * 团队活动面板数据（M4，T6）：gateway 侧纯函数——TeamDb 直查 + SessionPresence
 * 合并在线态，产出面板快照。不依赖工具注册表（数据面）；操作面（team_tool_call）
 * 在 createLocalGateway 内直调工具，权限/校验/事件走工具层既有链。
 * 成员/任务视图复用 views.ts 共享映射（精简 B2）：面板与 team_status 两视图不分裂——
 * 残缺路由统一降级 {}（parseModelRouteJson 全有或全无语义），不穿透成会话覆盖。
 */
import type { TeamDb, TeamMemberView, TeamTaskView } from "../agent/team/index.js";
import { toMemberView, toTaskView } from "../agent/team/index.js";
import type { SessionPresence } from "./server/sessionPresence.js";

export type PanelTeam = {
  id: string;
  name: string;
  captainSessionKey: string;
  createdAt: string;
  archivedAt?: string;
  captainOnline: boolean;
  // 成员/任务视图形状与 team_status 工具共用（views.ts 单点定义，防两视图分裂）
  members: TeamMemberView[];
  tasks: TeamTaskView[];
};

/** 面板快照：团队 + 成员在线/角色 + 任务。 */
export function buildTeamPanelSnapshot(
  db: TeamDb,
  presence: SessionPresence,
  now: number = Date.now(),
): {
  teams: PanelTeam[];
} {
  const teams = db.listTeams();
  const members = db.listMembers();
  // TeamDb 无全量 listTasksAll/listMessagesAll（按团队查询）——聚合取每队数据。
  const tasks = teams.flatMap(team => db.listTasks(team.id));
  return {
    teams: teams.map(team => ({
      id: team.id,
      name: team.name,
      captainSessionKey: team.captainSessionKey,
      createdAt: team.createdAt,
      ...(team.archivedAt !== undefined ? { archivedAt: team.archivedAt } : {}),
      captainOnline: presence.isActive(team.captainSessionKey, now),
      members: members.filter(m => m.teamId === team.id).map(m => toMemberView(db, m)),
      tasks: tasks.filter(t => t.teamId === team.id).map(toTaskView),
    })),
  };
}
