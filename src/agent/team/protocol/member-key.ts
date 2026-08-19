/**
 * 成员会话 key 契约：`team:<teamId>:<memberId>`。
 *
 * 切分语义：按第一个冒号切分（`memberId` 允许含冒号，`teamId` 不得含冒号——
 * 与 Sati `channel:channelSessionId` 惯例同构，注册侧须保证 teamId 简单）。
 *
 * 该前缀同时是转录隔离机制：session/storage 的 isInternalSession 识别
 * `team:` 前缀，把成员会话从 listProjectSessions / TaskResumeScanner 扫描中
 * 排除（成员冷恢复由 team 模块独家负责）。改前缀必须同步 SessionList.ts。
 */
export const MEMBER_SESSION_PREFIX = "team:";

export function memberSessionKey(teamId: string, memberId: string): string {
  return `${MEMBER_SESSION_PREFIX}${teamId}:${memberId}`;
}

export function parseMemberSessionKey(sessionKey: string): { teamId: string; memberId: string } | null {
  if (!sessionKey.startsWith(MEMBER_SESSION_PREFIX)) {
    return null;
  }
  const rest = sessionKey.slice(MEMBER_SESSION_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) {
    return null;
  }
  return { teamId: rest.slice(0, sep), memberId: rest.slice(sep + 1) };
}
