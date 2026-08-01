import assert from "node:assert/strict";
import test from "node:test";
import {
  DeferredPersistQueue,
  PATENT_DISCLAIMER,
  processPatentOutput,
  verifyCitations,
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

  // 静态表未覆盖（裸引用 + 未知条款）→ unknown 放行
  const bare = verifyCitations("参见专利法第36条。");
  assert.equal(bare.total, 1);
  assert.equal(bare.unknown, 1);
  assert.equal(bare.flagged.length, 0);

  // 静态表未覆盖 → unknown 放行
  const unknown = verifyCitations("根据专利法第61条的规定，…");
  assert.equal(unknown.unknown, 1);
  assert.equal(unknown.flagged.length, 0);
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
  const report = verifyCitations("依据专利法实施细则第20条，权利要求书应采用阿拉伯数字顺序编号。");
  assert.equal(report.total, 1);
  assert.equal(report.valid, 1);
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
