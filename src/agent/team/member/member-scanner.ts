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
import type { GatewayEvent } from "../../../gateway/protocol/types.js";
import type { TeamDb, TeamMemberRow } from "../storage/team-db.js";
import type { TeamEventEmitter } from "../protocol/events.js";
import { createLogger } from "../../../telemetry/index.js";
import { wakeMember, type MemberGateway } from "./member-waker.js";

const logger = createLogger("sati");

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
  /** P0-3：挂起审批成员的 TeamEvent 冒泡出口（接到 createLocalGateway 的 emitTeamEvent）。 */
  emitTeamEvent?: TeamEventEmitter;
  /** 成员回合事件透传（M2 最终审查 I1 接线点）：冷恢复 turn 的 approval_pending 冒泡
   *  到队长 watcher——宿主把回调接到 TeamApprovalForwarder.handleMemberEvent。 */
  onEvent?: (member: TeamMemberRow, event: GatewayEvent) => void;
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
    // 显式状态检查（M1 遗留 #2）：working 成员可能在跑回合，不得并发唤醒。
    // 依赖宿主在启动扫描前调用 TeamDb.resetMemberStatuses()——崩溃残留的 working 必为死状态，
    // 不重置则本跳过会让这些成员永久失去冷恢复。
    if (member.status !== "idle") {
      continue;
    }
    // P0-3：挂起审批判定前移（早于转录读取/形态判定）。挂起成员几乎必为 form "b"
    //（审批消息已持久化入库），若在 form 检查处跳过则永不到达 hasPendingApprovals，
    // 尾部审批会"石沉大海"（M1 已知限制）。此处显式冒泡队长后跳过：
    // member_stalled_approval 让队长知晓该成员卡在人工审批门；挂起态已持久化
    //（teams.db pending_approvals，bus 为内存态），供冷恢复重建与 decide 收敛。
    if (options.hasPendingApprovals?.(member.sessionKey)) {
      const team = options.db.getTeam(member.teamId);
      if (team) {
        options.emitTeamEvent?.(team.captainSessionKey, {
          type: "member_stalled_approval",
          teamId: member.teamId,
          memberId: member.id,
          roleSlug: member.roleSlug,
          sessionKey: member.sessionKey,
        });
      }
      continue;
    }
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
      // 读转录是异步间隙：与 stranded 扫描交错时成员可能已被唤醒/退休，收敛 TOCTOU
      const fresh = options.db.getMember(member.id);
      if (fresh === undefined || fresh.status !== "idle" || options.db.isRetired(fresh.sessionKey)) {
        continue;
      }
      // I1（code review）：直调 wakeMember 补传 onEvent——冷恢复 turn 的事件（含
      // approval_pending）透传给宿主，M1"冷恢复审批不冒泡"限制在此闭环（M2 由此接通）。
      await wakeMember(options.db, options.gateway, member.id, options.resumeMessage ?? TEAM_MEMBER_RESUME_MESSAGE, {
        onEvent: event => options.onEvent?.(member, event),
      });
      resumed += 1;
    } catch (error) {
      // 单个成员失败（转录缺失/损坏）不阻塞其余成员；无转录 = 从未唤醒，跳过。
      // I1（code review）：宿主 fire-and-forget 无日志兜底，此处显式记录，失败可观测。
      logger.error(`Team member resume failed: ${member.id}`, error);
      continue;
    }
  }
  return { scanned: members.length, resumed };
}

export type ScanStrandedTasksOptions = {
  db: TeamDb;
  /** 回调：stranded 任务的 invalidate + 重新认领（Task 7 接线到 TeamScheduler.kickMember）。 */
  invalidateAndKick: (teamId: string, taskId: string, memberId: string) => Promise<void>;
};

export type ScanStrandedTasksResult = { stranded: number };

/**
 * 冷恢复（M2 扩展）：stranded 任务 = claimed/in_progress 但 assignee 成员 idle
 * （或成员已退休/不存在）→ invalidate 旧 attempt（生成 handoffId 拒绝迟到写）
 * → 回调重新认领（新 attempt）。依赖未满足/终态任务不处理。
 * 不抛错：单任务失败跳过，宿主负责日志（与 scanTeamMembers 契约一致——
 * 逐项工作容错，存储层错误上抛由宿主兜底）。
 * 宿主编排约束：与 scanTeamMembers 串行执行（先成员扫描后 stranded 扫描），
 * 避免交错双重唤醒同一成员（scanTeamMembers 内另有唤醒前状态复查兜底）。
 */
export async function scanStrandedTasks(options: ScanStrandedTasksOptions): Promise<ScanStrandedTasksResult> {
  const { db, invalidateAndKick } = options;
  let stranded = 0;
  const allMembers = db.listMembers();
  for (const team of db.listTeams()) {
    // I-1 review（T8）：归档团队整体跳过——成员已全退休、任务保留只读，
    // 冷启动不再空扫归档团队（检查点与 scheduler kickTeam 顺序一致：team 存在 → archivedAt → 后续）。
    if (team.archivedAt !== undefined) {
      continue;
    }
    const members = new Map(allMembers.filter(m => m.teamId === team.id).map(m => [m.id, m]));
    for (const task of db.listTasks(team.id)) {
      if (task.status !== "claimed" && task.status !== "in_progress") {
        continue;
      }
      if (task.assigneeId === undefined) {
        continue;
      }
      // 队长任务（assigneeId="captain"）无成员行：不属 stranded 语义——队长会话由队长
      // 自己驱动，不在成员冷恢复/re-claim 范围，跳过防误 invalidate（顺手项 1）。
      if (task.assigneeId === "captain") {
        continue;
      }
      const member = members.get(task.assigneeId);
      const isStranded = member === undefined || db.isRetired(member.sessionKey) || member.status !== "working";
      if (!isStranded) {
        continue;
      }
      try {
        await invalidateAndKick(team.id, task.id, task.assigneeId);
        stranded += 1;
      } catch (error) {
        // 单任务失败不阻塞团队扫描；I1（code review）：显式记录，失败可观测。
        logger.error(`Team stranded task reclaim failed: ${task.id}`, error);
      }
    }
  }
  return { stranded };
}
