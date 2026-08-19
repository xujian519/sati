/**
 * team_* 工具共享工具集（M3）：身份解析与成员/角色校验纯函数。
 * 供 teamManagement/teamTasks/teamMailbox/teamStatus/teamArchive 五个工具文件复用；
 * 由 createLocalGateway 经 createBuiltinRegistry options.team 装配（T5-T8 接线）。
 */
import { parseMemberSessionKey } from "../../../agent/team/index.js";
import type { TeamDb, TeamScheduler, TeamEventEmitter } from "../../../agent/team/index.js";
import { listRegisteredRoleIds } from "../../../agent/sub/builtinSubagentTypes.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";

/** team_* 工具的装配选项：由 createLocalGateway 注入（db=teams.db，scheduler=TeamScheduler 实例，emit=TeamEvent 广播出口）。 */
export type TeamToolsOptions = {
  db: TeamDb;
  scheduler: TeamScheduler;
  emit: TeamEventEmitter;
};

/** 会话身份解析结果：成员会话携带 teamId/memberId；队长会话无团队信息（teamId/memberId 为空串）。 */
export type TeamActor = {
  teamId: string;
  memberId: string;
  captain: boolean;
};

/**
 * 成员会话 key 解析：复用 agent/team 既有 parseMemberSessionKey（首个冒号切分语义），
 * 仅做契约适配——null 或 memberId 为空串（"team:t1:"）返回 undefined。
 */
export function parseTeamSessionKey(sessionKey: string): { teamId: string; memberId: string } | undefined {
  const parsed = parseMemberSessionKey(sessionKey);
  if (parsed === null || parsed.memberId === "") {
    return undefined;
  }
  return parsed;
}

/**
 * 队长会话判定：非 `team:` 前缀的普通会话即队长会话（M2 惯例 captainSessionKey="cap-1" 等主会话 key）。
 * 注意：Windows 净化形态 `team-*`（SessionList TEAM_MEMBER_SESSION_PATTERN /^team[:\-]/，
 * 转录文件名回读）同样解析不出成员身份，本布尔在语义上将其算作"非成员会话"；
 * 管理操作放行必须经 resolveActor 的 fail-closed 判定（净化形态返回 undefined），不可直接用本函数。
 */
export function isCaptainSession(sessionKey: string): boolean {
  return parseTeamSessionKey(sessionKey) === undefined;
}

export function resolveActor(sessionKey: string | undefined): TeamActor | undefined {
  if (sessionKey === undefined) {
    return undefined;
  }
  // Windows 净化形态（`team:` → `team-`，转录文件名回读）：原始冒号信息丢失不可解析，
  // fail-closed 返回 undefined，不得误判为队长放行管理操作（fail-open 越权方向）。
  if (sessionKey.startsWith("team-")) {
    return undefined;
  }
  const parsed = parseTeamSessionKey(sessionKey);
  if (parsed !== undefined) {
    return { ...parsed, captain: false };
  }
  return { teamId: "", memberId: "", captain: true };
}

/** 成员级操作守卫：仅本团队成员可执行；返回成员 id。拒绝语义见稳定错误码。 */
export function requireTeamMember(db: TeamDb, actor: TeamActor, teamId: string): string {
  if (actor.captain) {
    throw new SatiToolRuntimeError("team_not_member", "队长会话不是团队成员，不能执行成员级操作");
  }
  if (actor.teamId !== teamId) {
    throw new SatiToolRuntimeError("team_not_member", `会话属于团队 ${actor.teamId}，不属于团队 ${teamId}`);
  }
  const member = db.getMember(actor.memberId);
  if (member === undefined) {
    throw new SatiToolRuntimeError("team_actor_unknown", `成员 ${actor.memberId} 不存在`);
  }
  if (member.teamId !== teamId) {
    throw new SatiToolRuntimeError("team_not_member", `成员 ${actor.memberId} 不属于团队 ${teamId}`);
  }
  if (db.isRetired(member.sessionKey)) {
    throw new SatiToolRuntimeError("team_member_retired", `成员 ${actor.memberId} 已退休，不能执行团队操作`);
  }
  return actor.memberId;
}

/** 队长级操作守卫：未解析出会话身份抛 team_actor_unknown；非队长会话抛 team_not_captain。 */
export function requireCaptain(actor: TeamActor | undefined): void {
  if (actor === undefined) {
    throw new SatiToolRuntimeError("team_actor_unknown", "无法判定调用者会话身份（sessionId 缺失）");
  }
  if (!actor.captain) {
    throw new SatiToolRuntimeError("team_not_captain", "该操作仅限队长会话执行");
  }
}

/** 角色校验：roleSlug 必须已注册（内置预设或 SKILL.md type: role 动态注册）。 */
export function requireRegisteredRole(roleSlug: string): void {
  if (!listRegisteredRoleIds().includes(roleSlug)) {
    throw new SatiToolRuntimeError("team_unknown_role", `角色 ${roleSlug} 未注册`);
  }
}

/** 成员模型路由缺省值（M3）：未显式指定 LLM 路由时的缺省回退，装配时覆盖（T5-T8 接线会传 context 会话主模型）。 */
export const defaultModelRoute = {
  provider: "deepseek",
  model: "deepseek-v4-flash",
} as const;
