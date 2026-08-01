/**
 * 人机协作计划状态机（移植自 Mady plantask/：state_machine.go + planner.go 的 HCL 闭环）。
 *
 * 状态：planning → awaiting_approval → executing → awaiting_feedback → replanning → finished
 *   - 白名单迁移矩阵，非法迁移抛错（fail-closed）
 *   - 计划步骤哈希化映射为任务 + blockedBy 顺序依赖
 *   - 反馈 → 重规划 → 哈希比对已完成步骤 → 增量续跑（只执行未完成步骤）
 */

export type PlanTaskState =
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "awaiting_feedback"
  | "replanning"
  | "finished";

/** 状态迁移白名单（Mady state_machine.go 的迁移矩阵）。 */
export const TRANSITIONS: Record<PlanTaskState, PlanTaskState[]> = {
  planning: ["awaiting_approval"],
  awaiting_approval: ["executing", "replanning", "finished"],
  executing: ["awaiting_feedback", "finished"],
  awaiting_feedback: ["replanning", "finished"],
  replanning: ["awaiting_approval", "executing"],
  finished: [],
};

export class PlanTaskStateError extends Error {
  constructor(from: PlanTaskState, to: PlanTaskState) {
    super(`非法状态迁移: ${from} → ${to}`);
    this.name = "PlanTaskStateError";
  }
}

/** 计划状态机：只允许白名单内迁移。 */
export class PlanTaskStateMachine {
  private current: PlanTaskState;

  constructor(initial: PlanTaskState = "planning") {
    this.current = initial;
  }

  get state(): PlanTaskState {
    return this.current;
  }

  canTransition(to: PlanTaskState): boolean {
    return TRANSITIONS[this.current].includes(to);
  }

  transition(to: PlanTaskState): PlanTaskState {
    if (!this.canTransition(to)) {
      throw new PlanTaskStateError(this.current, to);
    }
    this.current = to;
    return this.current;
  }
}

export type PlanTaskStatus = "pending" | "in_progress" | "completed";

export type PlanTask = {
  id: string;
  description: string;
  /** 步骤内容的哈希（重规划时比对已完成步骤） */
  hash: string;
  status: PlanTaskStatus;
  /** 前置依赖任务 id（顺序执行） */
  blockedBy?: string[];
};

export type PlanTaskSyncResult = {
  tasks: PlanTask[];
  /** 重规划时已完成的步骤（哈希匹配） */
  preserved: string[];
  /** 需要（重新）执行的步骤 */
  toRun: string[];
};

/** 简单内容哈希（FNV-1a 32 位，十六进制）。 */
export function hashStep(step: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < step.length; i += 1) {
    hash ^= step.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * 把计划步骤同步为任务列表：每步一个任务，按顺序建立 blockedBy 依赖。
 * 同一会话内哈希不变，重规划时可据此识别未变化的已完成步骤（增量续跑）。
 */
export function syncPlanToTasks(planSteps: string[]): PlanTaskSyncResult {
  const tasks: PlanTask[] = planSteps.map((step, idx) => ({
    id: `task-${idx + 1}`,
    description: step,
    hash: hashStep(step.trim()),
    status: "pending" as const,
    blockedBy: idx === 0 ? undefined : [`task-${idx}`],
  }));
  return {
    tasks,
    preserved: [],
    toRun: planSteps.map((_, idx) => `task-${idx + 1}`),
  };
}

/**
 * 重规划：对比新旧计划，哈希相同的步骤视为已完成（preserved），
 * 其余标记为 toRun；新任务继承旧任务的完成状态。
 */
export function replanTasks(previous: PlanTask[], newPlanSteps: string[]): PlanTaskSyncResult {
  const prevByHash = new Map(previous.map(t => [t.hash, t]));
  const tasks: PlanTask[] = [];
  const preserved: string[] = [];
  const toRun: string[] = [];

  newPlanSteps.forEach((step, idx) => {
    const hash = hashStep(step.trim());
    const prev = prevByHash.get(hash);
    const id = `task-${idx + 1}`;
    const wasCompleted = prev?.status === "completed";
    if (wasCompleted) {
      preserved.push(id);
    } else {
      toRun.push(id);
    }
    tasks.push({
      id,
      description: step,
      hash,
      status: wasCompleted ? "completed" : "pending",
      blockedBy: idx === 0 ? undefined : [`task-${idx}`],
    });
  });

  return { tasks, preserved, toRun };
}
