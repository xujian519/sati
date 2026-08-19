/**
 * 成员冷恢复：gateway 启动时扫描 members 表，对 (a) 形态断点成员重唤醒。
 *
 * 与 TaskResumeScanner 的分工：主会话扫描走 TaskResumeScanner（listProjectSessions
 * 已把 team: 前缀成员排除在 includeInternal:false 之外），成员的冷恢复由本模块
 * 独家负责——两个冷恢复机制互不打架。
 *
 * 不抛错：单个成员失败（转录缺失/损坏、唤醒竞态）静默跳过，不阻塞其余成员；
 * 宿主（createLocalGateway）以 fire-and-forget 调用并负责日志。
 */
import { join } from "node:path";
import { getPilotProjectChatDir } from "../../../pilot/index.js";
import { sanitizeSessionIdForPath } from "../../../session/storage/ProjectSessionStorage.js";
import { readTranscript } from "../../../session/transcript/TranscriptReader.js";
import { findOpenRequest } from "../../../session/transcript/interruptedTurn.js";
import type { TeamDb } from "../storage/team-db.js";
import { wakeMember, type MemberGateway } from "./member-waker.js";

export const TEAM_MEMBER_RESUME_MARKER = "[team-resume]";

export const TEAM_MEMBER_RESUME_MESSAGE = `${TEAM_MEMBER_RESUME_MARKER} 你上一次运行因进程中断而停止。请先检查当前已完成的进度（不要重复执行已经完成的工作），然后继续完成未完成的工作。`;

export type ScanTeamMembersOptions = {
  db: TeamDb;
  gateway: MemberGateway;
  projectRoot: string;
  pilotHome: string;
  resumeMessage?: string;
  /** 成员会话是否有挂起审批（输出门禁态在 gateway 内存，崩溃即失，须跳过）。 */
  hasPendingApprovals?: (sessionKey: string) => boolean;
};

export type ScanTeamMembersResult = {
  scanned: number;
  resumed: number;
};

export async function scanTeamMembers(options: ScanTeamMembersOptions): Promise<ScanTeamMembersResult> {
  // 退休成员直接排除在扫描范围外（scanned 只统计实际扫描的成员）。
  const members = options.db.listMembers().filter(member => !options.db.isRetired(member.sessionKey));
  const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
  let resumed = 0;
  for (const member of members) {
    try {
      const path = join(chatDir, `${sanitizeSessionIdForPath(member.sessionKey)}.jsonl`);
      const { entries } = await readTranscript(path);
      const open = findOpenRequest(entries);
      if (open === undefined) {
        continue;
      }
      if (open.form !== "a") {
        continue;
      }
      if (options.hasPendingApprovals?.(member.sessionKey)) {
        continue;
      }
      await wakeMember(options.db, options.gateway, member.id, options.resumeMessage ?? TEAM_MEMBER_RESUME_MESSAGE);
      resumed += 1;
    } catch {
      // 单个成员失败（转录缺失/损坏）不阻塞其余成员；无转录 = 从未唤醒，跳过。
      continue;
    }
  }
  return { scanned: members.length, resumed };
}
