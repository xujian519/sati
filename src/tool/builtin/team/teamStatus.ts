/**
 * 团队状态工具（M3）：team_status——三视图只读（团队概览/成员状态/任务列表），
 * 纯查询无副作用（isReadOnly: true）。作业面（domain: "team"）：队长与成员均可查。
 * 成员视图含 status/roleSlug/modelRoute（modelRouteJson 解析）/retired；任务视图含
 * status/attempt/assigneeId/dependencies/blockedByCount/handoffId/output。
 * 全锁外纯查询（只读无锁）；成员校验仅校验身份（不返回使用）。
 */
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../../protocol/types.js";
import type { TeamTaskStatus } from "../../../agent/team/index.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import { requireTeamMember, resolveActor, type TeamToolsOptions } from "./teamUtils.js";

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
      "Read-only snapshot of a team: overview (id/name/captain), members (id/roleSlug/status/modelRoute/retired), and tasks (id/subject/status/attempt/assignee/dependencies/blockedByCount/handoffId/output). Captain and team members can both call it.",
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
          modelRoute: JSON.parse(m.modelRouteJson) as unknown,
          retired: db.isRetired(m.sessionKey),
        }));
      const tasks = db.listTasks(input.teamId).map(t => ({
        taskId: t.id,
        subject: t.subject,
        status: t.status,
        attempt: t.attempt,
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
