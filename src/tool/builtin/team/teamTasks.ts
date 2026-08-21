/**
 * 团队任务池工具（M3）：team_create_task / team_update_task / team_reassign_task。
 * create/reassign 为管理面（domain: "team:manage"）；update_task 为作业面（domain: "team"）——
 * 成员回合内完成任务的关键路径：assignee 校验 + validateAttemptUpdate（stale-attempt fail-closed）
 * + transitionError 校验 → 锁内置终态 → blockedByCount 重算 → 锁外调度（下游解锁）。
 *
 * 同队校验（T5 review 定型）：三个工具的身份校验全部在锁内执行——
 * create/reassign 用 requireTeamCaptain（替代锁外 requireCaptain + 锁内 getTeam 检查，
 * team_not_found 语义一致），事件一律路由到 team.captainSessionKey（真实队长，不假设调用者）。
 * update_task 锁内按身份分流：成员路径 requireTeamMember（assignee 校验），
 * 队长路径 requireTeamCaptain（跳过 assignee 校验但 attemptId 仍校验，计划语义）。
 * 事件（create/update/reassign）一律锁内发出（emit 为同步入队，锁内安全已有 T5 先例）。
 * 锁外调度（onTaskGraphChanged/kickMember）：scheduler 内部自己拿团队锁，防重入死锁（M2 C1 惯例）。
 *
 * Q review 修复（2026-08-20）：I1 reassign 指定成员补存在/同队/退休校验（team_not_member /
 * team_member_retired）；I2 队长路径对 pending → cancelled 豁免 attemptId 校验（T7 补豁免条件说明：
 * memberId === undefined && task.status === "pending" && input.status === "cancelled"——白名单允许但
 * pending 任务 attemptId 恒缺失；claimed/in_progress 仍强制 fail-closed（豁免精度边界，见 spec 断言））；
 * M1 reassign 删除 reason 死字段；M4 create_task 任务 id 碰撞检查（T7 改抛 team_task_exists）；
 * M5 subject 非空白 + maxAttempts 正整数校验（invalid_tool_input）；M7 非 completed 终态清 output。
 */
import { randomUUID } from "node:crypto";
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../../protocol/types.js";
import {
  TERMINAL_TASK_STATUSES,
  detectDependencyCycle,
  transitionError,
  unsatisfiedDependencies,
  validateAttemptUpdate,
  invalidateTaskAttempt,
  withTeamLock,
  type TeamDb,
  type TeamTaskRow,
} from "../../../agent/team/index.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import {
  assertTeamActive,
  requireTeamCaptain,
  requireTeamMember,
  resolveActor,
  type TeamToolsOptions,
} from "./teamUtils.js";

/** 锁内重算团队全部任务的 blockedByCount（dependencies 未完成计数，与调度器 unsatisfiedDependencies 一致）。 */
function recomputeBlockedByCount(db: TeamDb, teamId: string): void {
  const tasks = db.listTasks(teamId); // 单次读取供全量重算（避免 O(n²) 读库）
  for (const t of tasks) {
    const count = unsatisfiedDependencies(tasks, t.dependencies).length;
    if (count !== t.blockedByCount) {
      db.updateTask({ ...t, blockedByCount: count, updatedAt: t.updatedAt });
    }
  }
}

export type TeamCreateTaskInput = {
  teamId: string;
  subject: string;
  description?: string;
  dependencies?: string[];
  maxAttempts?: number;
  /** 阶段 3：任务期望执行的专业 worker 契约名（分派时按成员角色 tier 校验）。 */
  workerName?: string;
};
export type TeamCreateTaskOutput = {
  teamId: string;
  taskId: string;
  subject: string;
  status: string;
  blockedByCount: number;
};

export function createTeamCreateTaskTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamCreateTaskInput, TeamCreateTaskOutput> {
  const { db, scheduler, emit, workerRegistry } = options;
  return {
    name: "team_create_task",
    outputSchema: {
      type: "object",
      required: ["teamId", "taskId", "subject", "status", "blockedByCount"],
      properties: {
        teamId: { type: "string" },
        taskId: { type: "string" },
        subject: { type: "string" },
        status: { type: "string" },
        blockedByCount: { type: "number" },
      },
    },
    description:
      "Create a task in the team task pool with optional dependencies (task ids that must complete first) and maxAttempts (default 3). The scheduler auto-claims ready tasks to idle members. Captain-only.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId", "subject"],
      additionalProperties: false,
      properties: {
        teamId: { type: "string", description: "Team id." },
        subject: { type: "string", description: "Task subject (shown in the member's assignment prompt)." },
        description: { type: "string", description: "Optional task description." },
        dependencies: {
          type: "array",
          items: { type: "string" },
          description: "Task ids that must be 'completed' before this task is dispatched.",
        },
        maxAttempts: {
          type: "number",
          description: "Attempt cap before the task is marked failed (default 3).",
        },
        workerName: {
          type: "string",
          description:
            "Optional worker contract name (e.g. patent-search-commander) the task expects; dispatch-time tier check against the assignee role.",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamCreateTaskOutput>> => {
      // 输入校验（锁外，M5 review）：subject 非空白；maxAttempts 正整数（0 会配合 attemptsExhausted 首回合判失败）
      if (input.subject.trim() === "") {
        throw new SatiToolRuntimeError("invalid_tool_input", "任务主题不能为空");
      }
      if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)) {
        throw new SatiToolRuntimeError("invalid_tool_input", `maxAttempts 必须为正整数，收到：${input.maxAttempts}`);
      }
      // 阶段 3：workerName 存在性校验（锁外，workerRegistry 未注入时跳过——fail-open）。
      if (
        input.workerName !== undefined &&
        workerRegistry !== undefined &&
        workerRegistry.get(input.workerName) === undefined
      ) {
        throw new SatiToolRuntimeError("invalid_tool_input", `worker 未注册：${input.workerName}`);
      }
      let taskId = "";
      let blockedByCount = 0;
      await withTeamLock(input.teamId, async () => {
        const team = requireTeamCaptain(db, context.sessionId, input.teamId);
        assertTeamActive(team); // F4：归档后只读——不再向已归档团队投新任务
        const known = db.listTasks(input.teamId);
        for (const dep of input.dependencies ?? []) {
          if (!known.some(t => t.id === dep)) {
            throw new SatiToolRuntimeError("team_task_not_found", `依赖任务不存在：${dep}`);
          }
        }
        taskId = `t-${randomUUID().slice(0, 8)}`;
        // 8 位前缀碰撞理论概率极低，但一旦发生即响亮失败（insert 主键冲突会抛出难读的 SQLite 错误）。
        // T7 修正：任务已存在却抛「不存在」语义颠倒，改抛 team_task_exists（任务确实存在，只是 id 撞了）。
        // 该路径运行时不可达（taskId 内部生成 `t-<uuid8>`，无法从 input 指定），不做运行时单测。
        if (db.getTask(input.teamId, taskId) !== undefined) {
          throw new SatiToolRuntimeError("team_task_exists", `任务 id 碰撞，请重试：${taskId}`);
        }
        // M4（质量审阅）：依赖输入去重（重复 id 令 blockedByCount/事件 payload 失真）。
        // I3（质量审阅）：成环检测——防御性接入（create 时刻依赖只能指向既有任务，
        // 图论上必不成环；依赖未来可变时此即唯一防线，见 taskpool/cycle.ts）。
        const deps = [...new Set(input.dependencies ?? [])];
        const cycle = detectDependencyCycle(known, taskId, deps);
        if (cycle !== undefined) {
          throw new SatiToolRuntimeError("team_task_cycle", `任务依赖成环：${cycle.join(" → ")}`);
        }
        blockedByCount = unsatisfiedDependencies(known, deps).length;
        const row: TeamTaskRow = {
          id: taskId,
          teamId: input.teamId,
          subject: input.subject,
          description: input.description ?? "",
          status: "pending",
          dependencies: deps,
          attempt: 0,
          reassigning: false,
          blockedByCount,
          maxAttempts: input.maxAttempts ?? 3,
          workerName: input.workerName,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        db.insertTask(row);
        emit(team.captainSessionKey, {
          type: "task_created",
          teamId: input.teamId,
          taskId,
          subject: input.subject,
          dependencies: deps,
        });
      });
      // 锁外触发调度（scheduler 内部自己拿锁，防重入死锁——M2 C1 惯例；fire-and-forget）
      void scheduler.onTaskGraphChanged(input.teamId).catch(() => undefined);
      return {
        content: [
          {
            type: "text",
            text: `team_create_task taskId=${taskId} subject=${input.subject} blockedBy=${blockedByCount}`,
          },
        ],
        data: { teamId: input.teamId, taskId, subject: input.subject, status: "pending", blockedByCount },
      };
    },
  };
}

export type TeamUpdateTaskInput = {
  teamId: string;
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  attemptId: string;
  output?: string;
  reason?: string;
};
export type TeamUpdateTaskOutput = {
  teamId: string;
  taskId: string;
  status: string;
  attempt: number;
  assigneeId?: string;
  output?: string;
};

export function createTeamUpdateTaskTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamUpdateTaskInput, TeamUpdateTaskOutput> {
  const { db, scheduler, emit } = options;
  return {
    name: "team_update_task",
    outputSchema: {
      type: "object",
      required: ["teamId", "taskId", "status", "attempt"],
      properties: {
        teamId: { type: "string" },
        taskId: { type: "string" },
        status: { type: "string" },
        attempt: { type: "number" },
        assigneeId: { type: "string" },
        output: { type: "string" },
      },
    },
    description:
      "Advance a task to a terminal state. Members may only update tasks assigned to themselves; the captain may update any task. Pass the attemptId from the assignment prompt — writes with a stale attemptId are rejected (fail-closed). One exemption: the captain may cancel a 'pending' task without a matching attemptId (no attempt has begun, attemptId is always absent); 'claimed'/'in_progress' tasks are never exempted. 'completed' accepts output; 'failed' accepts reason; 'cancelled' accepts neither. Completing a task unlocks its dependents for dispatch.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId", "taskId", "status", "attemptId"],
      additionalProperties: false,
      properties: {
        teamId: { type: "string", description: "Team id." },
        taskId: { type: "string", description: "Task id." },
        status: {
          type: "string",
          enum: ["completed", "failed", "cancelled"],
          description: "Terminal status to move to.",
        },
        attemptId: {
          type: "string",
          description: "Current attemptId (from the assignment prompt). Required — guards against stale writes.",
        },
        output: { type: "string", description: "Completion output (status=completed)." },
        reason: { type: "string", description: "Failure reason (status=failed)." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamUpdateTaskOutput>> => {
      // 锁内身份分流（T5 review）：成员路径 requireTeamMember（assignee 校验），
      // 队长路径 requireTeamCaptain（同队校验，跳过 assignee 校验但 attemptId 仍校验）。
      // 成员会话形态解析失败（畸形/净化）或 sessionId 缺失 → 走队长路径的
      // requireTeamCaptain → team_actor_unknown（fail-closed，绝不放行）。
      const actor = resolveActor(context.sessionId);
      let next: TeamTaskRow | undefined;
      await withTeamLock(input.teamId, async () => {
        let memberId: string | undefined;
        let captainKey: string;
        if (actor !== undefined && !actor.captain) {
          memberId = requireTeamMember(db, actor, input.teamId);
          const team = db.getTeam(input.teamId);
          if (team === undefined) {
            throw new SatiToolRuntimeError("team_not_found", `团队不存在：${input.teamId}`);
          }
          captainKey = team.captainSessionKey;
        } else {
          // 队长路径（F4：归档后只读；成员路径已因全员退休被 team_member_retired 天然挡住，无需重复）
          const team = requireTeamCaptain(db, context.sessionId, input.teamId);
          assertTeamActive(team);
          captainKey = team.captainSessionKey;
        }
        const task = db.getTask(input.teamId, input.taskId);
        if (task === undefined) {
          throw new SatiToolRuntimeError("team_task_not_found", `任务不存在：${input.taskId}`);
        }
        if (memberId !== undefined && task.assigneeId !== memberId) {
          throw new SatiToolRuntimeError("team_not_assignee", `任务 ${input.taskId} 不属于当前成员`);
        }
        // I2 review：队长路径对 pending → cancelled 豁免 attemptId 校验——
        // 白名单允许该迁移，但 pending 任务 attemptId 恒缺失会误杀；claimed/in_progress 仍强制 fail-closed。
        const pendingCancelExempt = memberId === undefined && task.status === "pending" && input.status === "cancelled";
        if (!pendingCancelExempt) {
          const guard = validateAttemptUpdate(task, input.attemptId);
          if (guard !== undefined) {
            throw new SatiToolRuntimeError("team_stale_attempt", guard);
          }
        }
        const transition = transitionError(task.status, input.status);
        if (transition !== undefined) {
          throw new SatiToolRuntimeError("team_bad_transition", transition);
        }
        next = {
          ...task,
          status: input.status,
          // M7 review：仅 completed 保留 output（failed/cancelled 显式清空，不留陈旧结果）
          output: input.status === "completed" ? (input.output ?? "") : undefined,
          updatedAt: new Date().toISOString(),
        };
        db.updateTask(next);
        recomputeBlockedByCount(db, input.teamId); // 本任务终态可能解锁下游
        // 事件锁内发出（M2 review：与 create/reassign 及 T5 惯例统一；emit 为同步入队）
        if (input.status === "completed") {
          emit(captainKey, {
            type: "task_completed",
            teamId: input.teamId,
            taskId: input.taskId,
            memberId: next.assigneeId ?? "",
            attempt: next.attempt,
            output: next.output,
          });
        } else if (input.status === "failed") {
          emit(captainKey, {
            type: "task_failed",
            teamId: input.teamId,
            taskId: input.taskId,
            memberId: next.assigneeId ?? "",
            attempt: next.attempt,
            reason: input.reason,
          });
        } else {
          emit(captainKey, {
            type: "task_updated",
            teamId: input.teamId,
            taskId: input.taskId,
            status: next.status,
            attemptId: next.attemptId,
          });
        }
      });
      if (next !== undefined) {
        // 锁外触发调度：下游依赖可能解锁（onTaskGraphChanged 内部自己拿锁，防重入死锁；fire-and-forget）
        void scheduler.onTaskGraphChanged(input.teamId).catch(() => undefined);
      }
      return {
        content: [
          {
            type: "text",
            text: `team_update_task taskId=${input.taskId} status=${input.status} attempt=${next?.attempt ?? 0}`,
          },
        ],
        data: {
          teamId: input.teamId,
          taskId: input.taskId,
          status: next?.status ?? input.status,
          attempt: next?.attempt ?? 0,
          ...(next?.assigneeId !== undefined ? { assigneeId: next.assigneeId } : {}),
          ...(next?.output !== undefined ? { output: next.output } : {}),
        },
      };
    },
  };
}

export type TeamReassignTaskInput = { teamId: string; taskId: string; memberId?: string };
export type TeamReassignTaskOutput = { teamId: string; taskId: string; status: string; assigneeId?: string };

export function createTeamReassignTaskTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamReassignTaskInput, TeamReassignTaskOutput> {
  const { db, scheduler, emit } = options;
  return {
    name: "team_reassign_task",
    outputSchema: {
      type: "object",
      required: ["teamId", "taskId", "status"],
      properties: {
        teamId: { type: "string" },
        taskId: { type: "string" },
        status: { type: "string" },
        assigneeId: { type: "string" },
      },
    },
    description:
      "Reassign a non-terminal task: to a specific member (immediately re-dispatched to them) or back to the pool without a memberId (held in 'reassigning' state, not auto-dispatched until reassigned again). The previous attemptId becomes stale — late writes are rejected. Captain-only.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId", "taskId"],
      additionalProperties: false,
      properties: {
        teamId: { type: "string", description: "Team id." },
        taskId: { type: "string", description: "Task id." },
        memberId: {
          type: "string",
          description: "Target member id. Omit to return the task to the pool (held, not auto-dispatched).",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => true,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamReassignTaskOutput>> => {
      let assigned: { status: string; assigneeId?: string } | undefined;
      await withTeamLock(input.teamId, async () => {
        const team = requireTeamCaptain(db, context.sessionId, input.teamId);
        assertTeamActive(team); // F4：归档后只读——转派属于变更类操作
        const task = db.getTask(input.teamId, input.taskId);
        if (task === undefined) {
          throw new SatiToolRuntimeError("team_task_not_found", `任务不存在：${input.taskId}`);
        }
        if (TERMINAL_TASK_STATUSES.includes(task.status)) {
          throw new SatiToolRuntimeError("team_task_terminal", `终态任务不可转派：${input.taskId}`);
        }
        // I1 review：指定成员须为本团队现存成员且未退休（对照 teamManagement.ts 校验样式），
        // 幽灵/他队成员/退休成员一律拒绝——避免把任务派给不存在或已无法唤醒的成员
        if (input.memberId !== undefined) {
          const member = db.getMember(input.memberId);
          if (member === undefined || member.teamId !== input.teamId) {
            throw new SatiToolRuntimeError("team_not_member", `团队成员不存在：${input.memberId}`);
          }
          if (db.isRetired(member.sessionKey)) {
            throw new SatiToolRuntimeError("team_member_retired", `团队成员已退休：${input.memberId}`);
          }
        }
        const fromMemberId = task.assigneeId ?? "";
        const next =
          input.memberId === undefined
            ? invalidateTaskAttempt(task, { reassigning: true }) // 回池：暂缓自动派发
            : invalidateTaskAttempt(task, { nextAssigneeId: input.memberId }); // 指定成员：可被 nextReadyTask 命中
        db.updateTask(next);
        emit(team.captainSessionKey, {
          type: "task_reassigned",
          teamId: input.teamId,
          taskId: input.taskId,
          fromMemberId,
          toMemberId: input.memberId ?? "",
        });
        assigned = { status: next.status, ...(next.assigneeId !== undefined ? { assigneeId: next.assigneeId } : {}) };
      });
      // 锁外 kickMember（kickMember 内部自己拿锁，防重入死锁——T5 review 定型；fire-and-forget）
      if (input.memberId !== undefined) {
        void scheduler.kickMember(input.teamId, input.memberId).catch(() => undefined);
      }
      return {
        content: [
          {
            type: "text",
            text: `team_reassign_task taskId=${input.taskId} assignee=${input.memberId ?? "pool"}`,
          },
        ],
        data: { teamId: input.teamId, taskId: input.taskId, ...assigned! },
      };
    },
  };
}
