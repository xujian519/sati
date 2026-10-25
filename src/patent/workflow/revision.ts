/**
 * src/patent/workflow — 回退留痕（RevisionRecord）的唯一实现。
 *
 * #734：manifest 路径与图路径都经本模块记录/闭合回退，避免再次分叉
 * （#345 的教训：同一语义两处实现必然漂移）。
 *
 * 记录生命周期：
 * 1. 触发回退：`recordRewind` 追加一条 `status: "interrupted"`、`after: ""` 的记录，
 *    并挂起该触发阶段（其重跑完成时闭合）；
 * 2. 触发阶段重跑完成（无论是否再次触发）：`closeRevision` 回填 `after` 并置 `closed`；
 * 3. 重跑前中断：记录保持 `interrupted`（`after: ""`），不伪装成已闭合。
 *
 * 图路径把账本放在内部 state 键（`_revisions` / `_revision_pending`）：
 * 检查点自动携带，`clearStageOutputs` 不会清理它们。
 */

import type { RevisionRecord } from "./types.js";

/** before/after 摘要上限（字符）。 */
export const REVISION_SUMMARY_LIMIT = 2000;

/** 图路径 state 键：已完成/挂起记录（append-only 语义）。 */
export const REVISIONS_STATE_KEY = "_revisions";

/** 图路径 state 键：挂起回退所属阶段 id。 */
export const REVISION_PENDING_STATE_KEY = "_revision_pending";

export type RevisionLedger = {
  records: RevisionRecord[];
  /** 挂起回退所属阶段（其重跑完成时闭合）；无挂起为 undefined。 */
  pendingStageId?: string;
};

export type RecordRewindOptions = {
  /** 触发回退的阶段 id。 */
  stageId: string;
  /** 触发阶段的当前输出（进入 before 摘要）。 */
  output: string;
  /** 缺口 id（结构化 gaps 或旧路径命名空间）。 */
  gapId: string;
  /** 触发来源说明。 */
  rationale: string;
  /** 记录时间（测试可注入；缺省当前时间）。 */
  at?: string;
};

/** 从已有记录创建账本（resume / 检查点恢复用）。 */
export function createRevisionLedger(records: readonly RevisionRecord[] = []): RevisionLedger {
  return { records: records.map(record => ({ ...record })) };
}

/** 输出 → 截断摘要（上限 `REVISION_SUMMARY_LIMIT`）。 */
export function summarizeRevisionOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= REVISION_SUMMARY_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, REVISION_SUMMARY_LIMIT), truncated: true };
}

/** 记录一次回退：追加挂起记录（`status: "interrupted"`，待重跑闭合）。 */
export function recordRewind(ledger: RevisionLedger, options: RecordRewindOptions): RevisionRecord {
  const before = summarizeRevisionOutput(options.output);
  const record: RevisionRecord = {
    gapId: options.gapId,
    before: before.text,
    after: "",
    rationale: options.rationale,
    at: options.at ?? new Date().toISOString(),
    status: "interrupted",
    ...(before.truncated ? { truncated: true } : {}),
  };
  ledger.records.push(record);
  ledger.pendingStageId = options.stageId;
  return record;
}

/**
 * 闭合挂起记录：仅当挂起阶段与 `stageId` 一致时回填 `after` 并置 `closed`。
 * 返回被闭合的记录；无挂起 / 阶段不匹配 → undefined（幂等，不误闭合他人的记录）。
 */
export function closeRevision(ledger: RevisionLedger, stageId: string, output: string): RevisionRecord | undefined {
  if (ledger.pendingStageId !== stageId) return undefined;
  let pending: RevisionRecord | undefined;
  for (let index = ledger.records.length - 1; index >= 0; index -= 1) {
    const record = ledger.records[index]!;
    if (record.status === "interrupted") {
      pending = record;
      break;
    }
  }
  ledger.pendingStageId = undefined;
  if (pending === undefined) return undefined;
  const after = summarizeRevisionOutput(output);
  pending.after = after.text;
  pending.status = "closed";
  if (after.truncated) pending.truncated = true;
  return pending;
}

/** 从图路径 state 读取账本（旧检查点/缺失字段 → 空账本）。 */
export function readRevisionLedger(state: Record<string, unknown>): RevisionLedger {
  const raw = state[REVISIONS_STATE_KEY];
  const records = Array.isArray(raw) ? raw.filter(isRevisionRecord).map(record => ({ ...record })) : [];
  const pending = state[REVISION_PENDING_STATE_KEY];
  return {
    records,
    ...(typeof pending === "string" && pending.length > 0 ? { pendingStageId: pending } : {}),
  };
}

/** 把账本写回图路径 state（挂起阶段缺省时删除对应键）。 */
export function writeRevisionLedger(state: Record<string, unknown>, ledger: RevisionLedger): void {
  state[REVISIONS_STATE_KEY] = ledger.records;
  if (ledger.pendingStageId === undefined) {
    delete state[REVISION_PENDING_STATE_KEY];
  } else {
    state[REVISION_PENDING_STATE_KEY] = ledger.pendingStageId;
  }
}

/** 运行时形状守卫（检查点可能来自旧版本或损坏文件）。 */
function isRevisionRecord(value: unknown): value is RevisionRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.gapId === "string" &&
    typeof record.before === "string" &&
    typeof record.after === "string" &&
    typeof record.rationale === "string" &&
    typeof record.at === "string" &&
    (record.status === "closed" || record.status === "interrupted")
  );
}
