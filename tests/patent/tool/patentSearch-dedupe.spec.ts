/**
 * TASK-P2-06 测试：搜索结果 family 去重（基号分桶）。
 *
 * - 同基号 A/B/C 变体仅保留 publicationDate 最新一篇，结果保持原顺序；
 * - 无日期视为最旧（有日期的变体胜出）；
 * - 不同基号 / 无 kind code 的号不参与分桶；
 * - warnings 追加 family 合并统计（原源警告保留）；
 * - 工具集成：mock search 注入 3 条 → output 仅 1 条 + warnings 含统计。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { PatentSearchHit } from "nuo-patent";
import { baseNumber, createPatentSearchTool, dedupeByFamily } from "../../../src/tool/builtin/patentSearch.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

function hit(patent: string, publicationDate: string): PatentSearchHit {
  return {
    patent,
    title: `Title ${patent}`,
    assignee: "ACME",
    publication_date: publicationDate,
    priority_date: "2020-01-01",
    abstract: "Abstract",
    url: `https://patents.google.com/patent/${patent}/en`,
  };
}

test("baseNumber：去掉 kind code 取基号", () => {
  assert.equal(baseNumber("CN115690481A"), "CN115690481");
  assert.equal(baseNumber("US11452699B2"), "US11452699");
  assert.equal(baseNumber("EP1234567A1"), "EP1234567");
  assert.equal(baseNumber("WO2023123456A1"), "WO2023123456");
  assert.equal(baseNumber("CN115690481"), undefined, "无 kind code 不参与分桶");
});

test("dedupeByFamily：同基号仅保留 publicationDate 最新一篇，保持原顺序", () => {
  const hits = [
    hit("CN115690481A", "2023-01-10"),
    hit("CN115690481B", "2024-05-20"),
    hit("CN115690481C", "2023-06-15"),
  ];

  const { hits: deduped, warnings } = dedupeByFamily(hits, []);

  assert.deepEqual(
    deduped.map(h => h.patent),
    ["CN115690481B"],
    "仅保留最新一篇",
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /CN115690481\* 的 3 篇.*合并为 1 篇.*CN115690481B 2024-05-20/);
});

test("dedupeByFamily：无日期的变体视为最旧，被有日期的胜出", () => {
  const hits = [hit("US11452699A", ""), hit("US11452699B2", "2023-03-01")];

  const { hits: deduped } = dedupeByFamily(hits, []);

  assert.deepEqual(
    deduped.map(h => h.patent),
    ["US11452699B2"],
  );
});

test("dedupeByFamily：不同基号与无 kind code 的号不受影响", () => {
  const hits = [
    hit("CN115690481A", "2023-01-10"),
    hit("CN115690481B", "2024-05-20"),
    hit("US11452699B2", "2023-03-01"),
    hit("CN115690482", "2023-02-01"),
  ];

  const { hits: deduped, warnings } = dedupeByFamily(hits, []);

  assert.deepEqual(
    deduped.map(h => h.patent),
    ["CN115690481B", "US11452699B2", "CN115690482"],
    "同基号合并，其余原样保留",
  );
  assert.equal(warnings.length, 1, "仅 CN115690481* 产生合并统计");
});

test("dedupeByFamily：源 warnings 保留，合并统计追加在其后", () => {
  const sourceWarning = "解析降级：部分命中缺少 abstract";

  const { hits, warnings } = dedupeByFamily(
    [hit("CN115690481A", "2023-01-10"), hit("CN115690481B", "2024-05-20")],
    [sourceWarning],
  );

  assert.equal(hits.length, 1);
  assert.deepEqual(warnings, [sourceWarning, warnings[1]]);
  assert.match(warnings[1] ?? "", /family 去重/);
});

function makeContext(): SatiToolRuntimeContext {
  return {
    cwd: "/tmp",
    env: process.env,
    abortSignal: new AbortController().signal,
    sessionId: "test-session",
  } as unknown as SatiToolRuntimeContext;
}

test("工具集成：mock search 3 条同基号 → 输出仅 1 条 + warnings 含统计", async () => {
  const hits = [
    hit("CN115690481A", "2023-01-10"),
    hit("CN115690481B", "2024-05-20"),
    hit("CN115690481C", "2023-06-15"),
  ];
  const tool = createPatentSearchTool({
    search: async () => ({ hits, warnings: [], total: hits.length, query: "phase change" }),
  });

  const result = await tool.execute({ query: "phase change" }, makeContext());
  const data = result.data as {
    hits: Array<{ patent: string }>;
    warnings: string[];
    total: number;
  };

  assert.equal(data.total, 3, "total 保留源计数（去重发生在展示层）");
  assert.deepEqual(
    data.hits.map(h => h.patent),
    ["CN115690481B"],
  );
  assert.ok(data.warnings.some(w => w.includes("family 去重")));
  const text = (result.content[0] as { text?: string }).text ?? "";
  assert.match(text, /1 result\(s\)/, "文本摘要按去重后数量展示");
});
