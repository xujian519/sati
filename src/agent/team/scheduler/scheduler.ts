/**
 * 事件驱动调度器（M2）：非轮询——任务图变更（onTaskGraphChanged）与成员回合
 * 结束（onMemberIdle）双触发，锁内读最新状态原子认领。
 * 语义（dsh scheduler 同构）：
 * - 邮箱优先：未读消息先投递（投递租约 60s），成功才 ack；
 * - ownedOpenTask（成员名下 claimed/in_progress）优先于 nextReadyTask（依赖满足；
 *   先指派给自己的、其次未指派；reassigning 跳过）；
 * - 并发闸：working 成员数达 maxConcurrentMembers（默认 4）不派新任务（邮箱仍投递）；
 * - 唤醒失败回滚：锁内校验 attemptId 只回滚自己那次派发，不覆盖并发转派；
 * - 队长离线：isCaptainOnline 返回 false 时暂停认领（在途回合跑完即停）。
 */
import type { TeamDb, TeamTaskRow } from "../storage/team-db.js";
import { unsatisfiedDependencies } from "../taskpool/task-status.js";
import { beginTaskAttempt, invalidateTaskAttempt } from "../taskpool/attempt.js";
import { claimDelivery, unreadMessages } from "../mailbox/mailbox.js";
import type { TeamEventEmitter } from "../protocol/events.js";
import { withTeamLock } from "./lock.js";

export type TeamSchedulerOptions = {
  db: TeamDb;
  /** 广播出口（注入 gateway.emitForSession 闭包；Task 7 接线）。 */
  emit: TeamEventEmitter;
  /** 成员唤醒（复用 M1 wakeMember；返回 true = 接受）。 */
  wake: (memberId: string, followupMessage: string) => Promise<boolean>;
  /** 并发闸上限（默认 4）。 */
  maxConcurrentMembers?: number;
  /** 队长在线判定（默认常在线）；离线暂停认领。 */
  isCaptainOnline?: (captainSessionKey: string) => boolean;
};

export type DispatchTicket = {
  taskId: string;
  memberId: string;
  attempt: number;
  attemptId: string;
  subject: string;
  description?: string;
};

export function ownedOpenTask(tasks: readonly TeamTaskRow[], memberId: string): TeamTaskRow | undefined {
  return tasks.find(
    task => task.assigneeId === memberId && (task.status === "claimed" || task.status === "in_progress"),
  );
}

export function nextReadyTask(tasks: readonly TeamTaskRow[], memberId: string): TeamTaskRow | undefined {
  const ready = tasks.filter(
    task =>
      task.status === "pending" && !task.reassigning && unsatisfiedDependencies(tasks, task.dependencies).length === 0,
  );
  return ready.find(task => task.assigneeId === memberId) ?? ready.find(task => task.assigneeId === undefined);
}

export function assignmentPrompt(ticket: DispatchTicket): string {
  return `Sati 团队调度器自动分派（共享任务池）。

任务: ${ticket.taskId} — ${ticket.subject}${ticket.description ? `\n\n${ticket.description}` : ""}
Attempt: ${ticket.attempt}
Attempt id: ${ticket.attemptId}

本回合只执行此任务；完成后汇报队长。若后续更新被拒绝为 stale-attempt，说明任务已被转派，立即停止。
团队状态以 team 工具/队长会话为准，不要臆测任务状态。`;
}

export function fallbackMailboxPrompt(messages: Array<{ sender: string; content: string }>): string {
  return [
    "Sati 团队投递的持久消息（实时投递不可用期间的落盘消息）：",
    ...messages.map(m => `From ${m.sender}:\n${m.content}`),
    "\n本回合处理这些消息；任务分派仍以当前 attempt id 为准。",
  ].join("\n");
}

export class TeamScheduler {
  private readonly db: TeamDb;
  private readonly emit: TeamEventEmitter;
  private readonly wake: (memberId: string, message: string) => Promise<boolean>;
  private readonly maxConcurrentMembers: number;
  private readonly isCaptainOnline: (captainSessionKey: string) => boolean;

  constructor(options: TeamSchedulerOptions) {
    this.db = options.db;
    this.emit = options.emit;
    this.wake = options.wake;
    this.maxConcurrentMembers = options.maxConcurrentMembers ?? 4;
    this.isCaptainOnline = options.isCaptainOnline ?? (() => true);
  }

  /** 团队级触发：对每个 idle 成员给一件就绪工作。 */
  async kickTeam(teamId: string): Promise<void> {
    const team = this.db.getTeam(teamId);
    if (team === undefined || !this.isCaptainOnline(team.captainSessionKey)) return;
    const members = this.db.listMembers().filter(m => m.teamId === teamId);
    for (const member of members) {
      if (member.status !== "idle") continue;
      await this.kickMember(teamId, member.id);
    }
  }

  /** 成员级触发：邮箱投递优先，其次 ownedOpenTask/nextReadyTask 原子认领。 */
  async kickMember(teamId: string, memberId: string): Promise<void> {
    const team = this.db.getTeam(teamId);
    if (team === undefined || !this.isCaptainOnline(team.captainSessionKey)) return;
    const member = this.db.getMember(memberId);
    if (
      member === undefined ||
      member.teamId !== teamId ||
      member.status !== "idle" ||
      this.db.isRetired(member.sessionKey)
    )
      return;

    await withTeamLock(teamId, async () => {
      // 锁内重读成员状态：pre-check 与锁获取之间存在 TOCTOU 窗口
      //（kickTeam/onMemberIdle 双触发并发），防对已 working 成员重复派发。
      const current = this.db.getMember(memberId);
      if (
        current === undefined ||
        current.teamId !== teamId ||
        current.status !== "idle" ||
        this.db.isRetired(current.sessionKey)
      )
        return;

      // 1) 邮箱优先
      const unread = unreadMessages(this.db.listMessages(teamId, memberId), Date.now());
      if (unread.length > 0) {
        const claimedAt = new Date().toISOString();
        for (const message of claimDelivery(unread, claimedAt)) {
          this.db.updateMessage(message);
        }
        const accepted = await this.wake(
          memberId,
          fallbackMailboxPrompt(unread.map(m => ({ sender: m.sender, content: m.content }))),
        );
        const fresh = this.db.listMessages(teamId, memberId);
        for (const message of fresh) {
          if (!unread.some(u => u.id === message.id)) continue;
          this.db.updateMessage(
            accepted
              ? { ...message, deliveredAt: new Date().toISOString() }
              : { ...message, deliveryClaimedAt: undefined },
          );
        }
        if (accepted)
          this.emit(team.captainSessionKey, {
            type: "message_delivered",
            teamId,
            recipient: memberId,
            sender: unread[0]?.sender ?? "captain",
          });
        return;
      }

      // 2) 任务认领（锁内 read-modify-write）
      const tasks = this.db.listTasks(teamId);
      const task = ownedOpenTask(tasks, memberId) ?? nextReadyTask(tasks, memberId);
      if (task === undefined) return;
      const working = this.db.listMembers().filter(m => m.teamId === teamId && m.status === "working").length;
      if (task.status === "pending" && working >= this.maxConcurrentMembers) return; // 并发闸（重试自己的 open task 不受闸限）

      const { task: next, attemptId } = beginTaskAttempt(task, memberId);
      this.db.updateTask(next);
      this.db.updateMemberStatus(memberId, "working");

      const accepted = await this.wake(
        memberId,
        assignmentPrompt({
          taskId: task.id,
          memberId,
          attempt: next.attempt,
          attemptId,
          subject: task.subject,
          ...(task.description ? { description: task.description } : {}),
        }),
      );
      if (accepted) {
        // 认领事件在 wake 接受后发出：失败回滚时不广播"已认领"（对比邮箱路径的 ack 语义）
        this.emit(team.captainSessionKey, {
          type: "task_claimed",
          teamId,
          taskId: task.id,
          memberId,
          attempt: next.attempt,
          attemptId,
        });
        return;
      }

      // 3) 唤醒失败回滚：只回滚自己的 ticket（attemptId 校验），不覆盖并发转派
      const fresh = this.db.getTask(teamId, task.id);
      if (fresh === undefined || fresh.attemptId !== attemptId) {
        // 任务已被并发转派/改写：不回滚他人 ticket，但本成员从未真正开始回合，须回 idle
        this.db.updateMemberStatus(memberId, "idle");
        return;
      }
      const revoked = invalidateTaskAttempt(fresh, {});
      this.db.updateTask(revoked);
      this.db.updateMemberStatus(memberId, "idle");
    });
  }

  /** 任务图变更触发（M3 team_create_task/update 等工具调用点；M2 供编程式入口）。 */
  async onTaskGraphChanged(teamId: string): Promise<void> {
    await this.kickTeam(teamId);
  }

  /** 成员回合结束触发（wakeMember onEvent 接线点；M1 已知限制在此闭环）。 */
  async onMemberIdle(teamId: string, memberId: string): Promise<void> {
    const team = this.db.getTeam(teamId);
    if (team === undefined) return;
    this.db.updateMemberStatus(memberId, "idle");
    this.emit(team.captainSessionKey, { type: "member_idle", teamId, memberId });
    await this.kickMember(teamId, memberId);
  }
}
