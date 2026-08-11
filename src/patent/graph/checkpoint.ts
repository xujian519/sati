/**
 * src/patent/graph — 检查点（移植自 Mady graph/checkpoint.go PregelCheckpointer）。
 *
 * 粒度 = 超步：每个超步开始前持久化 { state, activeNodes, stepIndex }，
 * 崩溃/中断后 loadLatest 恢复，从该超步继续。
 *
 * ⚠️ 超步粒度恢复会重放该超步内已完成的外部副作用调用（LLM/API）——
 * 假定节点幂等（同输入同输出），审批门场景下 LLM 节点在门之前，重放影响有限。
 */

import { JsonFileStore } from "../persist-utils.js";
import type { CheckpointStore, GraphCheckpoint, GraphRunResult, GraphState, RunOptions } from "./types.js";
import { cloneState } from "./state.js";

/** 内存检查点存储（默认；单进程内可用）。 */
export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly checkpoints = new Map<string, GraphCheckpoint>();

  async save(checkpoint: GraphCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.id, { ...checkpoint, state: cloneState(checkpoint.state) });
  }

  async load(id: string): Promise<GraphCheckpoint | undefined> {
    const cp = this.checkpoints.get(id);
    // 返回克隆：调用方（resume）不应能通过引用改坏存储内状态。
    return cp === undefined ? undefined : { ...cp, state: cloneState(cp.state), activeNodes: [...cp.activeNodes] };
  }

  async loadLatest(graphId: string): Promise<GraphCheckpoint | undefined> {
    const candidates = [...this.checkpoints.values()]
      .filter(cp => cp.graphId === graphId)
      .sort((a, b) => a.stepIndex - b.stepIndex || a.createdAt - b.createdAt);
    return candidates.at(-1);
  }

  async list(graphId: string): Promise<string[]> {
    return [...this.checkpoints.values()]
      .filter(cp => cp.graphId === graphId)
      .sort((a, b) => a.stepIndex - b.stepIndex || a.createdAt - b.createdAt)
      .map(cp => cp.id);
  }
}

/** 每 id 一个 JSON 文件的检查点存储（复用 JsonFileStore 原子写）。 */
export class JsonFileCheckpointStore implements CheckpointStore {
  private readonly store: JsonFileStore<GraphCheckpoint>;

  constructor(dir: string) {
    this.store = new JsonFileStore<GraphCheckpoint>(dir, raw => JSON.parse(raw) as GraphCheckpoint, "checkpointId");
  }

  async save(checkpoint: GraphCheckpoint): Promise<void> {
    await this.store.save(checkpoint.id, checkpoint);
  }

  async load(id: string): Promise<GraphCheckpoint | undefined> {
    return this.store.load(id);
  }

  async loadLatest(graphId: string): Promise<GraphCheckpoint | undefined> {
    const ids = await this.list(graphId);
    if (ids.length === 0) return undefined;
    return this.store.load(ids.at(-1)!);
  }

  async list(graphId: string): Promise<string[]> {
    const ids = await this.store.listIds();
    const matches: Array<{ id: string; stepIndex: number; createdAt: number }> = [];
    for (const id of ids) {
      const cp = await this.store.load(id);
      if (cp?.graphId === graphId) matches.push({ id, stepIndex: cp.stepIndex, createdAt: cp.createdAt });
    }
    return matches.sort((a, b) => a.stepIndex - b.stepIndex || a.createdAt - b.createdAt).map(m => m.id);
  }
}

/** 带检查点的运行选项。 */
export type CheckpointedRunOptions = RunOptions & {
  store: CheckpointStore;
  graphId: string;
  /** 非空时从该检查点恢复（resume），否则从头运行。 */
  resumeFrom?: GraphCheckpoint;
};

/** 带检查点的运行结果。 */
export type CheckpointedRunResult = {
  result: GraphRunResult;
  /**
   * 最后一个保存的检查点 id：在**最后超步开始前**保存（state 为该超步起点，
   * 不含该超步合并结果）。中断后可 resume；完成时续跑会重放最后超步（幂等前提）。
   */
  checkpointId?: string;
};

/**
 * 带检查点的图运行：每超步开始前保存 checkpoint。
 * resumeFrom 提供时从该检查点继续（等价"断点续跑"）。
 * 返回最后一个 checkpoint id 供中断后 resume。
 */
export async function runGraphWithCheckpoints(
  graph: {
    run(initial: GraphState, opts?: RunOptions): Promise<GraphRunResult>;
    resume(checkpoint: GraphCheckpoint, opts?: RunOptions): Promise<GraphRunResult>;
  },
  initial: GraphState,
  opts: CheckpointedRunOptions,
): Promise<CheckpointedRunResult> {
  let lastCheckpointId: string | undefined;

  const checkpointingOpts: RunOptions = {
    provider: opts.provider,
    failFast: opts.failFast,
    onSuperStepStart: async (step, activeNodes, state) => {
      await opts.onSuperStepStart?.(step, activeNodes, state);
      const checkpoint: GraphCheckpoint = {
        id: `${opts.graphId}-${step}`,
        graphId: opts.graphId,
        stepIndex: step,
        state: cloneState(state),
        activeNodes: [...activeNodes],
        createdAt: Date.now(),
      };
      await opts.store.save(checkpoint);
      lastCheckpointId = checkpoint.id;
    },
  };

  const result = opts.resumeFrom
    ? await graph.resume(opts.resumeFrom, checkpointingOpts)
    : await graph.run(initial, checkpointingOpts);

  return { result, checkpointId: lastCheckpointId };
}
