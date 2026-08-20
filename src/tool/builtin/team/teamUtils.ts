/**
 * team_* 工具共享工具集（M3）：身份解析与成员/角色校验纯函数。
 * 供 teamManagement/teamTasks/teamMailbox/teamStatus/teamArchive 五个工具文件复用；
 * 由 createLocalGateway 经 createBuiltinRegistry options.team 装配（T5-T8 接线）。
 */
import { parseMemberSessionKey } from "../../../agent/team/index.js";
import type { TeamDb, TeamRow, TeamScheduler, TeamEventEmitter } from "../../../agent/team/index.js";
import { listRegisteredRoleIds } from "../../../agent/sub/builtinSubagentTypes.js";
import { DEFAULT_MODEL_ID, DEFAULT_MODEL_PROVIDER } from "../../../model/defaults.js";
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
 * 成员会话形态前缀（对齐 SessionList.ts 的 TEAM_MEMBER_SESSION_PATTERN /^team[:\-]/：
 * 原始形态 `team:` 与 Windows 净化形态 `team-`（转录文件名回读）都是成员会话，
 * 即便解析失败也一律 fail-closed，绝不判为队长）。
 * 导出供 teamMailbox/teamStatus 对畸形/净化成员会话做 fail-closed（对齐 update_task 行为，
 * 防止 sender 审计失真为 "captain"）。
 */
export const TEAM_MEMBER_SESSION_PATTERN = /^team[:\-]/;

/**
 * 成员会话 key 解析：复用 agent/team 既有 parseMemberSessionKey（首个冒号切分语义），
 * 仅做契约适配——null 或 memberId 为空串（"team:t1:"）返回 undefined。
 * 解析失败 = 未知成员形态（畸形/净化），由 resolveActor/isCaptainSession 统一 fail-closed。
 */
export function parseTeamSessionKey(sessionKey: string): { teamId: string; memberId: string } | undefined {
  const parsed = parseMemberSessionKey(sessionKey);
  if (parsed === null || parsed.memberId === "") {
    return undefined;
  }
  return parsed;
}

export function resolveActor(sessionKey: string | undefined): TeamActor | undefined {
  if (sessionKey === undefined) {
    return undefined;
  }
  const parsed = parseTeamSessionKey(sessionKey);
  if (parsed !== undefined) {
    return { ...parsed, captain: false };
  }
  // 成员会话形态解析失败（空 teamId/空 memberId 等畸形 + Windows 净化形态 `team-`）：
  // 信息丢失不可解析，fail-closed 返回 undefined，不得误判为队长放行管理操作（fail-open 越权方向）。
  if (TEAM_MEMBER_SESSION_PATTERN.test(sessionKey)) {
    return undefined;
  }
  return { teamId: "", memberId: "", captain: true };
}

/**
 * 成员级操作守卫：仅本团队成员可执行；返回成员 id。拒绝语义见稳定错误码。
 * 调用方须先经 resolveActor 解析会话：`team[:\-]` 形态的畸形/净化 key 解析为 undefined
 * （fail-closed），工具侧应在解析失败时直接拒绝，不会走到本守卫。
 */
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
    throw new SatiToolRuntimeError("team_not_captain", "该操作仅队长会话执行");
  }
}

/**
 * 管理类工具的同队校验（锁内调用）：会话须为队长形态 + 团队存在 + 是该团队队长。
 * 返回团队行（避免调用方二次 getTeam，且 emit 应以 team.captainSessionKey 路由事件）。
 * 失败抛 team_actor_unknown / team_not_found / team_not_captain。
 * 注意：resolveActor 对队长会话返回 teamId 空串，无法直接比较——故接收原始 sessionId 判定。
 */
export function requireTeamCaptain(db: TeamDb, sessionId: string | undefined, teamId: string): TeamRow {
  const actor = resolveActor(sessionId);
  if (actor === undefined) {
    throw new SatiToolRuntimeError("team_actor_unknown", "无法判定调用者会话身份（sessionId 缺失）");
  }
  if (!actor.captain) {
    throw new SatiToolRuntimeError("team_not_captain", "仅队长（主会话）可执行团队管理操作");
  }
  const team = db.getTeam(teamId);
  if (team === undefined) {
    throw new SatiToolRuntimeError("team_not_found", `团队不存在：${teamId}`);
  }
  if (team.captainSessionKey !== sessionId) {
    throw new SatiToolRuntimeError("team_not_captain", `仅团队 ${teamId} 的队长可执行此操作`);
  }
  return team;
}

/**
 * 归档态门禁（T8 review F4）：归档后团队只读（设计语义「任务/消息保留只读」墓碑）。
 * 变更类工具在 requireTeamCaptain 拿到 TeamRow 后调用（与 requireTeamCaptain 同点判定），
 * 已归档抛 team_already_archived——防止归档后继续产生变更（如 add_member 产生未退休僵尸成员）。
 */
export function assertTeamActive(team: TeamRow): void {
  if (team.archivedAt !== undefined) {
    throw new SatiToolRuntimeError("team_already_archived", `团队已归档：${team.id}`);
  }
}

/** 角色校验：roleSlug 必须已注册（内置预设或 SKILL.md type: role 动态注册）。 */
export function requireRegisteredRole(roleSlug: string): void {
  if (!listRegisteredRoleIds().includes(roleSlug)) {
    throw new SatiToolRuntimeError("team_unknown_role", `角色 ${roleSlug} 未注册`);
  }
}

/**
 * 成员模型路由缺省值（M3）：继承队长会话主模型（context provider/modelId），缺省与项目默认一致
 * （最终复审 M1：回退引用 defaults 常量，消除硬编码漂移；当前仅快照存储——wakeMember 未消费，
 * 成员会话实际模型走项目默认配置，M4 接线消费点）。
 */
export function defaultModelRoute(context: { provider?: string; modelId?: string }): {
  provider: string;
  model: string;
} {
  return {
    provider: context.provider ?? DEFAULT_MODEL_PROVIDER,
    model: context.modelId ?? DEFAULT_MODEL_ID,
  };
}
