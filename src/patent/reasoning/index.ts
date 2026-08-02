/**
 * src/patent/reasoning — 结构化推理原语（移植自 Mady domains/reasoning/）。
 *
 * - fact-blackboard.ts：事实黑板（跨步骤共享事实/规则/法条判定，软丢弃回溯）
 * - syllogism.ts：三段论引擎（大前提+小前提→结论，结论必须引用黑板事实与法条）
 */

export {
  FactBlackboard,
  ConfirmedRuleSet,
  type FactEntry,
  type FactCategory,
  type RuleConstraint,
  type Requirement,
  type RuleConfirmation,
  type ConfirmedRuleEntry,
  type ArticleJudgment,
  type ReasoningChain,
  type ReasoningChainNode,
  type FactBlackboardOptions,
} from "./fact-blackboard.js";

export {
  SyllogismBuilder,
  SyllogismError,
  ruleAssertion,
  assertChain,
  type Syllogism,
  type Premise,
  type PremiseSource,
} from "./syllogism.js";
