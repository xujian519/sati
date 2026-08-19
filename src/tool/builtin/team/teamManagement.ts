/**
 * 团队管理工具（M3）：team_create / team_add_member / team_remove_member。
 * 全部为管理面（domain: "team:manage"，Task 9 注册打标）——requireTeamCaptain 同队自守；
 * 建队/招募/移除均锁内 read-modify-write，事件锁内发出；本批 3 工具均不触发调度
 * （remove_member 回池任务置 reassigning 由 nextReadyTask 跳过，队长经事件知情）。
 */
import { randomUUID } from "node:crypto";
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../../protocol/types.js";
import {
  TERMINAL_TASK_STATUSES,
  createTeamMember,
  invalidateTaskAttempt,
  withTeamLock,
} from "../../../agent/team/index.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import {
  defaultModelRoute,
  requireCaptain,
  requireRegisteredRole,
  requireTeamCaptain,
  resolveActor,
  type TeamToolsOptions,
} from "./teamUtils.js";

/** 移除成员缺省原因（队长未提供时）。 */
const REMOVED_REASON_DEFAULT = "removed_by_captain";

export type TeamCreateInput = { name: string; memberRoleSlugs?: string[] };
export type TeamCreateOutput = {
  teamId: string;
  name: string;
  captainSessionKey: string;
  members: Array<{ memberId: string; roleSlug: string }>;
};

export function createTeamCreateTool(options: TeamToolsOptions): SatiToolDefinition<TeamCreateInput, TeamCreateOutput> {
  const { db, emit } = options;
  return {
    name: "team_create",
    outputSchema: {
      type: "object",
      required: ["teamId", "name", "captainSessionKey", "members"],
      properties: {
        teamId: { type: "string" },
        name: { type: "string" },
        captainSessionKey: { type: "string" },
        members: {
          type: "array",
          items: {
            type: "object",
            required: ["memberId", "roleSlug"],
            properties: { memberId: { type: "string" }, roleSlug: { type: "string" } },
          },
        },
      },
    },
    description:
      "Create a team with the current session as captain. Optionally recruit the first members by registered roleSlug (e.g. 'researcher', 'case-manager'). Returns the new teamId, captainSessionKey, and the recruited members. Captain-only.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Team display name (e.g. 'patent-team-2026001')." },
        memberRoleSlugs: {
          type: "array",
          items: { type: "string" },
          description: "Optional initial member roleSlugs (must be registered roles).",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamCreateOutput>> => {
      const actor = resolveActor(context.sessionId);
      requireCaptain(actor);
      for (const roleSlug of input.memberRoleSlugs ?? []) requireRegisteredRole(roleSlug);
      const teamId = `t-${randomUUID().slice(0, 8)}`;
      const members: Array<{ memberId: string; roleSlug: string }> = [];
      await withTeamLock(teamId, async () => {
        // 随机 8 位前缀碰撞理论概率极低，但一旦发生即响亮失败（upsert 会静默覆盖）
        if (db.getTeam(teamId) !== undefined) {
          throw new SatiToolRuntimeError("team_already_exists", `团队 id 碰撞，请重试：${teamId}`);
        }
        db.upsertTeam({
          id: teamId,
          name: input.name,
          captainSessionKey: context.sessionId,
          createdAt: new Date().toISOString(),
        });
        emit(context.sessionId, {
          type: "team_created",
          teamId,
          name: input.name,
          captainSessionKey: context.sessionId,
        });
        for (const roleSlug of input.memberRoleSlugs ?? []) {
          const memberId = `m-${randomUUID().slice(0, 8)}`;
          createTeamMember(db, { teamId, memberId, roleSlug, modelRoute: defaultModelRoute(context) });
          members.push({ memberId, roleSlug });
          emit(context.sessionId, { type: "member_added", teamId, memberId, roleSlug });
        }
      });
      return {
        content: [{ type: "text", text: `team_create teamId=${teamId} name=${input.name} members=${members.length}` }],
        data: { teamId, name: input.name, captainSessionKey: context.sessionId, members },
      };
    },
  };
}

export type TeamAddMemberInput = { teamId: string; roleSlug: string };
export type TeamAddMemberOutput = { teamId: string; memberId: string; roleSlug: string };

export function createTeamAddMemberTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamAddMemberInput, TeamAddMemberOutput> {
  const { db, emit } = options;
  return {
    name: "team_add_member",
    outputSchema: {
      type: "object",
      required: ["teamId", "memberId", "roleSlug"],
      properties: {
        teamId: { type: "string" },
        memberId: { type: "string" },
        roleSlug: { type: "string" },
      },
    },
    description:
      "Recruit a new team member with a registered roleSlug (e.g. 'researcher', 'adversarial-reviewer'). The member inherits the captain's model route. Captain-only.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId", "roleSlug"],
      additionalProperties: false,
      properties: {
        teamId: { type: "string", description: "Team id from team_create." },
        roleSlug: { type: "string", description: "Registered role id (team roleSlug)." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamAddMemberOutput>> => {
      requireRegisteredRole(input.roleSlug);
      let memberId = "";
      await withTeamLock(input.teamId, async () => {
        const team = requireTeamCaptain(db, context.sessionId, input.teamId);
        memberId = `m-${randomUUID().slice(0, 8)}`;
        createTeamMember(db, {
          teamId: input.teamId,
          memberId,
          roleSlug: input.roleSlug,
          modelRoute: defaultModelRoute(context),
        });
        emit(team.captainSessionKey, {
          type: "member_added",
          teamId: input.teamId,
          memberId,
          roleSlug: input.roleSlug,
        });
      });
      return {
        content: [{ type: "text", text: `team_add_member memberId=${memberId} role=${input.roleSlug}` }],
        data: { teamId: input.teamId, memberId, roleSlug: input.roleSlug },
      };
    },
  };
}

export type TeamRemoveMemberInput = { teamId: string; memberId: string; reason?: string };
export type TeamRemoveMemberOutput = { teamId: string; memberId: string; removed: boolean };

export function createTeamRemoveMemberTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamRemoveMemberInput, TeamRemoveMemberOutput> {
  const { db, emit } = options;
  return {
    name: "team_remove_member",
    outputSchema: {
      type: "object",
      required: ["teamId", "memberId", "removed"],
      properties: { teamId: { type: "string" }, memberId: { type: "string" }, removed: { type: "boolean" } },
    },
    description:
      "Retire a team member (irreversible): the member can no longer be woken, and their open tasks return to the pool in the 'reassigning' state (not auto-dispatched until the captain reassigns them). Captain-only.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId", "memberId"],
      additionalProperties: false,
      properties: {
        teamId: { type: "string", description: "Team id." },
        memberId: { type: "string", description: "Member id from team_create/team_add_member." },
        reason: { type: "string", description: "Optional retirement reason." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => true,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamRemoveMemberOutput>> => {
      await withTeamLock(input.teamId, async () => {
        const team = requireTeamCaptain(db, context.sessionId, input.teamId);
        const member = db.getMember(input.memberId);
        if (member === undefined || member.teamId !== input.teamId) {
          throw new SatiToolRuntimeError("team_not_member", `团队成员不存在：${input.memberId}`);
        }
        if (db.isRetired(member.sessionKey)) {
          throw new SatiToolRuntimeError("team_member_retired", `团队成员已退休：${input.memberId}`);
        }
        db.insertRetired(member.sessionKey, member.id, input.reason ?? REMOVED_REASON_DEFAULT);
        // 名下 open 任务 invalidate 回池（reassigning 暂缓自动派发，等队长处置）
        for (const task of db.listTasks(input.teamId)) {
          if (task.assigneeId !== member.id || TERMINAL_TASK_STATUSES.includes(task.status)) continue;
          db.updateTask(invalidateTaskAttempt(task, { reassigning: true }));
        }
        emit(team.captainSessionKey, {
          type: "member_removed",
          teamId: input.teamId,
          memberId: member.id,
          reason: input.reason ?? REMOVED_REASON_DEFAULT,
        });
      });
      return {
        content: [{ type: "text", text: `team_remove_member memberId=${input.memberId} retired` }],
        data: { teamId: input.teamId, memberId: input.memberId, removed: true },
      };
    },
  };
}
