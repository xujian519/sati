/**
 * 三段论引擎（移植自 Mady domains/reasoning/syllogism.go）。
 *
 * 法务推理的结构化契约：每条结论必须由 大前提（法条） + 小前提（案件事实）
 * 推出，且结论必须引用黑板上存在的事实 ID（FactRef）与法条 ID（ArticleRef）。
 * 缺引用的三段论被 RuleAssertion 拒绝——把"结论必须可溯源"从提示语变成
 * 确定性校验。
 */

import type { FactBlackboard } from "./fact-blackboard.js";

export type PremiseSource = "statute" | "case_fact" | "precedent" | "guideline";

export type Premise = {
  /** 人读标签，如 "专利法第22条第3款" / "权利要求1的区别特征"。 */
  label: string;
  /** 来源类型：statute（法条）/ case_fact（案件事实）/ precedent（判例）/ guideline（指南）。 */
  source: PremiseSource;
  /** 引用黑板上的事实 ID / 法条 ID。 */
  refId: string;
  content: string;
};

/** 三段论：大前提（法条）+ 小前提（案件事实）→ 结论。 */
export type Syllogism = {
  id: string;
  majorPremise: Premise;
  minorPremise: Premise;
  conclusion: string;
  /** 结论引用的事实 ID（小前提的事实，必须在黑板上存在）。 */
  factRef: string;
  /** 结论引用的法条 ID（大前提的法条，必须在黑板上存在）。 */
  articleRef: string;
  confidence: number;
  validated: boolean;
};

export class SyllogismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyllogismError";
  }
}

/** 法条 ID 是否存在于黑板（规则约束或法条判定均可）。 */
function articleExists(bb: FactBlackboard, articleId: string): boolean {
  return (
    bb.confirmedRuleConstraints().some(c => c.articleId === articleId) || bb.getArticleJudgment(articleId) !== undefined
  );
}

/**
 * 三段论结论的落地校验：结论必须引用黑板上存在的事实 ID 与法条 ID。
 * 校验通过后标记 validated。
 */
export function ruleAssertion(bb: FactBlackboard, syllogism: Syllogism): Syllogism {
  if (syllogism.factRef === "" || syllogism.articleRef === "") {
    throw new SyllogismError("三段论结论缺少必要引用：必须引用黑板事实ID和法条ID");
  }
  if (bb.getFact(syllogism.factRef) === undefined) {
    throw new SyllogismError(`三段论 ${syllogism.id} 引用的事实 ${syllogism.factRef} 不存在于黑板上`);
  }
  if (!articleExists(bb, syllogism.articleRef)) {
    throw new SyllogismError(`三段论 ${syllogism.id} 引用的法条 ${syllogism.articleRef} 不存在于黑板上`);
  }
  return { ...syllogism, validated: true };
}

/** 批量校验推理链；返回第一个失败的三段论（无失败返回 undefined）。 */
export function assertChain(
  bb: FactBlackboard,
  chains: Syllogism[],
): { index: number; error: SyllogismError } | undefined {
  for (let i = 0; i < chains.length; i += 1) {
    try {
      ruleAssertion(bb, chains[i]!);
    } catch (error) {
      if (error instanceof SyllogismError) {
        return { index: i, error };
      }
      throw error;
    }
  }
  return undefined;
}

/** 三段论构建器（fluent API）：Major/Minor 后 Build 校验并返回。 */
export class SyllogismBuilder {
  private s: Syllogism;

  constructor(id: string) {
    this.s = {
      id,
      majorPremise: { label: "", source: "statute", refId: "", content: "" },
      minorPremise: { label: "", source: "case_fact", refId: "", content: "" },
      conclusion: "",
      factRef: "",
      articleRef: "",
      confidence: 0.5,
      validated: false,
    };
  }

  /** 大前提（法条/规则）；refId 成为 articleRef。 */
  major(label: string, refId: string, content: string): this {
    this.s.majorPremise = { label, source: "statute", refId, content };
    this.s.articleRef = refId;
    return this;
  }

  /** 小前提（案件事实）；refId 成为 factRef。 */
  minor(label: string, refId: string, content: string): this {
    this.s.minorPremise = { label, source: "case_fact", refId, content };
    this.s.factRef = refId;
    return this;
  }

  conclusionText(text: string, confidence = 0.5): this {
    this.s.conclusion = text;
    this.s.confidence = confidence;
    return this;
  }

  /** 对黑板校验并返回；校验失败抛 SyllogismError。 */
  build(bb: FactBlackboard): Syllogism {
    return ruleAssertion(bb, this.s);
  }
}
