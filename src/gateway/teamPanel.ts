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

/** 按 teamId 分组一次（保序：桶内顺序 = 原数组顺序，与逐队 filter 等价）。 */
function groupByTeam<T>(rows: T[], teamIdOf: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const teamId = teamIdOf(row);
    const bucket = grouped.get(teamId);
    if (bucket === undefined) {
      grouped.set(teamId, [row]);
    } else {
      bucket.push(row);
    }
  }
  return grouped;
}

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
  // #531：退休集合一次查回（替代逐成员 isRetired 的 O(成员) 次同步 SQL）；成员/任务各按
  // teamId 分组一次，替代 teams.map 内对两份全量数组逐队 filter（O(团队×成员) → O(团队+成员)）。
  // 授权面行为不变（T6 评审取舍）：在线态仍逐队 presence.isActive，分组只省重复扫描。
  const retired = db.listRetiredSessionKeys();
  const membersByTeam = groupByTeam(members, member => member.teamId);
  const tasksByTeam = groupByTeam(tasks, task => task.teamId);
  return {
    teams: teams.map(team => ({
      id: team.id,
      name: team.name,
      captainSessionKey: team.captainSessionKey,
      createdAt: team.createdAt,
      ...(team.archivedAt !== undefined ? { archivedAt: team.archivedAt } : {}),
      captainOnline: presence.isActive(team.captainSessionKey, now),
      members: (membersByTeam.get(team.id) ?? []).map(member => toMemberView(member, retired)),
      tasks: (tasksByTeam.get(team.id) ?? []).map(toTaskView),
    })),
  };
}
