/**
 * 成员注册：把成员行写入 teams.db。
 * LLM 路由快照由调用方解析后传入（M3 工具面接 resolveModelInfo），
 * M1 只负责序列化持久化与 sessionKey 派生。
 */
import type { TeamDb, TeamMemberRow } from "../storage/team-db.js";
import { memberSessionKey } from "../protocol/member-key.js";

export type MemberModelRoute = {
  provider: string;
  model: string;
  reasoningEffort?: string;
};

export type CreateTeamMemberOptions = {
  teamId: string;
  memberId: string;
  roleSlug: string;
  modelRoute: MemberModelRoute;
  now?: () => Date;
};

export function createTeamMember(db: TeamDb, options: CreateTeamMemberOptions): TeamMemberRow {
  const now = options.now ?? (() => new Date());
  const row: TeamMemberRow = {
    id: options.memberId,
    teamId: options.teamId,
    roleSlug: options.roleSlug,
    modelRouteJson: JSON.stringify(options.modelRoute),
    status: "idle",
    sessionKey: memberSessionKey(options.teamId, options.memberId),
    createdAt: now().toISOString(),
  };
  db.insertMember(row);
  return row;
}
