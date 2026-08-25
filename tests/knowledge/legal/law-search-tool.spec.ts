import assert from "node:assert/strict";
import test from "node:test";
import { createLawSearchTool } from "../../../src/knowledge/legal/law-search-tool.js";
import type { LawCategory, LawRecord, LawSearchResult, LegalSearchSource } from "../../../src/knowledge/legal/types.js";
import type { LawVersionMeta } from "../../../src/knowledge/legal/version-meta.js";
import { makeToolContext } from "../../tool/context-fixture.js";

/**
 * law_search 工具版本合并逻辑测试（F5 补测：版本合并/标注/limit 配额/已废止派生）。
 *
 * mock LegalSearchSource 固定 findByName/search 返回，隔离 DB 层；meta 经
 * createLawSearchTool 第二参数注入（默认参数会读 ~/.sati/ 真实 meta，测试必须
 * 显式传空 map 保证确定性）。
 */

function rec(name: string, publish: string | undefined, expired = 0, level = "法律"): LawRecord {
  return {
    id: `${name}_${publish ?? "unknown"}`,
    level,
    name,
    publish,
    expired,
    categoryId: 0,
    content: `${name} 全文内容`,
  };
}

class FakeEngine implements LegalSearchSource {
  readonly ftsAvailable = true;
  constructor(
    private readonly searchResult: LawRecord[],
    private readonly byNameResult: LawRecord[],
  ) {}

  search(): LawSearchResult[] {
    return this.searchResult.map(r => ({ ...r, score: 0 }));
  }

  findByName(): LawRecord[] {
    return this.byNameResult;
  }

  getById(): LawRecord | undefined {
    return undefined;
  }

  getByIds(): LawRecord[] {
    return [];
  }

  getCategories(): LawCategory[] {
    return [];
  }

  count(): number {
    return this.searchResult.length + this.byNameResult.length;
  }

  close(): void {}
}

function emptyMeta(): Map<string, LawVersionMeta> {
  return new Map();
}

test("law_search: 同名多版本不挤占不同法律（名称配额 ≤ limit）", async () => {
  const byName = [
    rec("专利法实施细则", "2023-12-11"),
    rec("中华人民共和国专利法", "2020-10-17"),
    rec("专利法实施细则", "2010-02-01"),
  ];
  const search = [rec("中华人民共和国商标法", "2020-08-30"), rec("中华人民共和国著作权法", "2020-11-11")];
  const tool = createLawSearchTool(() => ({ engine: new FakeEngine(search, byName), dbPath: "fake" }), emptyMeta);
  const result = await tool.execute({ query: "专利法", limit: 3 }, makeToolContext());
  assert.ok(result.data);
  const { results } = result.data;
  // 不同法律数 ≤ limit=3：细则（2 行）+ 专利法（1 行）+ 商标法（1 行）
  const names = [...new Set(results.map(r => r.name))];
  assert.deepEqual(names, ["专利法实施细则", "中华人民共和国专利法", "中华人民共和国商标法"]);
  assert.equal(results.length, 4, "同名多版本全部展示但只占 1 个名称配额");
  // 版本标注：最新版现行有效、旧版已被修订 + supersededBy
  const latest = results.find(r => r.publish === "2023-12-11")!;
  const old = results.find(r => r.publish === "2010-02-01")!;
  assert.equal(latest.status, "现行有效");
  assert.equal(old.status, "已被修订");
  assert.equal(old.supersededBy, "专利法实施细则（2023-12-11 版）");
  // 单版本命中不标 status（避免噪音）
  const patentLaw = results.find(r => r.name === "中华人民共和国专利法")!;
  assert.equal(patentLaw.status, undefined);
});

test("law_search: 单版本非过期法不标 status", async () => {
  const tool = createLawSearchTool(
    () => ({ engine: new FakeEngine([], [rec("中华人民共和国专利法", "2020-10-17")]), dbPath: "fake" }),
    emptyMeta,
  );
  const result = await tool.execute({ query: "专利法" }, makeToolContext());
  assert.ok(result.data);
  assert.equal(result.data.results.length, 1);
  assert.equal(result.data.results[0]!.status, undefined);
});

test("law_search: 命中已失效法（expired=1）标已废止——单版本也标注", async () => {
  const byName = [rec("外资企业法实施细则", "1990-12-12", 1)];
  const tool = createLawSearchTool(() => ({ engine: new FakeEngine([], byName), dbPath: "fake" }), emptyMeta);
  const result = await tool.execute({ query: "外资企业法" }, makeToolContext());
  assert.ok(result.data);
  assert.equal(result.data.results[0]!.status, "已废止");
});

test("law_search: 全文检索命中过期法时同样补已废止标注", async () => {
  const search = [rec("外资企业法实施细则", "1990-12-12", 1)];
  const tool = createLawSearchTool(() => ({ engine: new FakeEngine(search, []), dbPath: "fake" }), emptyMeta);
  const result = await tool.execute({ query: "外资企业法" }, makeToolContext());
  assert.ok(result.data);
  assert.equal(result.data.results[0]!.status, "已废止");
});

test("law_search: 离线 meta 权威覆盖（已废止）优先于 expired/位置判定", async () => {
  const meta = new Map<string, LawVersionMeta>();
  meta.set("中华人民共和国专利法", {
    name: "中华人民共和国专利法",
    status: "已废止",
    promulgatedDate: "2020-10-17",
    events: [],
  });
  const byName = [rec("中华人民共和国专利法", "2020-10-17"), rec("中华人民共和国专利法", "2008-12-27")];
  const tool = createLawSearchTool(
    () => ({ engine: new FakeEngine([], byName), dbPath: "fake" }),
    () => meta,
  );
  const result = await tool.execute({ query: "专利法" }, makeToolContext());
  assert.ok(result.data);
  for (const r of result.data.results) {
    assert.equal(r.status, "已废止", "meta 已废止应覆盖位置标注");
  }
});

test("law_search: limit 封顶为 20 且名称配额不超限", async () => {
  const byName = Array.from({ length: 5 }, (_, i) => rec(`法规${i}`, `2020-01-0${i}`));
  const search = Array.from({ length: 5 }, (_, i) => rec(`检索法${i}`, `2021-01-0${i}`));
  const tool = createLawSearchTool(() => ({ engine: new FakeEngine(search, byName), dbPath: "fake" }), emptyMeta);
  const result = await tool.execute({ query: "法规", limit: 3 }, makeToolContext());
  assert.ok(result.data);
  assert.ok(result.data.results.length >= 3);
  assert.ok(result.data.results.length <= 20);
});
