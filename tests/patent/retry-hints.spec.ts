/**
 * src/patent/retry-hints —— 断言安全修订提示（隐藏清单闭环）。
 *
 * 契约：hint 只携带证据（命中短语 label/建议替换/行级定位），绝不含任何
 * 评分数字（总分/通过线/各维分数）——worker 从提示中只能看到"审到了什么"，
 * 无法反推"怎么凑分"。文本样本经 slop-engine 实测校准（勿随意替换）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSlop, type SlopAnalysis } from "../../src/patent/slop-engine.js";
import { buildSlopRevisionHint } from "../../src/patent/retry-hints.js";

const SOS_ASSERTION_PATTERN =
  /(?:35|43|通过线|总分|分数|得分|[0-9]+\s*分|directness|evidence|rhythm|practicality|concision|满分)/;

/** hint 若携带任何评分断言即违规。 */
function assertNoScoreAssertion(hint: string): void {
  assert.doesNotMatch(hint, SOS_ASSERTION_PATTERN, `hint 不得携带评分断言: ${hint}`);
}

/** 实测未通过文本（18 段套话 → total 29 < 35）。 */
const FAILING_TEXT = Array.from({ length: 18 }, () => "综上所述，具有显著进步，保护范围合理。").join("\n\n");
/** 实测通过文本（total 36；无 changes/issues）。 */
const CLEAN_TEXT = [
  "## 具体实施方式",
  "实施例1：真空度 0.1Pa，保温时间 8 小时（3 组平行测试均值）。",
  "D1（CN1234567A）保温时间 2 小时，本发明提升至 8 小时。",
].join("\n\n");
/** 实测 12 个唯一短语命中（changes=12）——用于证据条数上限。 */
const MANY_CHANGES_TEXT =
  "综上所述，此外，这是一个值得深思的问题，显而易见地，本领域技术人员能够理解，深入分析，全面论述，一体化，质的飞跃，保护范围合理，具有显著进步，创造性得以确立。";

test("buildSlopRevisionHint：未通过文本 → 证据提示（原始 label→建议替换），无评分断言", () => {
  const analysis = analyzeSlop(FAILING_TEXT);
  assert.ok(analysis.score.passed === false, "前置：样本应未通过 slop 门");
  const hint = buildSlopRevisionHint(analysis);
  assert.ok(hint, "应产出 hint");
  assert.match(hint, /命中套话表述/);
  assert.match(hint, /→/);
  assertNoScoreAssertion(hint);
});

test("buildSlopRevisionHint：干净文本 → 无证据 → undefined（调用方不注入）", () => {
  const analysis = analyzeSlop(CLEAN_TEXT);
  assert.ok(analysis.score.passed === true, "前置：样本应通过 slop 门");
  const hint = buildSlopRevisionHint(analysis);
  assert.equal(hint, undefined);
});

test("buildSlopRevisionHint：结构性问题也进证据（行号定位），仍无评分断言", () => {
  const analysis = analyzeSlop(FAILING_TEXT);
  const withIssues: SlopAnalysis = {
    ...analysis,
    issues: [
      {
        type: "reason_pile",
        line: 1,
        text: "全文含 5 条理由",
        suggestion: "主理由至多 2 条，其余删除或并入脚注",
      },
    ],
  };
  const hint = buildSlopRevisionHint(withIssues);
  assert.ok(hint, "有 issue 时应产出");
  assert.match(hint, /结构性问题/);
  assert.match(hint, /L1 行/);
  assertNoScoreAssertion(hint);
});

test("buildSlopRevisionHint：证据条数受限（防提示过长）", () => {
  const analysis = analyzeSlop(MANY_CHANGES_TEXT);
  assert.ok(analysis.changes.length > 8, "前置：样本应命中 8 条以上短语");
  const hint = buildSlopRevisionHint(analysis) ?? "";
  const quoteCount = (hint.match(/·\s*"/g) ?? []).length;
  assert.ok(quoteCount <= 8, `evidence 条目应受限（实际 ${quoteCount}）`);
  assertNoScoreAssertion(hint);
});
