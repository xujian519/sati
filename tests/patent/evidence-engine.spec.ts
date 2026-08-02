import assert from "node:assert/strict";
import test from "node:test";
import {
  EvidenceEngine,
  STANDARD_CLEAR_CONVINCING,
  STANDARD_PREPONDERANCE,
  createSpan,
  extractWaybackMachineDate,
  inferEvidenceType,
  isBeforeFilingDate,
  isMonthOnlyDate,
  isPreciseDate,
  loadEvidenceRulesEngine,
  parseDateFlexible,
  platformCredibility,
  type EvidenceSpan,
} from "../../src/patent/index.js";

function span(overrides: Partial<EvidenceSpan> & { snippet?: string }): EvidenceSpan {
  return createSpan({ snippet: "", direction: "neutral", ...overrides });
}

// ---------------------------------------------------------------------------
// 三性判定
// ---------------------------------------------------------------------------

test("三性：完整证据（来源+哈希+版本+绑定+方向）三项高分", () => {
  const engine = new EvidenceEngine();
  const j = engine.judge(
    span({
      sourceUri: "web:https://www.cnipa.gov.cn/page",
      docVersion: "2023-01-01",
      contentHash: "abc123",
      claimRefs: ["C1"],
      direction: "supporting",
      snippet: "原文",
    }),
  );
  assert.ok(j.relevanceJudgment!.score >= 0.85, `relevance=${j.relevanceJudgment!.score}`);
  assert.ok(j.authenticityJudgment!.score >= 0.85, `authenticity=${j.authenticityJudgment!.score}`);
  assert.ok(j.legalityJudgment!.score >= 0.85, `legality=${j.legalityJudgment!.score}`);
  assert.equal(j.flaggedIssues.length, 0);
});

test("三性：仅有摘录的证据评分低并标记问题", () => {
  const engine = new EvidenceEngine();
  const j = engine.judge(span({ snippet: "只有摘录" }));
  assert.ok(j.relevanceJudgment!.score < 0.85);
  assert.ok(j.legalityJudgment!.score < 0.85);
  assert.ok(j.authenticityJudgment!.score < 0.85);
  // 无来源 URI → 合法性存疑（critical）
  assert.ok(j.flaggedIssues.some(i => i.type === "legality" && i.severity === "critical"));
});

// ---------------------------------------------------------------------------
// 类型特定判定
// ---------------------------------------------------------------------------

test("类型推断：web_pub: scheme → internet_publication", () => {
  assert.equal(inferEvidenceType(span({ sourceUri: "web_pub:https://example.com" })), "internet_publication");
  assert.equal(inferEvidenceType(span({ sourceUri: "pub_use:2023年销售" })), "public_use");
  assert.equal(inferEvidenceType(span({ sourceUri: "witness:证人证言" })), "witness_testimony");
  assert.equal(inferEvidenceType(span({ sourceUri: "patent:CN123" })), "prior_art_date");
  assert.equal(inferEvidenceType(span({ sourceUri: "file:///tmp/a.pdf" })), "general");
});

test("互联网公开：平台可信度 + 日期 + 完整性 + 意图", () => {
  const engine = new EvidenceEngine();
  const j = engine.judge(
    span({
      sourceUri: "web_pub:https://www.cnipa.gov.cn/notice",
      docVersion: "2023-01-15",
      contentHash: "hash1",
      snippet: "公告",
      direction: "supporting",
    }),
    "2023-06-01",
  );
  const ts = j.typeSpecificJudgment!;
  assert.equal(ts.platformCredibility, "high");
  assert.equal(ts.contentIntegrity, "verified");
  assert.equal(ts.publicIntent, "public");
  assert.equal(ts.dateDetermination?.determined, "2023-01-15");
  assert.equal(ts.dateDetermination?.reliability, "high");
  assert.equal(ts.dateDetermination?.isPriorArt, true); // 早于 2023-06-01 申请日
});

test("互联网公开：无日期时经 Wayback 存档日期提取", () => {
  const engine = new EvidenceEngine();
  const j = engine.judge(
    span({
      sourceUri: "web_pub:https://web.archive.org/web/20230615000000/https://example.com/page",
      direction: "neutral",
    }),
  );
  assert.equal(j.typeSpecificJudgment?.dateDetermination?.determined, "2023-06-15");
  assert.equal(j.typeSpecificJudgment?.dateDetermination?.sourceType, "wayback_machine");
});

test("互联网公开：申请日之前的公开日构成现有技术", () => {
  const engine = new EvidenceEngine();
  const j = engine.judge(
    span({ sourceUri: "web_pub:https://example.com", docVersion: "2022-12-01", direction: "neutral" }),
    "2023-06-01",
  );
  assert.equal(j.typeSpecificJudgment?.dateDetermination?.isPriorArt, true);
});

test("使用公开：销售 + 无保密 → 四要件全部满足", () => {
  const engine = new EvidenceEngine();
  const j = engine.judge(
    span({
      sourceUri: "pub_use:2023年1月销售",
      docVersion: "2023-01-10",
      snippet: "2023年1月10日在上海公开销售该产品",
      direction: "contradicting",
    }),
  );
  const fe = j.typeSpecificJudgment?.fourElementsCheck;
  assert.ok(fe, "使用公开应有四要件检查");
  assert.equal(fe!.allMet, true);
  assert.equal(fe!.methodElement.detail.includes("销售"), true);
  assert.equal(fe!.accessibility.met, true);
  assert.ok(j.typeSpecificJudgment?.burdenDifficulty !== undefined);
});

test("使用公开：保密协议 → 公众可获取性不满足", () => {
  const engine = new EvidenceEngine();
  const j = engine.judge(
    span({ sourceUri: "pub_use:内部测试", snippet: "在保密协议约束下的内部测试使用", direction: "neutral" }),
  );
  const fe = j.typeSpecificJudgment?.fourElementsCheck;
  assert.ok(fe, "使用公开应有四要件检查");
  assert.equal(fe!.accessibility.met, false);
  assert.equal(fe!.allMet, false);
});

test("电子证据：社交平台可信度低（显式类型）", () => {
  const engine = new EvidenceEngine();
  const j = engine.judge(
    span({ sourceUri: "web:https://weibo.com/u/123", direction: "neutral" }),
    undefined,
    "electronic",
  );
  assert.equal(j.typeSpecificJudgment?.platformCredibility, "low");
  assert.equal(j.typeSpecificJudgment?.credibilityScore, 0.25);
});

test("公知常识：免证", () => {
  const engine = new EvidenceEngine();
  const j = engine.judge(span({ sourceUri: "common:公知常识", direction: "neutral" }));
  assert.equal(j.typeSpecificJudgment?.evidenceType, "general"); // 未显式标注时不推断公知常识
});

// ---------------------------------------------------------------------------
// 平台可信度
// ---------------------------------------------------------------------------

test("platformCredibility：政府/学术/新闻/社交分级", () => {
  assert.equal(platformCredibility("web:https://www.cnipa.gov.cn/x"), "high");
  assert.equal(platformCredibility("web:https://www.court.gov.cn/x"), "high");
  assert.equal(platformCredibility("web:https://cnki.net/x"), "high");
  assert.equal(platformCredibility("web:https://patents.google.com/patent/CN1"), "medium_high");
  assert.equal(platformCredibility("web:https://www.bbc.com/news"), "medium");
  assert.equal(platformCredibility("web:https://baidu.com/s"), "medium");
  assert.equal(platformCredibility("web:https://weibo.com/u/1"), "low");
  assert.equal(platformCredibility(""), "low");
});

// ---------------------------------------------------------------------------
// 日期判定
// ---------------------------------------------------------------------------

test("parseDateFlexible：多格式解析", () => {
  assert.ok(parseDateFlexible("2023-01-02") !== null);
  assert.ok(parseDateFlexible("2023/01/02") !== null);
  assert.ok(parseDateFlexible("2023.01.02") !== null);
  assert.ok(parseDateFlexible("20230102") !== null);
  assert.ok(parseDateFlexible("2023年1月2日") !== null);
  assert.ok(parseDateFlexible("2023年01月02日") !== null);
  assert.ok(parseDateFlexible("Jan 2, 2023") !== null);
  assert.ok(parseDateFlexible("2023年1月") !== null);
  assert.equal(parseDateFlexible("not-a-date"), null);
  assert.equal(parseDateFlexible("2023-02-30"), null); // 溢出回绕拒绝
});

test("isPreciseDate / isMonthOnlyDate 区分精度", () => {
  assert.equal(isPreciseDate("2023-01-02"), true);
  assert.equal(isPreciseDate("2023年1月2日"), true);
  assert.equal(isMonthOnlyDate("2023-01"), true);
  assert.equal(isMonthOnlyDate("2023年1月"), true);
  assert.equal(isPreciseDate("2023-01"), false);
  assert.equal(isMonthOnlyDate("2023-01-02"), false);
});

test("isBeforeFilingDate：公开日早于申请日", () => {
  assert.equal(isBeforeFilingDate("2023-01-02", "2023-06-01"), true);
  assert.equal(isBeforeFilingDate("2023-07-01", "2023-06-01"), false);
  assert.equal(isBeforeFilingDate("", "2023-06-01"), false);
});

test("英文月份日期：精确解析且不被截为年-月（isPriorArt 不反转）", () => {
  // 真实公开日 2023-01-20 晚于申请日 2023-01-15 → 不构成现有技术
  const engine = new EvidenceEngine();
  const j = engine.judge(
    span({ sourceUri: "web_pub:https://example.com", docVersion: "Jan 20, 2023", direction: "neutral" }),
    "2023-01-15",
  );
  // 英文精确日期被规范化为 ISO（2023-01-20），不再截为年-月（2023-01）
  assert.equal(j.typeSpecificJudgment?.dateDetermination?.determined, "2023-01-20");
  assert.equal(j.typeSpecificJudgment?.dateDetermination?.isPriorArt, false, "英文精确日期不得截为年-月");

  // Sept 变体（美国专利文件常见）
  assert.ok(parseDateFlexible("Sept 2, 2023") !== null);
  assert.equal(isPreciseDate("Sept 2, 2023"), true);
});

test("Wayback URL：id_ 后缀时间戳可提取，伪造域名被拒绝", () => {
  // 标准浏览器捕获形态 /web/20230615093000id_/
  assert.equal(
    extractWaybackMachineDate("https://web.archive.org/web/20230615093000id_/http://example.com"),
    "2023-06-15",
  );
  // 伪造域名（含 archive.org 子串但非该域）
  assert.equal(extractWaybackMachineDate("https://web.archive.org.evil.com/web/20230615/x"), "");
});

// ---------------------------------------------------------------------------
// 举证责任与证明标准
// ---------------------------------------------------------------------------

test("举证责任：无效宣告请求人 / 侵权权利人 / 新产品举证倒置", () => {
  const engine = new EvidenceEngine();
  const invalidation = engine.assessBurdenOfProof("invalidation");
  assert.equal(invalidation.burdenHolder, "claimant");
  assert.equal(invalidation.standard, STANDARD_PREPONDERANCE);
  assert.equal(invalidation.hasShifted, false);

  const infringement = engine.assessBurdenOfProof("infringement");
  assert.equal(infringement.standard, STANDARD_CLEAR_CONVINCING);

  const productMethod = engine.assessBurdenOfProof("new_product_method");
  assert.equal(productMethod.hasShifted, true);
  assert.ok(productMethod.shiftReason!.includes("倒置"));
});

test("证明标准：优势证据 — 支持多于矛盾且置信度 ≥0.5", () => {
  const engine = new EvidenceEngine();
  const strong1 = engine.judge(
    span({
      sourceUri: "web:https://www.cnipa.gov.cn",
      contentHash: "a",
      claimRefs: ["C1"],
      direction: "supporting",
      snippet: "x",
    }),
  );
  const strong2 = engine.judge(
    span({
      sourceUri: "web:https://cnki.net",
      contentHash: "b",
      claimRefs: ["C1"],
      direction: "supporting",
      snippet: "y",
    }),
  );
  const weak = engine.judge(span({ snippet: "无来源无哈希" }));
  const result = engine.assessProofStandard([strong1, strong2, weak], STANDARD_PREPONDERANCE);
  assert.equal(result.met, true);
  assert.ok(result.supportingCount >= 2);
});

test("证明标准：优势证据 — 支持与矛盾持平不达标", () => {
  const engine = new EvidenceEngine();
  const strong = engine.judge(
    span({
      sourceUri: "web:https://www.cnipa.gov.cn",
      contentHash: "a",
      claimRefs: ["C1"],
      direction: "supporting",
      snippet: "x",
    }),
  );
  const weak = engine.judge(span({ snippet: "无来源无哈希" }));
  const result = engine.assessProofStandard([strong, weak], STANDARD_PREPONDERANCE);
  assert.equal(result.met, false);
});

test("证明标准：高度盖然性 — 置信度 ≥0.7 且支持 > 2×矛盾", () => {
  const engine = new EvidenceEngine();
  const strong1 = engine.judge(
    span({
      sourceUri: "web:https://www.cnipa.gov.cn",
      contentHash: "a",
      claimRefs: ["C1"],
      direction: "supporting",
      snippet: "x",
    }),
  );
  const strong2 = engine.judge(
    span({
      sourceUri: "web:https://cnki.net",
      contentHash: "b",
      claimRefs: ["C1"],
      direction: "supporting",
      snippet: "y",
    }),
  );
  const result = engine.assessProofStandard([strong1, strong2], STANDARD_CLEAR_CONVINCING);
  assert.equal(result.met, true);
});

test("证明标准：无证据 → 不达标", () => {
  const engine = new EvidenceEngine();
  const result = engine.assessProofStandard([], STANDARD_PREPONDERANCE);
  assert.equal(result.met, false);
  assert.ok(result.gaps.includes("无证据支持"));
});

// ---------------------------------------------------------------------------
// YAML 规则加载与权重
// ---------------------------------------------------------------------------

test("loadRules：加载证据规则资产后权重生效且规则可查", () => {
  const engine = new EvidenceEngine(
    `
weights:
  relevance: 0.5
  legality: 0.25
  authenticity: 0.25
rules:
  - ruleId: EVI-001
    name: 证据相关性审查
    description: d
    severity: major
    action: apply
    evidenceType: general
    check:
      type: relevance
      method: triple-attribute
  - ruleId: EVI-010
    name: 电子证据审查规则
    description: d
    severity: major
    action: apply
    evidenceType: electronic
    check:
      type: electronic
      method: credibility_scaled
`,
  );
  assert.equal(engine.getRules().length, 2);
  assert.equal(engine.getRulesByType("electronic").length, 1);
  assert.equal(engine.getRulesByType("electronic")[0]!.ruleId, "EVI-010");
});

test("loadRules：坏规则跳过不阻塞整体加载", () => {
  const engine = new EvidenceEngine(
    `
weights:
  relevance: 0.35
  legality: 0.3
  authenticity: 0.35
rules:
  - ruleId: EVI-001
    name: 证据相关性审查
    description: d
    severity: major
    action: apply
    evidenceType: general
  - 缺字段
`,
  );
  assert.equal(engine.getRules().length, 1);
  assert.ok(engine.getWarnings().length > 0);
});

test("loadEvidenceRulesEngine：从仓库资产加载（15 条规则）", () => {
  const { engine, source, warnings } = loadEvidenceRulesEngine();
  assert.ok(source !== null, `资产未找到: ${warnings.join(";")}`);
  const rules = engine.getRules();
  assert.ok(rules.length >= 15, `期望 ≥15 条规则，实际 ${rules.length}`);
  // 权重来自资产
  const j = engine.judge(
    span({
      sourceUri: "web:https://www.cnipa.gov.cn",
      contentHash: "a",
      claimRefs: ["C1"],
      direction: "supporting",
      snippet: "x",
    }),
  );
  assert.ok(j.overallScore > 0.8);
});

// ---------------------------------------------------------------------------
// 审查回归：web: 推断 / 评分上溢 / confidence / 规则应用
// ---------------------------------------------------------------------------

test("inferEvidenceType：web: 前缀 → internet_publication（工具文档默认格式）", () => {
  assert.equal(
    inferEvidenceType(span({ sourceUri: "web:https://blog.example.com/posts/123" })),
    "internet_publication",
  );
  const engine = new EvidenceEngine();
  const j = engine.judge(
    span({
      sourceUri: "web:https://www.cnipa.gov.cn/notice",
      docVersion: "2023-01-15",
      contentHash: "h",
      direction: "supporting",
    }),
  );
  const ts = j.typeSpecificJudgment!;
  assert.equal(ts.evidenceType, "internet_publication");
  assert.equal(ts.platformCredibility, "high");
  assert.equal(ts.dateDetermination?.determined, "2023-01-15");
});

test("综合评分不超 1.0（可信度修正截断）", () => {
  const engine = new EvidenceEngine();
  const j = engine.judge(
    span({
      sourceUri: "web:https://www.cnipa.gov.cn/x",
      docVersion: "2023-01-01",
      contentHash: "h",
      claimRefs: ["C1"],
      direction: "supporting",
      snippet: "完整证据",
    }),
  );
  assert.ok(j.overallScore <= 1.0, `overallScore=${j.overallScore} 应 ≤1.0`);
});

test("confidence 与评分关联（低分证据不宣称确信）", () => {
  const engine = new EvidenceEngine();
  const bare = engine.judge(span({ snippet: "无来源无哈希" }));
  assert.ok(bare.confidence < 0.8, `confidence=${bare.confidence} 应随评分降低`);
  assert.ok(bare.confidence > 0, "confidence 应为正数");
});

test("规则应用：匹配类型的规则按条件评估（satisfied/pending/failed）", () => {
  const engine = new EvidenceEngine(
    `
weights:
  relevance: 0.35
  legality: 0.3
  authenticity: 0.35
rules:
  - ruleId: EVI-010
    name: 电子证据审查规则
    description: d
    severity: major
    action: apply
    evidenceType: electronic
    check:
      type: electronic
      method: credibility_scaled
      conditions:
        - evidence_has_source_uri
  - ruleId: EVI-011
    name: 域外证据审查规则
    description: d
    severity: major
    action: notify
    evidenceType: overseas
    check:
      type: overseas
      method: multi_condition
      conditions:
        - evidence_notarized
        - evidence_translated
`,
  );
  // 有来源的电子证据：EVI-010 satisfied；EVI-011 不适用（类型不匹配）
  const withSource = engine.judge(
    span({ sourceUri: "web:https://x.com", direction: "neutral" }),
    undefined,
    "electronic",
  );
  const e010 = withSource.rulesApplied.find(r => r.ruleId === "EVI-010")!;
  assert.equal(e010.satisfied, true);
  assert.deepEqual(e010.failedConditions, []);
  assert.equal(
    withSource.rulesApplied.some(r => r.ruleId === "EVI-011"),
    false,
    "类型不匹配的规则不参与",
  );

  // 域外证据未提供公证/译本输入：EVI-011 pending（不误判为失败）
  const overseas = engine.judge(span({ snippet: "域外证据" }), undefined, "overseas");
  const e011 = overseas.rulesApplied.find(r => r.ruleId === "EVI-011")!;
  assert.equal(e011.satisfied, false);
  assert.deepEqual(e011.pendingInputs, ["evidence_notarized", "evidence_translated"]);

  // 提供外部输入后 satisfied
  const withInputs = engine.judge(span({ snippet: "域外证据" }), undefined, "overseas", {
    notarized: true,
    translated: true,
  });
  const e011ok = withInputs.rulesApplied.find(r => r.ruleId === "EVI-011")!;
  assert.equal(e011ok.satisfied, true);
  assert.deepEqual(e011ok.pendingInputs, []);
});
