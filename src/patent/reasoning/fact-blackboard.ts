/**
 * 事实黑板（移植自 Mady domains/reasoning/fact_blackboard.go）。
 *
 * 法务推理的共享事实记忆：多步骤推理（如五步工作法）各阶段把提取的事实、
 * 推理链、规则约束、法条判定写入黑板，下游阶段消费。软丢弃（DiscardedAt）
 * 支持回退追溯；Lock 后任何修改抛错（程序员误用防护）。
 *
 * TS 单线程无需互斥锁，但保留 locked 语义与 Go 版对齐。
 */

export type FactCategory = "technical" | "legal" | "procedural" | "temporal";

/** 单条事实（对齐 Mady FactEntry）。 */
export type FactEntry = {
  id: string;
  /** 来源：user_text | file | cnipa_query | manual。 */
  source: string;
  content: string;
  filePath?: string;
  confidence: number;
  extractedAt: string;
  /** 软丢弃时间（回溯用；非空 = 已丢弃）。 */
  discardedAt?: string;
  category?: FactCategory;
  tags?: string[];
};

/** 规则约束的强制级别。 */
export type Requirement = "must" | "should" | "note";

/** 规则约束（从法条/审查指南抽取，计划必须满足）。 */
export type RuleConstraint = {
  articleId: string;
  articleName: string;
  requirement: Requirement;
  description: string;
  applicableStages?: string[];
};

/** 人工确认状态。 */
export type RuleConfirmation = "confirmed" | "modified" | "rejected";

/** 规则 + 人工确认状态（modified 时用 Modified 覆盖原规则）。 */
export type ConfirmedRuleEntry = {
  rule: RuleConstraint;
  status: RuleConfirmation;
  modified?: RuleConstraint;
  feedback?: string;
  confirmedAt?: string;
};

/** 人工确认规则集的不可变快照（rejected 条目保留审计但隔离）。 */
export class ConfirmedRuleSet {
  constructor(
    public readonly entries: ConfirmedRuleEntry[],
    public readonly confirmedAt: string,
  ) {}

  /** 下游阶段只消费 confirmed/modified 条目（modified 用编辑版）。 */
  activeConstraints(): RuleConstraint[] {
    const out: RuleConstraint[] = [];
    for (const entry of this.entries) {
      if (entry.status === "confirmed") out.push(entry.rule);
      else if (entry.status === "modified" && entry.modified !== undefined) out.push(entry.modified);
      // rejected：保留审计，隔离不消费
    }
    return out;
  }
}

/** 法条判定（结论 + 依据）。 */
export type ArticleJudgment = {
  articleId: string;
  satisfied: boolean;
  reasoning: string;
  confidence: number;
  judgedAt: string;
};

/** 推理链节点与链（结论 + 支持/矛盾证据引用）。 */
export type ReasoningChainNode = {
  step: number;
  type: string;
  content: string;
  factRefs: string[];
};

export type ReasoningChain = {
  id: string;
  nodes: ReasoningChainNode[];
  conclusion: string;
  confidence: number;
};

export type FactBlackboardOptions = {
  caseId: string;
  caseType: string;
  technicalField?: string;
  createdAt?: string;
  now?: () => string;
};

/**
 * 事实黑板。所有变更方法在 Lock 后抛错（防误用，对齐 Mady checkNotLocked）。
 */
export class FactBlackboard {
  readonly caseId: string;
  readonly caseType: string;
  readonly technicalField: string;
  readonly createdAt: string;
  updatedAt: string;
  locked = false;

  private readonly facts: FactEntry[] = [];
  private readonly reasoningChains: ReasoningChain[] = [];
  private readonly ruleConstraints: RuleConstraint[] = [];
  private readonly articleJudgments = new Map<string, ArticleJudgment>();
  private confirmedRules: ConfirmedRuleSet | undefined;
  private readonly now: () => string;

  constructor(options: FactBlackboardOptions) {
    const ts = options.now !== undefined ? options.now() : new Date().toISOString();
    this.caseId = options.caseId;
    this.caseType = options.caseType;
    this.technicalField = options.technicalField ?? "";
    this.createdAt = options.createdAt ?? ts;
    this.updatedAt = ts;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private touch(): void {
    this.updatedAt = this.now();
  }

  private checkNotLocked(): void {
    if (this.locked) throw new Error("factBlackboard: attempt to mutate a locked blackboard");
  }

  lock(): void {
    this.locked = true;
    this.touch();
  }

  isLocked(): boolean {
    return this.locked;
  }

  // -------------------------------------------------------------------------
  // Facts
  // -------------------------------------------------------------------------

  allFacts(): FactEntry[] {
    return structuredClone(this.facts);
  }

  /** 仅未丢弃的事实（深拷贝：外部修改不得绕过 Lock 防护）。 */
  activeFacts(): FactEntry[] {
    return structuredClone(this.facts.filter(f => f.discardedAt === undefined));
  }

  addFact(fact: FactEntry): void {
    this.checkNotLocked();
    this.facts.push(structuredClone(fact));
    this.touch();
  }

  getFact(id: string): FactEntry | undefined {
    const fact = this.facts.find(f => f.id === id);
    return fact !== undefined ? structuredClone(fact) : undefined;
  }

  /** 软丢弃（回溯时保留历史，IsDiscarded 语义）。 */
  discardFact(id: string): void {
    this.checkNotLocked();
    const fact = this.facts.find(f => f.id === id);
    if (fact !== undefined && fact.discardedAt === undefined) {
      fact.discardedAt = this.now();
      this.touch();
    }
  }

  // -------------------------------------------------------------------------
  // Reasoning chains
  // -------------------------------------------------------------------------

  chains(): ReasoningChain[] {
    return structuredClone(this.reasoningChains);
  }

  addReasoningChain(chain: ReasoningChain): void {
    this.checkNotLocked();
    this.reasoningChains.push(chain);
    this.touch();
  }

  clearReasoningChains(): void {
    this.checkNotLocked();
    this.reasoningChains.length = 0;
    this.touch();
  }

  // -------------------------------------------------------------------------
  // Rule constraints & confirmed set
  // -------------------------------------------------------------------------

  constraints(): RuleConstraint[] {
    return structuredClone(this.ruleConstraints);
  }

  addRuleConstraint(constraint: RuleConstraint): void {
    this.checkNotLocked();
    this.ruleConstraints.push(constraint);
    this.touch();
  }

  setRuleConstraints(constraints: RuleConstraint[]): void {
    this.checkNotLocked();
    this.ruleConstraints.length = 0;
    this.ruleConstraints.push(...constraints);
    this.touch();
  }

  /** 人工确认的规则集（Stage ② 后）；未确认时为 undefined。 */
  getConfirmedRules(): ConfirmedRuleSet | undefined {
    return this.confirmedRules;
  }

  setConfirmedRules(ruleSet: ConfirmedRuleSet): void {
    this.checkNotLocked();
    this.confirmedRules = ruleSet;
    this.touch();
  }

  /** 下游阶段消费的规则约束：确认后只用 active 条目，未确认时回退原始约束。 */
  confirmedRuleConstraints(): RuleConstraint[] {
    return this.confirmedRules !== undefined ? this.confirmedRules.activeConstraints() : [...this.ruleConstraints];
  }

  // -------------------------------------------------------------------------
  // Article judgments
  // -------------------------------------------------------------------------

  allArticleJudgments(): Map<string, ArticleJudgment> {
    return new Map(this.articleJudgments);
  }

  setArticleJudgment(judgment: ArticleJudgment): void {
    this.checkNotLocked();
    this.articleJudgments.set(judgment.articleId, judgment);
    this.touch();
  }

  getArticleJudgment(articleId: string): ArticleJudgment | undefined {
    return this.articleJudgments.get(articleId);
  }

  // -------------------------------------------------------------------------
  // 序列化（JSON 可持久化，供检查点/恢复）
  // -------------------------------------------------------------------------

  toJSON(): string {
    return JSON.stringify({
      caseId: this.caseId,
      caseType: this.caseType,
      technicalField: this.technicalField,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      locked: this.locked,
      facts: this.facts,
      reasoningChains: this.reasoningChains,
      ruleConstraints: this.ruleConstraints,
      articleJudgments: [...this.articleJudgments.entries()],
      confirmedRules:
        this.confirmedRules !== undefined
          ? { entries: this.confirmedRules.entries, confirmedAt: this.confirmedRules.confirmedAt }
          : undefined,
    });
  }

  /** 反序列化（now 可选：注入自定义时钟保持时间确定性，缺省用真实时钟）。 */
  static fromJSON(text: string, now?: () => string): FactBlackboard {
    const data = JSON.parse(text) as {
      caseId: string;
      caseType: string;
      technicalField?: string;
      createdAt: string;
      updatedAt: string;
      locked: boolean;
      facts: FactEntry[];
      reasoningChains: ReasoningChain[];
      ruleConstraints: RuleConstraint[];
      articleJudgments: Array<[string, ArticleJudgment]>;
      confirmedRules?: { entries: ConfirmedRuleEntry[]; confirmedAt: string };
    };
    const bb = new FactBlackboard({
      caseId: data.caseId,
      caseType: data.caseType,
      technicalField: data.technicalField,
      createdAt: data.createdAt,
      now,
    });
    bb.updatedAt = data.updatedAt;
    bb.locked = data.locked;
    for (const fact of data.facts) bb.facts.push(fact);
    for (const chain of data.reasoningChains) bb.reasoningChains.push(chain);
    for (const constraint of data.ruleConstraints) bb.ruleConstraints.push(constraint);
    for (const [id, judgment] of data.articleJudgments) bb.articleJudgments.set(id, judgment);
    if (data.confirmedRules !== undefined) {
      bb.confirmedRules = new ConfirmedRuleSet(data.confirmedRules.entries, data.confirmedRules.confirmedAt);
    }
    return bb;
  }
}
