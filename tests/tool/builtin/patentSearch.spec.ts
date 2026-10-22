/**
 * 测试: patent_search 内置工具 + nuo searchProvider
 * 通过 creator 注入 mock search 函数，避免网络请求。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PatentSearchResult } from "nuo-patent";
import { createPatentSearchTool } from "../../../src/tool/builtin/patentSearch.js";
import { createNuoSearchProvider } from "../../../src/patent/data/nuo/searchProvider.js";
import { SatiToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const context = { env: {}, cwd: "/", projectRoot: "/", abortSignal: undefined } as unknown as SatiToolRuntimeContext;

function makeSearchResult(overrides: Partial<PatentSearchResult> = {}): PatentSearchResult {
  return {
    query: "thermal",
    total: 1,
    hits: [
      {
        patent: "US11452699B2",
        title: "Thermal management system",
        assignee: "Apple Inc.",
        publication_date: "2022-09-27",
        priority_date: "2019-12-31",
        abstract: "A thermal management system.",
        url: "https://patents.google.com/patent/US11452699B2",
      },
    ],
    warnings: [],
    ...overrides,
  };
}

describe("patent_search 工具", () => {
  it("检索命中返回结构化 hits", async () => {
    const tool = createPatentSearchTool({ search: async () => makeSearchResult() });
    const res = await tool.execute({ query: "thermal management" }, context);

    assert.equal(res.metadata?.count, 1);
    const data = res.data as { hits: Array<{ patent: string; publicationDate: string; assignee: string }> };
    assert.equal(data.hits[0].patent, "US11452699B2");
    assert.equal(data.hits[0].publicationDate, "2022-09-27");
    assert.equal(data.hits[0].assignee, "Apple Inc.");
  });

  it("空查询抛 invalid_tool_input（不调用 search）", async () => {
    let called = false;
    const tool = createPatentSearchTool({
      search: async () => {
        called = true;
        return makeSearchResult();
      },
    });
    await assert.rejects(
      tool.execute({ query: "   " }, context),
      err => err instanceof SatiToolRuntimeError && err.code === "invalid_tool_input",
    );
    assert.equal(called, false);
  });

  it("网络失败警告 → tool_execution_failed（与无结果区分）", async () => {
    const tool = createPatentSearchTool({
      search: async () => makeSearchResult({ hits: [], total: 0, warnings: ["检索失败: network down"] }),
    });
    await assert.rejects(
      tool.execute({ query: "thermal" }, context),
      err => err instanceof SatiToolRuntimeError && err.code === "tool_execution_failed",
    );
  });

  it("超时警告 → tool_timeout", async () => {
    const tool = createPatentSearchTool({
      search: async () => makeSearchResult({ hits: [], total: 0, warnings: ["检索超时 (30000ms)"] }),
    });
    await assert.rejects(
      tool.execute({ query: "thermal" }, context),
      err => err instanceof SatiToolRuntimeError && err.code === "tool_timeout",
    );
  });

  it("真实零结果（total=0 且无解析警告）作为数据返回", async () => {
    const tool = createPatentSearchTool({
      search: async () =>
        makeSearchResult({ hits: [], total: 0, warnings: ["检索式无命中（Google Patents total=0）"] }),
    });
    const res = await tool.execute({ query: "zzz nonexistent" }, context);
    assert.equal(res.metadata?.count, 0);
    assert.equal((res.data as { hits: unknown[] }).hits.length, 0);
    // 注入实现未声明来源：明确标 unknown，不伪装成真实检索成功。
    assert.equal((res.data as { dataSource: string }).dataSource, "unknown");
    assert.deepEqual((res.data as { cache: { hit: boolean } }).cache, { hit: false });
  });

  it("PARSE_ERROR → tool_execution_failed（不被当成 0 命中）", async () => {
    const tool = createPatentSearchTool({
      search: async () =>
        makeSearchResult({ hits: [], total: 0, warnings: ["PARSE_ERROR: XHR JSON 缺少 results 信封"] }),
    });
    await assert.rejects(
      tool.execute({ query: "thermal" }, context),
      err =>
        err instanceof SatiToolRuntimeError && err.code === "tool_execution_failed" && /PARSE_ERROR/.test(err.message),
    );
  });

  it("透出 dataSource 与 cache 元数据", async () => {
    const tool = createPatentSearchTool({
      search: async () => ({
        ...makeSearchResult(),
        dataSource: "ego-json" as const,
        cache: { hit: true, ageMs: 1234 },
      }),
    });
    const res = await tool.execute({ query: "thermal" }, context);
    const data = res.data as { dataSource: string; cache: { hit: boolean; ageMs?: number } };
    assert.equal(data.dataSource, "ego-json");
    assert.equal(data.cache.hit, true);
    assert.equal(data.cache.ageMs, 1234);
    assert.equal(res.metadata?.dataSource, "ego-json");
    assert.equal(res.metadata?.cacheHit, true);
    assert.equal(res.metadata?.cacheAgeMs, 1234);
  });
});

describe("createNuoSearchProvider（StageProvider.search 适配）", () => {
  it("把检索命中映射为 { title, snippet, url }", async () => {
    const provider = createNuoSearchProvider({ search: async () => makeSearchResult() });
    const docs = await provider.search!("thermal", { maxResults: 5 });

    assert.equal(docs.length, 1);
    assert.equal(docs[0].title, "Thermal management system");
    assert.equal(docs[0].snippet, "A thermal management system.");
    assert.equal(docs[0].url, "https://patents.google.com/patent/US11452699B2");
  });

  it("无标题命中回退为专利号", async () => {
    const provider = createNuoSearchProvider({
      search: async () =>
        makeSearchResult({
          hits: [
            {
              patent: "US11452699B2",
              title: "",
              assignee: "",
              publication_date: "",
              priority_date: "",
              abstract: "",
              url: "u",
            },
          ],
        }),
    });
    const docs = await provider.search!("x");
    assert.equal(docs[0].title, "US11452699B2");
  });
});
