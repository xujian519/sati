/**
 * 事件驱动调度器（M2）：非轮询——任务图变更（onTaskGraphChanged）与成员回合
 * 结束（onMemberIdle）双触发，锁内读最新状态原子认领。
 * 语义（dsh scheduler 同构）：
 * - 邮箱优先：未读消息先投递（投递租约 60s），成功才 ack；
 * - ownedOpenTask（成员名下 claimed/in_progress）优先于 nextReadyTask（依赖满足；
 *   先指派给自己的、其次未指派；reassigning 跳过）；
 * - 并发闸：working 成员数达 maxConcurrentMembers（默认 4）不派新任务（邮箱仍投递）；
 * - 唤醒失败回滚：重取锁校验 attemptId 只回滚自己那次派发，不覆盖并发转派；
 * - 锁外唤醒（M3 定型）：认领在锁内完成，成员回合全程不持团队锁——回合内
 *   team_update_task 等团队工具要取同一把锁，持锁唤醒会重入死锁；
 * - 队长离线：isCaptainOnline 返回 false 时暂停认领（在途回合跑完即停）。
 */
import type { TeamDb, TeamMessageRow, TeamTaskRow, TeamRow } from "../storage/team-db.js";
import { TERMINAL_TASK_STATUSES, unsatisfiedDependencies } from "../taskpool/task-status.js";
import { beginTaskAttempt, invalidateTaskAttempt, attemptsExhausted } from "../taskpool/attempt.js";
import { retryFailedTask } from "../taskpool/retry.js";
import { claimDelivery, unreadMessages } from "../mailbox/mailbox.js";
import type { TeamEventEmitter } from "../protocol/events.js";
import { workerAllowedForRole } from "../../../patent/index.js";
import type { WorkerRegistry } from "../../../patent/index.js";
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
  /** 阶段 3：专利 worker 注册表（可选；提供时新任务分派按成员角色 tier 校验）。 */
  workerRegistry?: WorkerRegistry;
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
  private readonly workerRegistry?: WorkerRegistry;

  constructor(options: TeamSchedulerOptions) {
    this.db = options.db;
    this.emit = options.emit;
    this.wake = options.wake;
    this.maxConcurrentMembers = options.maxConcurrentMembers ?? 4;
    this.isCaptainOnline = options.isCaptainOnline ?? (() => true);
    this.workerRegistry = options.workerRegistry;
  }

  /**
   * 阶段 3：成员是否可认领该任务——任务带 workerName 时校验成员角色 tier 权限。
   * 已认领任务（claimed/in_progress）不受此约束（不夺回）；workerRegistry 未注入
   * 或 worker 未注册时 fail-open（不阻塞）。
   */
  private canMemberClaim(memberId: string, task: TeamTaskRow): boolean {
    if (task.workerName === undefined || this.workerRegistry === undefined) return true;
    const worker = this.workerRegistry.get(task.workerName);
    if (worker === undefined) return true;
    const member = this.db.getMember(memberId);
    if (member === undefined) return true;
    return workerAllowedForRole(member.roleSlug, worker);
  }

  /**
   * 调度门槛（精简 B4 提取）：返回可调度团队（存在 + 未归档 + 队长在线），否则 undefined。
   * kickTeam/kickMember 同点判定——archived 或 captain 离线 → 暂停认领（在途回合跑完即停）。
   * 返回团队行兼作事件路由（emit 需 captainSessionKey），免二次查询。
   */
  private getDispatchableTeam(teamId: string): TeamRow | undefined {
    const team = this.db.getTeam(teamId);
    if (team === undefined || team.archivedAt !== undefined || !this.isCaptainOnline(team.captainSessionKey)) {
      return undefined;
    }
    return team;
  }

  /** 团队级触发：对每个 idle 成员给一件就绪工作。 */
  async kickTeam(teamId: string): Promise<void> {
    if (this.getDispatchableTeam(teamId) === undefined) return;
    const members = this.db.listMembers().filter(m => m.teamId === teamId);
    for (const member of members) {
      if (member.status !== "idle") continue;
      await this.kickMember(teamId, member.id);
    }
  }

  /** 成员级触发：邮箱投递优先，其次 ownedOpenTask/nextReadyTask 原子认领。 */
  async kickMember(teamId: string, memberId: string): Promise<void> {
    const team = this.getDispatchableTeam(teamId);
    if (team === undefined) return;
    const member = this.db.getMember(memberId);
    if (
      member === undefined ||
      member.teamId !== teamId ||
      member.status !== "idle" ||
      this.db.isRetired(member.sessionKey)
    )
      return;

    // 锁内认领（read-modify-write 原子），锁外唤醒：成员回合全程不持团队锁——
    // 回合内 team_update_task 等团队工具要取同一把锁，持锁唤醒会重入死锁
    //（M3 集成测试暴露；与「锁外调度防重入死锁」惯例一致）。
    type KickPlan =
      | { kind: "mailbox"; unread: TeamMessageRow[] }
      | { kind: "task"; task: TeamTaskRow; next: TeamTaskRow; attemptId: string };
    const plan = await withTeamLock(teamId, async (): Promise<KickPlan | undefined> => {
      // 锁内重读成员状态：pre-check 与锁获取之间存在 TOCTOU 窗口
      //（kickTeam/onMemberIdle 双触发并发），防对已 working 成员重复派发。
      const current = this.db.getMember(memberId);
      if (
        current === undefined ||
        current.teamId !== teamId ||
        current.status !== "idle" ||
        this.db.isRetired(current.sessionKey)
      )
        return undefined;

      // 1) 邮箱优先
      const unread = unreadMessages(this.db.listMessages(teamId, memberId), Date.now());
      if (unread.length > 0) {
        const claimedAt = new Date().toISOString();
        for (const message of claimDelivery(unread, claimedAt)) {
          this.db.updateMessage(message);
        }
        return { kind: "mailbox", unread };
      }

      // 2) 任务认领（锁内 read-modify-write）
      // M4：失败任务自动转派——锁内把 failed 未耗尽任务重置回 pending（幂等，
      // 重置后不再 failed），使 nextReadyTask 能重新认领；attempt 上限防无限循环。
      const retried = this.db.listTasks(teamId).filter(t => t.status === "failed" && !attemptsExhausted(t));
      for (const stale of retried) {
        const fresh = this.db.getTask(teamId, stale.id);
        if (fresh === undefined || fresh.status !== "failed") continue; // 锁内重读防并发改写
        if (attemptsExhausted(fresh)) continue;
        this.db.updateTask(retryFailedTask(fresh));
        this.emit(team.captainSessionKey, {
          type: "task_retried",
          teamId,
          taskId: fresh.id,
          attempt: fresh.attempt,
          ...(fresh.assigneeId !== undefined ? { memberId: fresh.assigneeId } : {}),
        });
      }
      // M4：重置后重取快照——刚重置回 pending 的任务本次 kick 即可认领
      //（同次锁内完成，不会滞留 pending 等下一次触发）
      const tasks = this.db.listTasks(teamId);
      // 阶段 3：新分派任务按 worker tier 过滤——任务带 workerName 且成员角色无权执行该
      // tier 时对该成员不可认领（已认领任务不受影响，不夺回；workerRegistry 缺失 fail-open）。
      const claimable = this.workerRegistry === undefined ? tasks : tasks.filter(t => this.canMemberClaim(memberId, t));
      const task = ownedOpenTask(tasks, memberId) ?? nextReadyTask(claimable, memberId);
      if (task === undefined) return undefined;
      const working = this.db.listMembers().filter(m => m.teamId === teamId && m.status === "working").length;
      if (task.status === "pending" && working >= this.maxConcurrentMembers) return undefined; // 并发闸（重试自己的 open task 不受闸限）

      const { task: next, attemptId } = beginTaskAttempt(task, memberId);
      this.db.updateTask(next);
      this.db.updateMemberStatus(memberId, "working");
      return { kind: "task", task, next, attemptId };
    });
    if (plan === undefined) return;

    if (plan.kind === "mailbox") {
      // 锁外唤醒（成员回合不持团队锁）
      const accepted = await this.wake(
        memberId,
        fallbackMailboxPrompt(plan.unread.map(m => ({ sender: m.sender, content: m.content }))),
      );
      // 锁内 ack：仅回写仍属于本次投递租约的消息（成功置 deliveredAt / 失败释放租约可重投）
      await withTeamLock(teamId, async () => {
        const fresh = this.db.listMessages(teamId, memberId);
        for (const message of fresh) {
          if (!plan.unread.some(u => u.id === message.id)) continue;
          this.db.updateMessage(
            accepted
              ? { ...message, deliveredAt: new Date().toISOString() }
              : { ...message, deliveryClaimedAt: undefined },
          );
        }
      });
      // M3（I4 闭环）：批次粒度 payload——senders 完整列表，sender 保留首条（兼容）
      if (accepted)
        this.emit(team.captainSessionKey, {
          type: "message_delivered",
          teamId,
          recipient: memberId,
          sender: plan.unread[0]!.sender,
          senders: plan.unread.map(m => m.sender),
        });
      return;
    }

    // 任务路径：锁外唤醒（回合全程不持团队锁——成员回合内团队工具需取锁，防重入死锁）
    const accepted = await this.wake(
      memberId,
      assignmentPrompt({
        taskId: plan.task.id,
        memberId,
        attempt: plan.next.attempt,
        attemptId: plan.attemptId,
        subject: plan.task.subject,
        ...(plan.task.description ? { description: plan.task.description } : {}),
      }),
    );
    if (accepted) {
      // 认领事件在 wake 接受后发出：失败回滚时不广播"已认领"（对比邮箱路径的 ack 语义）
      this.emit(team.captainSessionKey, {
        type: "task_claimed",
        teamId,
        taskId: plan.task.id,
        memberId,
        attempt: plan.next.attempt,
        attemptId: plan.attemptId,
      });
      return;
    }

    // 3) 唤醒失败回滚：重新取锁，只回滚自己的 ticket（attemptId 校验），不覆盖并发转派。
    // 成员回 idle 保持原语义（本成员从未真正开始回合，须回 idle）。
    await withTeamLock(teamId, async () => {
      const fresh = this.db.getTask(teamId, plan.task.id);
      if (fresh === undefined || fresh.attemptId !== plan.attemptId) {
        // 任务已被并发转派/改写：不回滚他人 ticket，但本成员从未真正开始回合，须回 idle
        this.db.updateMemberStatus(memberId, "idle");
        return;
      }
      // I1（T12 复审）：终态防护——锁外唤醒窗口内队长可经 team_update_task 把任务推进
      // 到终态（completed/failed/cancelled 均保留 attemptId），attemptId 校验仍通过；
      // 终态任务不得 invalidate（工具层已发 task_completed/task_failed 事件，回滚会制造
      // 数据与事件不一致，且 pending 可能被重派二次执行）。同款防护见 member-scanner/teamTasks。
      if (TERMINAL_TASK_STATUSES.includes(fresh.status)) {
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
