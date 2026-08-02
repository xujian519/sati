import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfirmedRuleSet,
  FactBlackboard,
  SyllogismBuilder,
  assertChain,
  ruleAssertion,
  type RuleConstraint,
  type Syllogism,
} from "../../src/patent/index.js";

let clock = 0;
const now = () => `2026-01-01T00:00:${String(clock++).padStart(2, "0")}Z`;

function makeBlackboard(): FactBlackboard {
  const bb = new FactBlackboard({
    caseId: "case-1",
    caseType: "invalidation",
    technicalField: "机械",
    now,
  });
  bb.addFact({
    id: "F1",
    source: "user_text",
    content: "权利要求1的区别特征是压缩弹簧",
    confidence: 0.9,
    extractedAt: now(),
    category: "technical",
  });
  bb.addRuleConstraint({
    articleId: "A22.3",
    articleName: "专利法第22条第3款",
    requirement: "must",
    description: "创造性：非显而易见",
  });
  return bb;
}

// ---------------------------------------------------------------------------
// FactBlackboard：事实增删与软丢弃
// ---------------------------------------------------------------------------

test("黑板：事实增删、软丢弃与 activeFacts 过滤", () => {
  const bb = makeBlackboard();
  assert.equal(bb.activeFacts().length, 1);
  assert.equal(bb.getFact("F1")?.content, "权利要求1的区别特征是压缩弹簧");

  bb.discardFact("F1");
  assert.equal(bb.activeFacts().length, 0);
  // 软丢弃保留历史（allFacts 仍可见，用于回溯）
  assert.equal(bb.allFacts().length, 1);
  assert.ok(bb.getFact("F1")?.discardedAt !== undefined);
});

test("黑板：Lock 后修改抛错（防误用）", () => {
  const bb = makeBlackboard();
  bb.lock();
  assert.equal(bb.isLocked(), true);
  assert.throws(
    () => bb.addFact({ id: "F2", source: "manual", content: "x", confidence: 0.5, extractedAt: now() }),
    /locked/,
  );
  assert.throws(() => bb.discardFact("F1"), /locked/);
  // 只读仍可用
  assert.equal(bb.getFact("F1")?.id, "F1");
});

// ---------------------------------------------------------------------------
// ConfirmedRuleSet：人工确认规则隔离
// ---------------------------------------------------------------------------

test("黑板：confirmedRuleConstraints 只消费 confirmed/modified", () => {
  const bb = makeBlackboard();
  const constraints: RuleConstraint[] = [
    { articleId: "A22.3", articleName: "专利法第22条第3款", requirement: "must", description: "创造性" },
    { articleId: "A26.4", articleName: "专利法第26条第4款", requirement: "must", description: "支持" },
  ];
  bb.setRuleConstraints(constraints);

  // 未确认：回退原始约束
  assert.equal(bb.confirmedRuleConstraints().length, 2);

  // 确认：rejected 被隔离，modified 用编辑版
  bb.setConfirmedRules(
    new ConfirmedRuleSet(
      [
        { rule: constraints[0]!, status: "confirmed" },
        {
          rule: constraints[1]!,
          status: "modified",
          modified: { ...constraints[1]!, requirement: "should", description: "支持（修改后）" },
        },
        {
          rule: { articleId: "A33", articleName: "专利法第33条", requirement: "must", description: "修改超范围" },
          status: "rejected",
        },
      ],
      now(),
    ),
  );
  const active = bb.confirmedRuleConstraints();
  assert.equal(active.length, 2);
  assert.ok(!active.some(c => c.articleId === "A33"), "rejected 应被隔离");
  assert.equal(active.find(c => c.articleId === "A26.4")?.requirement, "should");
});

// ---------------------------------------------------------------------------
// 三段论：RuleAssertion
// ---------------------------------------------------------------------------

test("三段论：引用黑板事实与法条的结论校验通过", () => {
  const bb = makeBlackboard();
  const syllogism = new SyllogismBuilder("S1")
    .major("专利法第22条第3款", "A22.3", "创造性：非显而易见")
    .minor("权利要求1区别特征", "F1", "压缩弹簧")
    .conclusionText("权利要求1具备创造性", 0.8)
    .build(bb);
  assert.equal(syllogism.validated, true);
  assert.equal(syllogism.factRef, "F1");
  assert.equal(syllogism.articleRef, "A22.3");
});

test("三段论：结论缺引用被拒绝", () => {
  const bb = makeBlackboard();
  // builder 的 Major/Minor 已自动设置 articleRef/factRef；缺引用场景直接构造对象
  const bare: Syllogism = {
    id: "S2",
    majorPremise: { label: "专利法第22条第3款", source: "statute", refId: "A22.3", content: "创造性" },
    minorPremise: { label: "权利要求1区别特征", source: "case_fact", refId: "F1", content: "压缩弹簧" },
    conclusion: "具备创造性",
    factRef: "",
    articleRef: "",
    confidence: 0.5,
    validated: false,
  };
  assert.throws(() => ruleAssertion(bb, bare), /缺少必要引用/);
});

test("三段论：引用不存在的事实被拒绝", () => {
  const bb = makeBlackboard();
  assert.throws(
    () =>
      new SyllogismBuilder("S3")
        .major("专利法第22条第3款", "A22.3", "创造性")
        .minor("不存在的特征", "F99", "x")
        .conclusionText("具备创造性", 0.5)
        .build(bb),
    /引用的事实 F99 不存在于黑板上/,
  );
});

test("三段论：引用不存在的法条被拒绝（规则约束或法条判定均需存在）", () => {
  const bb = makeBlackboard();
  assert.throws(
    () =>
      new SyllogismBuilder("S4")
        .major("专利法第33条", "A33", "修改超范围")
        .minor("权利要求1区别特征", "F1", "压缩弹簧")
        .conclusionText("修改未超范围", 0.5)
        .build(bb),
    /引用的法条 A33 不存在于黑板上/,
  );

  // 法条判定存在时放行
  bb.setArticleJudgment({
    articleId: "A33",
    satisfied: true,
    reasoning: "修改有原申请记载支持",
    confidence: 0.9,
    judgedAt: now(),
  });
  const ok = new SyllogismBuilder("S5")
    .major("专利法第33条", "A33", "修改超范围")
    .minor("权利要求1区别特征", "F1", "压缩弹簧")
    .conclusionText("修改未超范围", 0.5)
    .build(bb);
  assert.equal(ok.validated, true);
});

test("三段论：assertChain 返回首个失败项", () => {
  const bb = makeBlackboard();
  const good: Syllogism = new SyllogismBuilder("G1")
    .major("专利法第22条第3款", "A22.3", "创造性")
    .minor("权利要求1区别特征", "F1", "压缩弹簧")
    .conclusionText("具备创造性", 0.7)
    .build(bb);
  const bad: Syllogism = {
    id: "B1",
    majorPremise: { label: "专利法第33条", source: "statute", refId: "A33", content: "x" },
    minorPremise: { label: "F", source: "case_fact", refId: "F1", content: "y" },
    conclusion: "修改未超范围",
    factRef: "F1",
    articleRef: "A33",
    confidence: 0.5,
    validated: false,
  };
  const failure = assertChain(bb, [good, bad]);
  assert.ok(failure !== undefined);
  assert.equal(failure!.index, 1);
  assert.match(failure!.error.message, /A33/);
});

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

test("黑板：JSON 序列化往返一致", () => {
  const bb = makeBlackboard();
  bb.addFact({ id: "F2", source: "file", content: "背景技术", confidence: 0.7, extractedAt: now(), tags: ["背景"] });
  bb.setArticleJudgment({
    articleId: "A22.3",
    satisfied: true,
    reasoning: "非显而易见",
    confidence: 0.9,
    judgedAt: now(),
  });
  bb.lock();

  const restored = FactBlackboard.fromJSON(bb.toJSON());
  assert.equal(restored.caseId, "case-1");
  assert.equal(restored.activeFacts().length, 2);
  assert.equal(restored.getFact("F2")?.tags?.[0], "背景");
  assert.equal(restored.getArticleJudgment("A22.3")?.satisfied, true);
  assert.equal(restored.isLocked(), true);
});
