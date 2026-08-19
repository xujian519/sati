/**
 * 团队状态工具（M3）：team_status——三视图只读（团队概览/成员状态/任务列表），
 * 纯查询无副作用（isReadOnly: true）。作业面（domain: "team"）：队长与成员均可查。
 * 成员视图含 status/roleSlug/modelRoute（modelRouteJson 解析，脏数据降级为空对象——
 * 对齐 scheduler「损坏行跳过不阻塞」语义，且降级值过 outputSchema object 校验）/retired；
 * 任务视图含 status/attempt/attemptId/assigneeId/dependencies/blockedByCount/handoffId/output。
 * 全锁外纯查询（只读无锁）；成员校验仅校验身份（不返回使用）。
 * 会话 fail-closed（quality review）：畸形/净化成员会话（pattern 命中但解析失败）
 * 抛 team_actor_unknown，与 update_task 对同形态会话行为一致。
 */
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../../protocol/types.js";
import type { TeamTaskStatus } from "../../../agent/team/index.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import { TEAM_MEMBER_SESSION_PATTERN, requireTeamMember, resolveActor, type TeamToolsOptions } from "./teamUtils.js";

/**
 * modelRouteJson 解析：脏数据（非法 JSON / 非对象）降级为空对象——
 * 视图不抛错、不阻塞整个成员列表（对齐 scheduler 损坏行跳过语义），
 * 且 `{}` 能过 outputSchema 的 `modelRoute: { type: "object" }` 校验
 * （自研校验器 isPlainObject 拒绝 null）。
 */
function parseModelRoute(json: string): unknown {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // 非法 JSON：走降级
  }
  return {};
}

export type TeamStatusInput = { teamId: string };
export type TeamStatusOutput = {
  team: { id: string; name: string; captainSessionKey: string; createdAt: string };
  members: Array<{
    memberId: string;
    roleSlug: string;
    status: "idle" | "working";
    modelRoute: unknown;
    retired: boolean;
  }>;
  tasks: Array<{
    taskId: string;
    subject: string;
    status: TeamTaskStatus;
    attempt: number;
    attemptId?: string;
    assigneeId?: string;
    dependencies: string[];
    blockedByCount: number;
    handoffId?: string;
    output?: string;
  }>;
};

export function createTeamStatusTool(options: TeamToolsOptions): SatiToolDefinition<TeamStatusInput, TeamStatusOutput> {
  const { db } = options;
  return {
    name: "team_status",
    outputSchema: {
      type: "object",
      required: ["team", "members", "tasks"],
      properties: {
        team: {
          type: "object",
          required: ["id", "name", "captainSessionKey", "createdAt"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            captainSessionKey: { type: "string" },
            createdAt: { type: "string" },
          },
        },
        members: {
          type: "array",
          items: {
            type: "object",
            required: ["memberId", "roleSlug", "status", "modelRoute", "retired"],
            properties: {
              memberId: { type: "string" },
              roleSlug: { type: "string" },
              status: { type: "string" },
              modelRoute: { type: "object", properties: {} },
              retired: { type: "boolean" },
            },
          },
        },
        tasks: {
          type: "array",
          items: {
            type: "object",
            required: ["taskId", "subject", "status", "attempt", "dependencies", "blockedByCount"],
            properties: {
              taskId: { type: "string" },
              subject: { type: "string" },
              status: { type: "string" },
              attempt: { type: "number" },
              attemptId: { type: "string" },
              assigneeId: { type: "string" },
              dependencies: { type: "array", items: { type: "string" } },
              blockedByCount: { type: "number" },
              handoffId: { type: "string" },
              output: { type: "string" },
            },
          },
        },
      },
    },
    description:
      "Read-only snapshot of a team: overview (id/name/captain), members (id/roleSlug/status/modelRoute/retired), and tasks (id/subject/status/attempt/attemptId/assignee/dependencies/blockedByCount/handoffId/output). Captain and team members can both call it.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId"],
      additionalProperties: false,
      properties: { teamId: { type: "string", description: "Team id." } },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamStatusOutput>> => {
      const actor = resolveActor(context.sessionId);
      // 畸形/净化成员会话（pattern 命中但解析失败，actor === undefined）fail-closed：
      // 信息丢失不可判定身份，绝不放行
      if (actor === undefined && TEAM_MEMBER_SESSION_PATTERN.test(context.sessionId ?? "")) {
        throw new SatiToolRuntimeError("team_actor_unknown", "无法判定调用者会话身份（成员会话形态畸形）");
      }
      if (actor !== undefined && !actor.captain) {
        requireTeamMember(db, actor, input.teamId); // 成员校验（仅校验身份，不返回使用）
      }
      const team = db.getTeam(input.teamId);
      if (team === undefined) {
        throw new SatiToolRuntimeError("team_not_found", `团队不存在：${input.teamId}`);
      }
      const members = db
        .listMembers()
        .filter(m => m.teamId === input.teamId)
        .map(m => ({
          memberId: m.id,
          roleSlug: m.roleSlug,
          status: m.status,
          modelRoute: parseModelRoute(m.modelRouteJson),
          retired: db.isRetired(m.sessionKey),
        }));
      const tasks = db.listTasks(input.teamId).map(t => ({
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
      }));
      return {
        content: [
          {
            type: "text",
            text: `team_status team=${team.id} members=${members.length} tasks=${tasks.length}`,
          },
        ],
        data: {
          team: {
            id: team.id,
            name: team.name,
            captainSessionKey: team.captainSessionKey,
            createdAt: team.createdAt,
          },
          members,
          tasks,
        },
      };
    },
  };
}
