import assert from "node:assert/strict";
import test from "node:test";
import { PATENT_WIKI_DIRS, createPatentWikiSearchTool } from "../../../src/tool/builtin/patentWikiSearch.js";
import { makeToolContext } from "../context-fixture.js";

test("patent_wiki_search: 目录映射正确", () => {
  assert.equal(PATENT_WIKI_DIRS.specification, "专利实务/说明书");
  assert.equal(PATENT_WIKI_DIRS.claims, "专利实务/权利要求");
  assert.equal(PATENT_WIKI_DIRS.drafting, "专利实务/撰写");
  assert.equal(PATENT_WIKI_DIRS.figures, "专利实务/附图");
});

test("patent_wiki_search: 工具只读且可用", async () => {
  const tool = createPatentWikiSearchTool();
  assert.equal(tool.name, "patent_wiki_search");
  assert.equal(tool.isReadOnly({ query: "x" }), true);
  const availability = (await tool.checkAvailability?.({} as never)) as { ok: boolean } | undefined;
  assert.ok(availability?.ok, "内置 wiki 目录应可用");
});

test("patent_wiki_search: specification 目录检索充分公开卡片", async () => {
  const tool = createPatentWikiSearchTool();
  const result = await tool.execute({ query: "充分公开", dir: "specification", limit: 5 }, makeToolContext());
  const first = result.content[0];
  assert.equal(first?.type, "json");
  if (first?.type !== "json") assert.fail("expected json content");
  const output = first.value as { total: number; results: Array<{ id: string; title: string }> };
  assert.ok(output.total > 0, "说明书目录应检索到充分公开卡片");
  for (const card of output.results) {
    assert.ok(card.id.startsWith("专利实务/说明书/"), `卡片 ${card.id} 应位于说明书目录`);
  }
});

test("patent_wiki_search: 附图目录列出说明书附图规范", async () => {
  const tool = createPatentWikiSearchTool();
  const result = await tool.execute({ query: "", dir: "figures", limit: 20 }, makeToolContext());
  const first = result.content[0];
  if (first?.type !== "json") assert.fail("expected json content");
  const output = first.value as { results: Array<{ id: string }> };
  assert.ok(
    output.results.some(c => c.id.includes("说明书附图规范")),
    "附图目录应含说明书附图规范卡片",
  );
});

test("patent_wiki_search: include_body 附带正文片段", async () => {
  const tool = createPatentWikiSearchTool();
  const result = await tool.execute(
    { query: "实施例", dir: "specification", limit: 2, include_body: true },
    makeToolContext(),
  );
  const first = result.content[0];
  if (first?.type !== "json") assert.fail("expected json content");
  const output = first.value as { results: Array<{ body?: string }> };
  assert.ok(output.results.length > 0);
  assert.ok(output.results[0]?.body, "include_body 时应返回正文片段");
});
