// context/budget 子模块 barrel。
// ui/server 桥接层经此入口消费 compactBudget（barrel 收口面，见 check-ui-server-boundary 门禁）；
// src 内部经 src/context/index.ts 消费其余符号。
export { buildCompactTokenBudget, type CompactTokenBudget } from "./compactBudget.js";
export { ToolResultBudget } from "./ToolResultBudget.js";
export { TokenBudgetManager } from "./TokenBudgetManager.js";
export { TokenAccountingRuntime } from "./TokenAccountingRuntime.js";
export { effectiveInputContextTokens } from "./effectiveContext.js";
export { countTokens, getTokenizer } from "./tokenizer.js";
