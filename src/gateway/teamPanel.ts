/**
 * 团队活动面板数据（M4，T6）：gateway 侧纯函数——TeamDb 直查 + SessionPresence
 * 合并在线态，产出面板快照。不依赖工具注册表（数据面）；操作面（team_tool_call）
 * 在 createLocalGateway 内直调工具，权限/校验/事件走工具层既有链。
 * modelRoute 解析复用 team_status 视图同款 parseModelRouteJson（T2 收紧的全有或全无
 * 语义）：面板与 team_status 两视图不分裂（残缺路由统一展示 {}，不穿透成会话覆盖）。
 */
import type { TeamDb, TeamTaskRow } from "../agent/team/index.js";
import { parseModelRouteJson } from "../agent/team/index.js";
import type { SessionPresence } from "./server/sessionPresence.js";

export type PanelTeam = {
  id: string;
  name: string;
  captainSessionKey: string;
  createdAt: string;
  archivedAt?: string;
  captainOnline: boolean;
  members: Array<{
    memberId: string;
    roleSlug: string;
    status: "idle" | "working";
    modelRoute: { provider?: string; model?: string };
    retired: boolean;
  }>;
  tasks: Array<{
    taskId: string;
    subject: string;
    status: TeamTaskRow["status"];
    attempt: number;
    attemptId?: string;
    assigneeId?: string;
    dependencies: string[];
    blockedByCount: number;
    handoffId?: string;
    output?: string;
  }>;
  unreadForCaptain: number;
};

/** 全部团队（含归档）的面板列表；成员/任务按团队聚合。 */
export function listTeamsForPanel(db: TeamDb): Array<{ id: string; name: string; archivedAt?: string }> {
  return db
    .listTeams()
    .map(t => ({ id: t.id, name: t.name, ...(t.archivedAt !== undefined ? { archivedAt: t.archivedAt } : {}) }));
}

/** 面板快照：团队 + 成员在线/角色 + 任务 + 队长未读消息数（captainSessionKey 收件箱）。 */
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
      members: members
        .filter(m => m.teamId === team.id)
        .map(m => ({
          memberId: m.id,
          roleSlug: m.roleSlug,
          status: m.status,
          modelRoute: parseModelRouteJson(m.modelRouteJson),
          retired: db.isRetired(m.sessionKey),
        })),
      tasks: tasks
        .filter(t => t.teamId === team.id)
        .map(t => ({
          taskId: t.id,
          subject: t.subject,
          status: t.status,
          attempt: t.attempt,
          ...(t.attemptId !== undefined ? { attemptId: t.attemptId } : {}),
          ...(t.assigneeId !== undefined ? { assigneeId: t.assigneeId } : {}),
          dependencies: t.dependencies,
          blockedByCount: t.blockedByCount,
          ...(t.handoffId !== undefined ? { handoffId: t.handoffId } : {}),
          ...(t.output !== undefined ? { output: t.output } : {}),
        })),
      // 队长收件箱未投递消息（recipient = captainSessionKey 且 deliveredAt 未置位）
      unreadForCaptain: db.listMessages(team.id, team.captainSessionKey).filter(m => m.deliveredAt === undefined)
        .length,
    })),
  };
}
