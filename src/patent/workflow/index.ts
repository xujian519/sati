/**
 * src/patent/workflow — barrel。
 *
 * 从 workflow.ts 拆出的类型契约与内置 manifest 数据统一出口；
 * 执行器（runWorkflow / validateWorkflowManifest）仍在 src/patent/workflow.ts 门面。
 */

export type {
  WorkflowContext,
  WorkflowInterrupt,
  WorkflowManifest,
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowRunStore,
  WorkflowStage,
  WorkflowStageResult,
  WorkflowStrategy,
} from "./types.js";
export { WorkflowError } from "./types.js";
export {
  builtinPatentManifests,
  patentDisclosureManifest,
  patentInfringementManifest,
  patentInventivenessManifest,
  patentInvalidationManifest,
  patentNoveltyManifest,
  patentOaResponseManifest,
  patentPatentabilityManifest,
  type BuiltinPatentManifest,
} from "./manifests.js";
