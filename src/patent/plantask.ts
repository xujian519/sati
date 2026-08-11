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

/** 语义守卫失败（迁移合法但前置条件不满足）：executing 需已 sync 任务 / replanning 需反馈。 */
export class PlanTaskSemanticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanTaskSemanticError";
  }
}

/** transition 的语义上下文：前置条件随迁移传入（fail-closed，缺省即拒绝）。 */
export type PlanTaskTransitionContext = {
  /** 计划任务列表（to=executing 时必需且非空：执行必须有任务，先 sync 计划步骤）。 */
  tasks?: readonly PlanTask[];
  /** 重规划反馈（to=replanning 时必需且非空：反馈驱动重规划）。 */
  feedback?: string;
};

/**
 * 迁移语义守卫表：目标状态 → 前置条件校验（返回违规消息；undefined = 通过）。
 * 数据表驱动，新增状态守卫无需改动 transition 本体。
 */
const SEMANTIC_GUARDS: Partial<Record<PlanTaskState, (ctx: PlanTaskTransitionContext) => string | undefined>> = {
  executing: ctx =>
    ctx.tasks !== undefined && ctx.tasks.length > 0 ? undefined : "executing 前必须先 sync 计划步骤（tasks 非空）",
  replanning: ctx =>
    ctx.feedback !== undefined && ctx.feedback.trim() !== "" ? undefined : "replanning 必须有反馈（feedback 非空）",
};

/** 计划状态机：只允许白名单内迁移，并强制迁移前置条件（语义守卫）。 */
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

  transition(to: PlanTaskState, context: PlanTaskTransitionContext = {}): PlanTaskState {
    if (!this.canTransition(to)) {
      throw new PlanTaskStateError(this.current, to);
    }
    // 语义强制（fail-closed）：白名单之外的业务前置条件，缺省即拒绝——
    // 强制"计划步骤先同步成任务再执行、有反馈才重规划"，不允许空转。
    const violation = SEMANTIC_GUARDS[to]?.(context);
    if (violation !== undefined) {
      throw new PlanTaskSemanticError(violation);
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
