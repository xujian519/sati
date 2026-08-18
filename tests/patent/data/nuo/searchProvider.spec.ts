import assert from "node:assert/strict";
import test from "node:test";
import { createNuoSearchProvider } from "../../../../src/patent/data/nuo/searchProvider.js";

/** 构造 nuo-patent 形状的检索命中。 */
function hit(
  overrides: Partial<{
    patent: string;
    title: string;
    assignee: string;
    publication_date: string;
    priority_date: string;
    abstract: string;
    url: string;
  }> = {},
) {
  return {
    patent: "CN1234567A",
    title: "示例专利",
    assignee: "示例公司",
    publication_date: "",
    priority_date: "",
    abstract: "摘要",
    url: "https://patents.google.com/patent/CN1234567A",
    ...overrides,
  };
}

test("searchProvider: 公开日映射进检索命中（publication_date 透传）", async () => {
  const provider = createNuoSearchProvider({
    search: async () => ({
      query: "q",
      total: 2,
      warnings: [],
      hits: [
        hit({ patent: "CN1", publication_date: "2020-02-21", priority_date: "2019-01-01" }),
        hit({ patent: "CN2" }), // 无公开日（旧数据）
      ],
    }),
  });
  const docs = await provider.search!("散热器", { maxResults: 5 });
  assert.equal(docs.length, 2);
  assert.equal(docs[0]!.publication_date, "2020-02-21");
  // 空公开日映射为 undefined，保持旧 provider 形状（向后兼容，不出现空串噪音）。
  assert.equal(docs[1]!.publication_date, undefined);
  assert.equal(docs[1]!.title, "示例专利");
  assert.equal(docs[1]!.snippet, "摘要");
  assert.equal(docs[1]!.url, "https://patents.google.com/patent/CN1234567A");
});

test("searchProvider: 无公开日字段的旧命中不报错、不降级", async () => {
  const provider = createNuoSearchProvider({
    search: async () => ({
      query: "q",
      total: 1,
      warnings: [],
      hits: [
        { patent: "US1", title: "Old", assignee: "", publication_date: "", priority_date: "", abstract: "a", url: "u" },
      ],
    }),
  });
  const docs = await provider.search!("old query");
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.publication_date, undefined);
});
