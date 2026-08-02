import assert from "node:assert/strict";
import test from "node:test";
import {
  DeferredPersistQueue,
  PATENT_DISCLAIMER,
  processPatentOutput,
  verifyCitations,
  type CitationSource,
} from "../../src/patent/quality-gate.js";

test("processPatentOutput injects disclaimer on risk keywords", () => {
  const result = processPatentOutput("经分析，本方案存在侵权风险。");
  assert.ok(result.riskKeywordsHit.includes("侵权"));
  assert.equal(result.disclaimerInjected, true);
  assert.match(result.text, /不构成正式法律意见/);
  assert.ok(result.text.includes(PATENT_DISCLAIMER));
});

test("processPatentOutput does not double-inject disclaimer", () => {
  const withDisclaimer = "分析结论：具备新颖性。不构成正式法律意见。";
  const result = processPatentOutput(withDisclaimer);
  assert.equal(result.disclaimerInjected, false);
  assert.equal((result.text.match(/不构成正式法律意见/g) ?? []).length, 1);
});

test("processPatentOutput flags approval keywords and absolute phrases", () => {
  const result = processPatentOutput("本专利结论是：该方案构成侵权判断中的高风险。最终建议：无效。");
  assert.ok(result.approvalKeywordsHit.includes("专利结论"));
  assert.ok(result.needsApproval, "approval keyword should require human approval");
  const absolute = processPatentOutput("该方案绝对可行，必然成功。");
  assert.ok(absolute.absolutePhrasesHit.includes("绝对"));
  assert.match(absolute.text, /绝对化表述/);
});

test("DeferredPersistQueue stores, commits and discards pending messages", () => {
  const queue = new DeferredPersistQueue<string>();
  const idx = queue.store("pending message");
  assert.equal(queue.size, 1);
  assert.equal(queue.has(idx), true);
  assert.deepEqual(queue.pending(), [idx]);
  assert.equal(queue.commit(idx), "pending message");
  assert.equal(queue.size, 0);
  const idx2 = queue.store("discard me");
  queue.discard(idx2);
  assert.equal(queue.size, 0);
  assert.equal(queue.commit(idx2), undefined);
});

test("verifyCitations passes valid and unverifiable citations", () => {
  const report = verifyCitations("依据专利法第22条，本申请具备新颖性和创造性。");
  assert.equal(report.total, 1);
  assert.equal(report.valid, 1);
  assert.equal(report.flagged.length, 0);

  // 表覆盖该条但无用途声明可核对（裸引用）→ unverifiable 放行
  const bare = verifyCitations("参见专利法第36条。");
  assert.equal(bare.total, 1);
  assert.equal(bare.unverifiable, 1);
  assert.equal(bare.flagged.length, 0);

  // 静态表未覆盖 → unknown 放行
  const unknown = verifyCitations("根据专利法第61条的规定，…");
  assert.equal(unknown.unknown, 1);
  assert.equal(unknown.flagged.length, 0);
});

test("verifyCitations handles 前置式用途（引用点前子句）", () => {
  // 被宣告无效的专利权视为自始不存在（专利法第47条）——用途声明在引用点之前
  const report = verifyCitations("被宣告无效的专利权视为自始不存在（专利法第47条）。");
  assert.equal(report.total, 1);
  assert.equal(report.valid, 1);
  assert.equal(report.flagged.length, 0);
});

test("verifyCitations 无效宣告同位命名特例：理由条款不误判为张冠李戴", () => {
  // 第22条本身可作为无效宣告理由，"无效宣告"是同位命名而非指向第45-47条
  const report = verifyCitations("专利法第22条规定的无效宣告理由。");
  assert.equal(report.total, 1);
  assert.equal(report.suspect, 0);
  assert.equal(report.flagged.length, 0);
});

test("verifyCitations 支持注入 S2 知识源（CitationSource 接口）", () => {
  // S2 知识库索引扩展静态表：为第 61 条补充主题（默认 S1 表未覆盖 → unknown）
  const s2Source: CitationSource = {
    maxArticle: statute => (statute === "专利法" ? 82 : undefined),
    topics: (statute, article) => {
      if (statute === "专利法" && article === 61) return ["补充检索报告", "检索"];
      return undefined; // 其余回退 S1（合并语义）
    },
  };
  const covered = verifyCitations("根据专利法第61条，提交补充检索报告。", s2Source);
  assert.equal(covered.total, 1);
  assert.equal(covered.valid, 1);

  // S1 静态表不受注入影响（未注入时 61 条仍 unknown 放行）
  const fallback = verifyCitations("根据专利法第61条，提交补充检索报告。");
  assert.equal(fallback.unknown, 1);
});

test("verifyCitations S2 部分注入不静默禁用 S1 覆盖（合并语义）", () => {
  // 注入仅覆盖第 61 条的知识库源：S1 已收录的第 45 条仍走 S1 主题核验
  const s2Source: CitationSource = {
    maxArticle: () => undefined,
    topics: (statute, article) => (statute === "专利法" && article === 61 ? ["补充检索报告"] : undefined),
  };
  // 第45条用途描述实际指向第33条主题 → 仍应 suspect（S1 交叉匹配生效）
  const report = verifyCitations("根据专利法第45条，本申请修改未超出原始记载范围。", s2Source);
  assert.equal(report.suspect, 1, "S2 部分注入不应禁用 S1 的交叉匹配");
});

test("verifyCitations 后置子句在分号处截断（不跨分句串扰）", () => {
  // "第26条；" 后是另一子句的"新颖性"——不应让第26条 crossMatch 到第22条
  const report = verifyCitations("参见专利法第26条；本申请具备新颖性、创造性。");
  assert.equal(report.suspect, 0);
  assert.equal(report.flagged.length, 0);
});

test("verifyCitations 同句多引用：后置引用不被前一引用话题污染", () => {
  // "根据专利法第22条第3款，本申请具备创造性，参见专利法第33条。"
  // 第33条的前置子句含第22条引用 → 弃用前置子句，不误报张冠李戴
  const report = verifyCitations("根据专利法第22条第3款，本申请具备创造性，参见专利法第33条。");
  assert.equal(report.suspect, 0);
  assert.equal(report.flagged.length, 0);
});

test("verifyCitations 枚举兄弟项：后置引用不被前置兄弟项话题污染", () => {
  const report = verifyCitations("包括专利法第5条所述违反法律的情形，以及专利法第9条。");
  assert.equal(report.suspect, 0);
  assert.equal(report.flagged.length, 0);
});

test("verifyCitations 同一引用多次出现：任一出现命中主题即 valid", () => {
  // 首个出现是枚举列表（无法核对），第二个出现含主题"新颖性"→ 应 valid
  const report = verifyCitations("参见专利法第22条、第23条的现有技术规定。本申请符合专利法第22条关于新颖性的规定。");
  assert.equal(report.total, 2); // extractCitations 对相同引用去重（22 出现两次计 1 次）
  assert.equal(report.valid, 1); // 第22条第二个出现命中"新颖性"
  assert.equal(report.unknown, 1); // 第23条不在 S1 表（放行）
  assert.equal(report.flagged.length, 0);
});

test("verifyCitations flags invalid article numbers", () => {
  const report = verifyCitations("根据专利法第99条规定，…");
  assert.equal(report.total, 1);
  assert.equal(report.invalid, 1);
  assert.equal(report.flagged.length, 1);
  assert.equal(report.flagged[0].verdict, "invalid");
  assert.match(report.flagged[0].reason, /超出《专利法》有效范围/);
});

test("verifyCitations flags topic mismatch (张冠李戴)", () => {
  const report = verifyCitations("根据专利法第22条，本申请修改未超出原始记载范围。");
  assert.equal(report.total, 1);
  assert.equal(report.suspect, 1);
  assert.match(report.flagged[0].reason, /更接近《专利法》第33条/);
});

test("verifyCitations handles 实施细则 references", () => {
  // 细则条号在 2001/2010/2023 三版间漂移，表外条目落 unknown 放行（不做存在性核验）
  const outside = verifyCitations("依据专利法实施细则第20条，权利要求书应采用阿拉伯数字顺序编号。");
  assert.equal(outside.total, 1);
  assert.equal(outside.unknown, 1);
  assert.equal(outside.flagged.length, 0);

  // 收录的高频共用条目（分案申请）主题命中 → valid
  const within = verifyCitations("依据专利法实施细则第42条办理分案申请。");
  assert.equal(within.total, 1);
  assert.equal(within.valid, 1);
});

test("verifyCitations does not mis-attribute other statutes to patent law", () => {
  // "民法典第500条" 无专利法语境 → 跳过，不误报为专利法条款超范围
  const report = verifyCitations("根据民法典第500条，当事人应当履行合同义务。");
  assert.equal(report.total, 0);
  assert.equal(report.invalid, 0);
  assert.equal(report.flagged.length, 0);

  // 无前缀裸引用但有专利法前文语境 → 归属专利法
  const withContext = verifyCitations("专利法规定，根据第22条，本申请具备新颖性。");
  assert.equal(withContext.total, 1);
  assert.equal(withContext.valid, 1);

  // 长法律全称 + 跨句界：句内（含《中华人民共和国专利法》）的裸引用仍归属
  const longTitle = verifyCitations("《中华人民共和国专利法》的相关规定明确指出，第26条要求说明书应当清楚、完整。");
  assert.equal(longTitle.total, 1);
  assert.equal(longTitle.valid, 1);

  // 句界隔离：前半句专利法语境不泄漏到后半句的其他法律引用（被跳过，不计入 total）
  const boundary = verifyCitations("依据专利法第22条，本申请具备新颖性；另根据民法典第500条，双方应继续履行。");
  assert.equal(boundary.total, 1);
  assert.equal(boundary.valid, 1);
  assert.equal(boundary.invalid, 0, "民法典第500条不应被误判为专利法条款");
});

test("processPatentOutput appends citation warnings when citations are flagged", () => {
  const result = processPatentOutput("根据专利法第22条，本申请修改未超出原始记载范围。");
  assert.equal(result.citationReport.flagged.length, 1);
  assert.match(result.text, /引用核验提示/);
});
