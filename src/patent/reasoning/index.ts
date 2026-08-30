/**
 * src/patent/reasoning — 结构化推理原语（移植自 Mady domains/reasoning/）。
 *
 * - fact-blackboard.ts：事实黑板（跨步骤共享事实/规则/法条判定，软丢弃回溯）
 * - syllogism.ts：三段论引擎（大前提+小前提→结论，结论必须引用黑板事实与法条）
 *
 * ⚠️ 预留 API（尚无生产执行链）：当前无工具/原子/图节点消费本模块（attachArticleJudgment
 * 仅测试可达）；接线目标为 draft-claims/compare 原子链。勿误认为已参与运行时判定。
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
