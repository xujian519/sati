import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildClosestPrompt,
  buildCombinationPrompt,
  buildConcludePrompt,
  buildDiffPrompt,
  buildHintPrompt,
  buildParsePrompt,
  buildQueryPrompt,
  buildRecallPrompt,
  buildSecondaryPrompt,
} from "../../../src/patent/graph/domains/inventiveness-prompts.js";

/**
 * 创造性子图提示词快照（#725 / W-07）。
 *
 * 拆分要求提示词逐字不变；这里用固定输入的 sha256 锁定全文（避免逐字长文断言
 * 难以审阅）。摘要变化 = 提示词文本变了，必须确认是预期修改并重录快照。
 */

const PARSE = JSON.stringify({ features: ["A", "B"], field: "机械", inventor_claimed_effect: "减重" });
const CUTOFF_DATE = "2024-05-01";
const CUTOFF_BASIS = "priority";
const PRIOR_ART_TEXT = JSON.stringify({ doc: "D1", publication_date: "2023-01-01" });
const DOMAIN_FOCUS = "【领域创造性审查要点（IPC F）】\n机械领域提示";
const CLOSEST = JSON.stringify({ document: "D1" });
const DIFF = JSON.stringify({ distinguishing_features: ["C"], actual_technical_problem: "如何减重" });
const COMBINATION = JSON.stringify({ combinable: true, motivation: "公知常识" });
const HINT = JSON.stringify({ obvious: false, motivation: "无启示" });
const SECONDARY = JSON.stringify({ unexpected_effect: "减重30%" });
const FEEDBACK_HISTORY = "【反馈】上一轮：补充对比文件";

const SNAPSHOTS: Readonly<Record<string, string>> = {
  parse: "b13b0a684625f0c2c0e31430b4fc48b654f556cd3fd02199f3de21e2ddd8c250",
  query: "e39050c8cca665aa79c8dbf4bb677a7639d40c294b450c1bd016686cd287d1e1",
  recall: "96856bb7ff73264c063fb169c61b46c47d92c3d08f5a3a7a348fb54d9d242de9",
  closest: "579c00a8919be1c9a7923079bb638872ba5f1cd156309863f5b7e6321ae4e293",
  diff: "426ca1596a4063cd0345bce986be29dff33e6a969bd0a037b26062369b72c63c",
  combination: "2d10dd3d94971fadc865104c69d4146cab0fc7dcbbad636fc13ef0dd54b76cdf",
  hint: "a003a7b84d0aca174db362e8f6a64f58c6409d35b9b6d520de6b78fc18e42d99",
  secondary: "41507d759b718cbc22ee58f9e7c87845c53b405d0f31535024026a1b70b30cf5",
  conclude: "30d26e29bf8607902b6ce51908aa8a3767d10ac125ba3b0594db39ad2888d567",
};

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

test("创造性子图提示词快照（拆分前后逐字一致）", () => {
  const prompts: Readonly<Record<string, string>> = {
    parse: buildParsePrompt("一种减重装置，其特征在于……"),
    query: buildQueryPrompt({ parse: PARSE, cutoffDate: CUTOFF_DATE, cutoffBasis: CUTOFF_BASIS }),
    recall: buildRecallPrompt({ parse: PARSE, priorArtText: PRIOR_ART_TEXT }),
    closest: buildClosestPrompt({ parse: PARSE, domainFocus: DOMAIN_FOCUS, priorArtText: PRIOR_ART_TEXT }),
    diff: buildDiffPrompt({ parse: PARSE, domainFocus: DOMAIN_FOCUS, closest: CLOSEST }),
    combination: buildCombinationPrompt({ closest: CLOSEST, diff: DIFF, priorArtText: PRIOR_ART_TEXT }),
    hint: buildHintPrompt({ parse: PARSE, domainFocus: DOMAIN_FOCUS, diff: DIFF, combination: COMBINATION }),
    secondary: buildSecondaryPrompt(PARSE),
    conclude: buildConcludePrompt({
      parse: PARSE,
      closest: CLOSEST,
      diff: DIFF,
      combination: COMBINATION,
      hint: HINT,
      secondary: SECONDARY,
      feedbackHistory: FEEDBACK_HISTORY,
    }),
  };
  for (const [name, expected] of Object.entries(SNAPSHOTS)) {
    assert.equal(digest(prompts[name]!), expected, `${name} prompt 文本已变更；确认预期后更新快照`);
  }
});

test("时间基准缺失与领域要点缺省时走降级分支（不含日期限定/空段）", () => {
  const query = buildQueryPrompt({ parse: PARSE, cutoffDate: "", cutoffBasis: "" });
  assert.match(query, /时间基准未确定/);
  assert.doesNotMatch(query, /after:\d{8}/);
  assert.ok(!buildDiffPrompt({ parse: PARSE, domainFocus: "", closest: CLOSEST }).includes("领域创造性审查要点"));
});
