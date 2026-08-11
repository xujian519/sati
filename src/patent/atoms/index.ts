/**
 * src/patent/atoms — Pipeline 原子操作 barrel。
 *
 * - atom.ts：Atom 声明式契约 + 注册表（纯声明，不参与执行）
 * - handler.ts：StageHandler 运行时 + PipelineState + 错误模型 + 注册表
 * - handlers/builtin/：内置原子（search/extract/compare/reasoning/groundedness/
 *   keywords/novelty/merge/draft-claims/approval-gate，按职责分域）
 *
 * 使用：调用 registerBuiltinAtoms() 将内置原子注册进全局注册表；
 * workflow 执行时也可注入局部注册表（隔离测试 / 覆盖同名原子）。
 */

export {
  type Atom,
  type AtomCategory,
  AtomRegistry,
  AtomRegistryError,
  globalAtomRegistry,
  RegisterAtom,
  LookupAtom,
  ListAtoms,
  ListAtomsByCategory,
} from "./atom.js";

export {
  type PipelineState,
  type StageProvider,
  type StageExecuteInput,
  type StageHandler,
  StageError,
  InterruptStageError,
  isInterruptStageError,
  getStateString,
  setStateString,
  getStateArray,
  StageHandlerRegistry,
  globalStageHandlerRegistry,
  RegisterStageHandler,
  LookupStageHandler,
} from "./handler.js";

export {
  searchAtom,
  SearchHandler,
  keywordsAtom,
  KeywordsHandler,
  extractAtom,
  ExtractHandler,
  mergeAtom,
  MergeHandler,
  compareAtom,
  CompareHandler,
  noveltyAtom,
  NoveltyHandler,
  evidenceCoverage,
  reasoningAtom,
  ReasoningHandler,
  groundednessAtom,
  GroundednessHandler,
  GROUNDEDNESS_THRESHOLD,
  draftClaimsAtom,
  DraftClaimsHandler,
  approvalGateAtom,
  ApprovalGateHandler,
  APPROVAL_GRANTED_KEY,
  APPROVAL_GRANTED_OUTPUT,
  isApprovalGateHandler,
  type PFETriple,
} from "./handlers/builtin/index.js";

import { globalAtomRegistry } from "./atom.js";
import { globalStageHandlerRegistry } from "./handler.js";
import * as builtin from "./handlers/builtin/index.js";

/** 将内置原子（契约 + 运行时）注册进全局注册表。幂等：同名覆盖。 */
export function registerBuiltinAtoms(): void {
  globalAtomRegistry.register(builtin.searchAtom);
  globalAtomRegistry.register(builtin.extractAtom);
  globalAtomRegistry.register(builtin.compareAtom);
  globalAtomRegistry.register(builtin.reasoningAtom);
  globalAtomRegistry.register(builtin.groundednessAtom);
  globalAtomRegistry.register(builtin.keywordsAtom);
  globalAtomRegistry.register(builtin.noveltyAtom);
  globalAtomRegistry.register(builtin.mergeAtom);
  globalAtomRegistry.register(builtin.draftClaimsAtom);
  globalAtomRegistry.register(builtin.approvalGateAtom);

  globalStageHandlerRegistry.register(new builtin.SearchHandler());
  globalStageHandlerRegistry.register(new builtin.ExtractHandler());
  globalStageHandlerRegistry.register(new builtin.CompareHandler());
  globalStageHandlerRegistry.register(new builtin.ReasoningHandler());
  globalStageHandlerRegistry.register(new builtin.GroundednessHandler());
  globalStageHandlerRegistry.register(new builtin.KeywordsHandler());
  globalStageHandlerRegistry.register(new builtin.NoveltyHandler());
  globalStageHandlerRegistry.register(new builtin.MergeHandler());
  globalStageHandlerRegistry.register(new builtin.DraftClaimsHandler());
  globalStageHandlerRegistry.register(new builtin.ApprovalGateHandler());
}
