/**
 * 团队视图映射（精简 B2）：team_status 工具与活动面板快照两视图共享的
 * 行 → 视图纯函数。提取前两处逐字重复（teamStatus.ts 与 teamPanel.ts），
 * 提取后视图字段增改只需动本文件单点。
 * 放 agent/team 侧而非 tool/gateway 侧：tool 层依赖 agent/team，反向会循环。
 */
import { parseModelRouteJson } from "./member/modelRouteJson.js";
import type { TeamDb, TeamMemberRow, TeamTaskRow } from "./storage/team-db.js";

export type TeamMemberView = {
  memberId: string;
  roleSlug: string;
  status: "idle" | "working";
  /** 残缺路由降级为空对象（parseModelRouteJson 全有或全无语义，不穿透成会话覆盖）。 */
  modelRoute: { provider?: string; model?: string };
  retired: boolean;
};

export type TeamTaskView = {
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
};

export function toMemberView(db: TeamDb, member: TeamMemberRow): TeamMemberView {
  return {
    memberId: member.id,
    roleSlug: member.roleSlug,
    status: member.status,
    modelRoute: parseModelRouteJson(member.modelRouteJson),
    retired: db.isRetired(member.sessionKey),
  };
}

export function toTaskView(task: TeamTaskRow): TeamTaskView {
  return {
    taskId: task.id,
    subject: task.subject,
    status: task.status,
    attempt: task.attempt,
    ...(task.attemptId !== undefined ? { attemptId: task.attemptId } : {}),
    ...(task.assigneeId !== undefined ? { assigneeId: task.assigneeId } : {}),
    dependencies: task.dependencies,
    blockedByCount: task.blockedByCount,
    ...(task.handoffId !== undefined ? { handoffId: task.handoffId } : {}),
    ...(task.output !== undefined ? { output: task.output } : {}),
  };
}
