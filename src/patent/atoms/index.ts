/**
 * src/patent/atoms — Pipeline 原子操作 barrel。
 *
 * - atom.ts：Atom 声明式契约 + 注册表（纯声明，不参与执行）
 * - handler.ts：StageHandler 运行时 + PipelineState + 错误模型 + 注册表
 * - handlers/builtin.ts：五个内置原子（search/extract/compare/reasoning/approval-gate）
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
  extractAtom,
  ExtractHandler,
  compareAtom,
  CompareHandler,
  reasoningAtom,
  ReasoningHandler,
  approvalGateAtom,
  ApprovalGateHandler,
} from "./handlers/builtin.js";

import { globalAtomRegistry } from "./atom.js";
import { globalStageHandlerRegistry } from "./handler.js";
import {
  approvalGateAtom,
  ApprovalGateHandler,
  compareAtom,
  CompareHandler,
  extractAtom,
  ExtractHandler,
  reasoningAtom,
  ReasoningHandler,
  searchAtom,
  SearchHandler,
} from "./handlers/builtin.js";

/** 将五个内置原子（契约 + 运行时）注册进全局注册表。幂等：同名覆盖。 */
export function registerBuiltinAtoms(): void {
  globalAtomRegistry.register(searchAtom);
  globalAtomRegistry.register(extractAtom);
  globalAtomRegistry.register(compareAtom);
  globalAtomRegistry.register(reasoningAtom);
  globalAtomRegistry.register(approvalGateAtom);

  globalStageHandlerRegistry.register(new SearchHandler());
  globalStageHandlerRegistry.register(new ExtractHandler());
  globalStageHandlerRegistry.register(new CompareHandler());
  globalStageHandlerRegistry.register(new ReasoningHandler());
  globalStageHandlerRegistry.register(new ApprovalGateHandler());
}
