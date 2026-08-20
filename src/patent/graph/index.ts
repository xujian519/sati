/**
 * src/patent/graph — 图引擎 barrel。
 *
 * 导出契约（types）、状态工具（state）、降级标记（degradation）、
 * 确定性合并（merge）、节点策略（node-policy）、执行引擎（engine）、
 * 检查点（checkpoint）、适配层（adapter：handler/WorkflowManifest → 图）。
 * 领域子图在阶段 3 追加（domains/）。
 */

export * from "./types.js";
export { cloneState, getStateString, getStateArray, getStateObject } from "./state.js";
export {
  DEGRADATION_SUFFIX,
  markDegraded,
  isDegraded,
  getDegradationMark,
  degradationSummary,
} from "./degradation.js";
export { mergeWithSchema, GraphMergeError, type MergeSchema } from "./merge.js";
export { runNodeWithPolicy } from "./node-policy.js";
export { GraphBuilder, CompiledGraph, type CompiledGraphDef, type ResumePoint } from "./engine.js";
export {
  InMemoryCheckpointStore,
  JsonFileCheckpointStore,
  runGraphWithCheckpoints,
  grantApproval,
  type CheckpointedRunOptions,
  type CheckpointedRunResult,
} from "./checkpoint.js";
export {
  runStageHandler,
  manifestToGraph,
  type ManifestToGraphDeps,
} from "./adapter.js";

export {
  buildNoveltyGraph,
  extractNumericRanges,
  type BuildNoveltyGraphOptions,
  buildInventivenessGraph,
  extractInventivenessResult,
  type BuildInventivenessGraphOptions,
  buildEnablementGraph,
  extractEnablementResult,
  detectTechnicalDomain,
  type BuildEnablementGraphOptions,
  handlerNode,
  llmNode,
  ruleGateNode,
  collectStateText,
  resolveInput,
  type LlmNodeOptions,
  type RuleGateState,
  DOMAIN_GRAPHS,
  DOMAIN_INPUT_DECLARATIONS,
  type DomainGraphName,
} from "./domains/index.js";
