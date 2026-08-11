/**
 * Human-in-the-loop checkpoint handler for the workflow engine.
 *
 * Unlike the default (auto-approve) handler, this implementation suspends the
 * engine at a checkpoint until a human decision arrives. The host wires
 * `onPending` to publish the pending checkpoint (e.g. a gateway `approval_pending`
 * event + UI card), and later delivers the decision via `decide(id, decision)`.
 *
 * Design notes:
 * - Decisions are `approve | reject | edit | skip`, delivered once per pending
 *   id (`decide` is idempotent; unknown ids return false).
 * - `rejectAll` is the session-cleanup escape hatch: it settles every pending
 *   waiter with `reject` so a shut-down host never leaves the engine's
 *   checkpoint await dangling.
 * - `maxPending` caps concurrent suspensions (fail-closed: exceeding it throws
 *   {@link WorkflowCheckpointError} instead of accumulating unbounded waiters).
 */

import type {
  WorkflowCheckpointDecision,
  WorkflowCheckpointHandler,
  WorkflowPlan,
  WorkflowStep,
  WorkflowStepOutput,
} from "../protocol/types.js";
import { WorkflowCheckpointError } from "./CheckpointHandler.js";

/** 挂起检查点快照（host 发布到 gateway/UI 时使用）。 */
export type WorkflowCheckpointPending = {
  /** 自增 id（同一 handler 内唯一，decide 定位用）。 */
  id: number;
  planId: string;
  stepId: string;
  /** 步骤产出摘要（UI 展示用，截断至 500 字符）。 */
  outputPreview: string;
  createdAt: string;
};

export type HumanCheckpointHandlerOptions = {
  /** 发布挂起事件（host 接线：gateway emit / UI 通知）。 */
  onPending?: (pending: WorkflowCheckpointPending) => void;
  /** 同时挂起上限（缺省 100；达到上限时抛 WorkflowCheckpointError）。 */
  maxPending?: number;
  /** 可注入时钟（测试用）。 */
  now?: () => string;
};

const PREVIEW_LIMIT = 500;

function previewOf(output: WorkflowStepOutput): string {
  const text = output.summary ?? "";
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

export class HumanCheckpointHandler implements WorkflowCheckpointHandler {
  private readonly waiters = new Map<number, (decision: WorkflowCheckpointDecision) => void>();
  private readonly onPending?: HumanCheckpointHandlerOptions["onPending"];
  private readonly maxPending: number;
  private readonly now: () => string;
  private nextId = 1;

  constructor(options: HumanCheckpointHandlerOptions = {}) {
    this.onPending = options.onPending;
    this.maxPending = options.maxPending ?? 100;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** 当前挂起检查点数。 */
  get pendingCount(): number {
    return this.waiters.size;
  }

  hasPending(id: number): boolean {
    return this.waiters.has(id);
  }

  async waitForDecision(
    step: WorkflowStep,
    plan: WorkflowPlan,
    output: WorkflowStepOutput,
  ): Promise<WorkflowCheckpointDecision> {
    if (this.waiters.size >= this.maxPending) {
      throw new WorkflowCheckpointError(
        `HumanCheckpointHandler: 挂起审批超过上限（${this.maxPending}），拒绝新的检查点 "${step.id}"`,
      );
    }
    const pending: WorkflowCheckpointPending = {
      id: this.nextId,
      planId: plan.id,
      stepId: step.id,
      outputPreview: previewOf(output),
      createdAt: this.now(),
    };
    this.nextId += 1;
    this.onPending?.(pending);
    return new Promise<WorkflowCheckpointDecision>(resolve => {
      this.waiters.set(pending.id, resolve);
    });
  }

  /**
   * 人工决策：放行该挂起检查点。幂等：同一 id 第二次调用返回 false；
   * 未知 id 返回 false（不抛错，host 可直接尝试清理）。
   */
  decide(id: number, decision: WorkflowCheckpointDecision): boolean {
    const resolve = this.waiters.get(id);
    if (resolve === undefined) return false;
    this.waiters.delete(id);
    resolve(decision);
    return true;
  }

  /** 批量拒绝全部挂起（会话关闭/宿主清理时调用，防止 Promise 悬挂）。返回清理数。 */
  rejectAll(feedback = "宿主关闭，挂起检查点被取消"): number {
    let count = 0;
    for (const [id, resolve] of this.waiters) {
      this.waiters.delete(id);
      resolve({ action: "reject", feedback });
      count += 1;
    }
    return count;
  }
}
