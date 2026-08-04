import assert from "node:assert/strict";
import test from "node:test";
import {
  listSuites,
  loadAllCases,
  loadCasesBySuite,
  loadFixture,
  loadIndex,
  loadRawAllCases,
  loadRawIndex,
} from "./loader.js";
import type { BusinessTask, ClientRole } from "./types.js";

/** 业务 suite 的用例数（与 scripts/patent-benchmark-business.ts 归类结果一致）。 */
const EXPECTED_SUITES: Record<string, number> = {
  "business-patentability": 19,
  "business-drafting": 15,
  "business-file-review": 20,
  "business-oa-response": 12,
  "business-infringement": 6,
  "business-invalidation": 124,
};

const EXPECTED_TOTAL = Object.values(EXPECTED_SUITES).reduce((a, b) => a + b, 0);

const BUSINESS_TASKS: BusinessTask[] = [
  "patentability_analysis",
  "drafting",
  "file_review",
  "oa_response",
  "infringement_analysis",
  "invalidation",
  "prior_art_search",
  "disclosure_analysis",
];

const CLIENT_ROLES: ClientRole[] = [
  "专利申请客户",
  "发明人客户",
  "无效请求人客户",
  "专利权人客户",
  "企业客户",
  "企业客户（决定分析）",
];

test("benchmark business：总数 196，且各业务 suite 数量符合归类", () => {
  const index = loadIndex();
  assert.equal(index.totalCases, EXPECTED_TOTAL);
  assert.equal(index.suites.length, Object.keys(EXPECTED_SUITES).length);
  const bySuite = loadCasesBySuite();
  for (const [suite, n] of Object.entries(EXPECTED_SUITES)) {
    assert.equal(bySuite.get(suite)?.length, n, `suite ${suite} 数量不符`);
  }
  assert.equal(bySuite.size, Object.keys(EXPECTED_SUITES).length);
});

test("benchmark business：业务化字段完整且合法", () => {
  const cases = loadAllCases();
  assert.equal(cases.length, EXPECTED_TOTAL);
  const ids = new Set<string>();
  for (const c of cases) {
    assert.ok(c.id, "id 不能为空");
    assert.ok(!ids.has(c.id), `ID 重复: ${c.id}`);
    ids.add(c.id);
    assert.ok(c.input.length > 0, `${c.id} input 不能为空`);
    assert.ok(c.expected.length > 0, `${c.id} expected 不能为空`);
    assert.ok(BUSINESS_TASKS.includes(c.businessTask), `${c.id} businessTask 非法: ${c.businessTask}`);
    assert.ok(CLIENT_ROLES.includes(c.clientRole), `${c.id} clientRole 非法: ${c.clientRole}`);
    assert.ok(c.deliverable.length > 0, `${c.id} deliverable 不能为空`);
    assert.ok(c.sourceSuite.length > 0, `${c.id} sourceSuite 不能为空`);
    assert.ok(c.expected.startsWith("【"), `${c.id} expected 缺少业务文书抬头`);
  }
});

test("benchmark business：与原数据集 1:1（ID 集合一致，无增删）", () => {
  const biz = loadAllCases();
  const raw = loadRawAllCases();
  const bizIds = biz.map(c => c.id).sort();
  const rawIds = raw.map(c => c.id).sort();
  assert.deepEqual(bizIds, rawIds);
  assert.equal(biz.length, raw.length);
  // sourceSuite 必须指向真实存在的原始 suite
  const rawSuites = new Set(loadRawIndex().suites.map(s => s.suite));
  for (const c of biz) {
    assert.ok(rawSuites.has(c.sourceSuite), `${c.id} sourceSuite 非法: ${c.sourceSuite}`);
  }
});

test("benchmark business：业务归类与内容方向一致", () => {
  const cases = loadAllCases();
  const taskOf = (id: string): BusinessTask => cases.find(c => c.id === id)!.businessTask;
  // 新颖性/创造性类 → 可专利性分析
  assert.equal(taskOf("patent_exam_001"), "patentability_analysis");
  // OA 答复类
  assert.equal(taskOf("patent_exam_004"), "oa_response");
  // 侵权类
  assert.equal(taskOf("patent_exam_005"), "infringement_analysis");
  // 无效决定 → 无效宣告（决定分析）
  const inv = cases.find(c => c.id === "invalidation_decision_001")!;
  assert.equal(inv.businessTask, "invalidation");
  assert.equal(inv.clientRole, "企业客户（决定分析）");
  // 撰写类（真题 a31 / a22）
  assert.equal(taskOf("patent_exam_2007_a31_02"), "drafting");
  // 分案撰写题（真题 a31 2008）与重新撰写权利要求题（真题 a22 2017）亦为撰写
  assert.equal(taskOf("patent_exam_2008_a31_02"), "drafting");
  assert.equal(taskOf("patent_exam_2017_a22_03"), "drafting");
  // 无效答辩（真题 a22，专利权人立场）
  const defense = cases.find(c => c.id === "patent_exam_2007_a22_01")!;
  assert.equal(defense.businessTask, "invalidation");
  assert.equal(defense.clientRole, "专利权人客户");
});

test("benchmark business：业务化改写生效（场景前缀/文书抬头/考试痕迹剥离）", () => {
  const cases = loadAllCases();
  const byId = new Map(cases.map(c => [c.id, c]));

  // mock 001：考试式"请判断……并说明理由"应被替换为业务请求
  const c1 = byId.get("patent_exam_001")!;
  assert.ok(c1.input.startsWith("委托方就"), `${c1.id} 缺少委托场景前缀`);
  assert.ok(!c1.input.includes("请判断权利要求1是否具备新颖性，并说明理由"), "考试式请求未替换");
  assert.ok(c1.input.includes("请完成可专利性分析"), "缺少业务收尾请求");

  // 真题 a22_01：参考答案开头的考试行应剥离，冠以业务抬头
  const c2 = byId.get("patent_exam_2007_a22_01")!;
  assert.ok(!c2.expected.includes("全国专利代理人资格考试"), "参考答案仍含考试痕迹");
  assert.ok(!c2.expected.includes("官方参考答案要点"), "参考答案仍含考试痕迹");
  assert.ok(c2.expected.startsWith("【无效宣告意见】"));

  // 真题 a22_2010：与正文同行的"2010年真题第三题。"也应剥离
  const c2b = byId.get("patent_exam_2010_a22_02")!;
  assert.ok(!c2b.expected.includes("真题"), "参考答案仍含考试痕迹");
  assert.ok(c2b.expected.startsWith("【可专利性分析意见】"));
  assert.ok(c2b.expected.includes("大范围(0.1%~0.3%C)"), "剥离句号句时误删正文");

  // 无效决定 001：输入中的数据集痕迹行应剥离
  const c3 = byId.get("invalidation_decision_001")!;
  assert.ok(!c3.input.startsWith("无效宣告请求审查决定案例"), "决定书痕迹行未剥离");
  assert.ok(c3.input.startsWith("客户提供一份已作出的无效宣告请求审查决定书"), "缺少决定分析场景前缀");

  // 保留法条引文等原有内容
  assert.ok(Array.isArray(c1.requiredCitations) && c1.requiredCitations.includes("第二十二条第二款"));
});

test("benchmark business：单 suite 读取与文件清单一致", () => {
  const suites = listSuites();
  assert.deepEqual(suites.sort(), Object.keys(EXPECTED_SUITES).sort());
  for (const s of suites) {
    const fixture = loadFixture(s);
    assert.equal(fixture.suite, s);
    assert.equal(fixture.cases.length, fixture.caseCount);
  }
});

test("benchmark business：法条勘误与决定书修复生效（防回归）", () => {
  const cases = loadAllCases();
  const byId = new Map(cases.map(c => [c.id, c]));
  // mock 006：现有技术定义应为第二十二条第五款（非外观设计的第二十三条第四款）
  const c6 = byId.get("patent_exam_006")!;
  assert.ok(c6.expected.includes("第二十二条第五款"), "006 未引用现有技术定义条款");
  assert.ok(!c6.expected.includes("第二十三条第四款"), "006 误引外观设计条款");
  assert.ok(c6.requiredCitations?.includes("第二十二条第五款"), "006 引文缺第二十二条第五款");
  // mock 007：第二条第二款是发明定义（非实用新型定义）
  const c7 = byId.get("patent_exam_007")!;
  assert.ok(c7.expected.includes("发明是指对产品、方法或者其改进所提出的新的技术方案"), "007 发明定义缺失");
  assert.ok(!c7.expected.includes("实用新型是指"), "007 误用实用新型定义");
  // mock 008：先用权主体为在先实施者，条款为第七十五条（2020 修正版）
  const c8 = byId.get("patent_exam_008")!;
  assert.ok(c8.expected.includes("第七十五条"), "008 未引用第七十五条");
  assert.ok(!c8.expected.includes("第六十九条"), "008 误用修正前条款号");
  assert.ok(c8.requiredCitations?.includes("第七十五条"), "008 引文缺第七十五条");
  // 无效决定书：不允许残留"详见决定书正文"占位（残缺必须补全或降级标注）
  for (const c of cases) {
    if (!c.id.startsWith("invalidation_decision_")) continue;
    assert.ok(
      !c.expected.includes("详见决定书正文"),
      `${c.id} 核心理由仍为占位符（需 repair-invalidation-decisions 补全或降级标注）`,
    );
  }
});
