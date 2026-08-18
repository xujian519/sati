/**
 * src/patent/workflow — manifest 路径断点续跑（T10）。
 *
 * 语义：与 graph 路径（超步粒度 checkpoint）互补，manifest 路径以**阶段粒度**
 * 落检查点——每阶段完成即持久化 { 已完成阶段结果, 阶段间 state, 已放行审批门 }；
 * 中断（approval-gate）后，调用方批准审批门并 resume（resumeFrom = 上次检查点）
 * 即可跳过已完成阶段续跑，LLM/检索副作用不重放。
 *
 * 与 approvalGrants 的关系：resume 时已放行的审批门经 options.approvalGrants
 * 注入（同一放行契约）；检查点仅记录"哪些已放行"供审计与自动续跑。
 */

import { JsonFileStore } from "../persist-utils.js";
import type { PipelineState } from "../atoms/index.js";
import type {
  ManifestCheckpoint,
  ManifestCheckpointStage,
  ManifestCheckpointStore,
  WorkflowStageResult,
} from "./types.js";

/** 每 id 一个 JSON 文件的检查点存储（复用 JsonFileStore 原子写 + 安全 id）。 */
export class JsonFileManifestCheckpointStore implements ManifestCheckpointStore {
  private readonly store: JsonFileStore<ManifestCheckpoint>;

  constructor(dir: string) {
    this.store = new JsonFileStore<ManifestCheckpoint>(dir, raw => JSON.parse(raw) as ManifestCheckpoint, "runId");
  }

  async save(checkpoint: ManifestCheckpoint): Promise<void> {
    await this.store.save(checkpoint.id, checkpoint);
  }

  async load(id: string): Promise<ManifestCheckpoint | undefined> {
    return this.store.load(id);
  }
}

/** 阶段结果 → 检查点快照（剥离运行时字段）。 */
export function stageToCheckpointStage(stage: WorkflowStageResult): ManifestCheckpointStage {
  return {
    stageId: stage.stageId,
    strategy: stage.strategy,
    output: stage.output,
    degraded: stage.degraded,
    retries: stage.retries,
    ...(stage.atom !== undefined ? { atom: stage.atom } : {}),
    ...(stage.workerValidation !== undefined ? { workerValidation: stage.workerValidation } : {}),
  };
}

/**
 * 从检查点恢复：返回 { results, state, approvalGrants }。
 * state 为深拷贝（避免 resume 后原地写坏存储内数据）。
 */
export function restoreFromCheckpoint(checkpoint: ManifestCheckpoint): {
  results: WorkflowStageResult[];
  state: PipelineState;
  approvalGrants: string[];
} {
  const results: WorkflowStageResult[] = checkpoint.completedStages.map(s => ({
    stageId: s.stageId,
    strategy: s.strategy,
    output: s.output,
    degraded: s.degraded,
    retries: s.retries,
    ...(s.atom !== undefined ? { atom: s.atom } : {}),
    ...(s.workerValidation !== undefined ? { workerValidation: s.workerValidation } : {}),
  }));
  const state: PipelineState = JSON.parse(JSON.stringify(checkpoint.state));
  return { results, state, approvalGrants: [...checkpoint.approvalGrants] };
}
