import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorRegistry } from "../../../../src/literature/index.js";
import type { Connector, ConnectorHit } from "../../../../src/literature/index.js";
import {
  createMultiSourceSearchProvider,
  createNuoSearchProvider,
  createPaperSearchSource,
} from "../../../../src/patent/data/nuo/searchProvider.js";

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

const sourceDoc = (url: string, title: string) => ({ title, snippet: "s", url, publication_date: "2020-01-01" });

test("multiSource: 多源并行（两个源同时在飞，非串行）", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const barrier = new Promise<void>(resolve => setTimeout(resolve, 30));
  const makeSource = () => async (): Promise<Array<ReturnType<typeof sourceDoc>>> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await barrier;
    inFlight -= 1;
    return [sourceDoc("u", "t")];
  };
  const provider = createMultiSourceSearchProvider([makeSource(), makeSource()]);
  const docs = await provider.search!("q");
  assert.equal(docs.length, 1);
  // 串行实现下 maxInFlight 只会是 1；并行实现应达到 2。
  assert.equal(maxInFlight, 2);
});

test("multiSource: 按 url 去重（跨源重复命中只保留一条）", async () => {
  const a = async () => [sourceDoc("https://x/patent/1", "Patent A")];
  const b = async () => [sourceDoc("https://x/patent/1", "Patent A 重复"), sourceDoc("https://x/patent/2", "Patent B")];
  const provider = createMultiSourceSearchProvider([a, b]);
  const docs = await provider.search!("q", { maxResults: 10 });
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map(d => d.url).sort(), ["https://x/patent/1", "https://x/patent/2"]);
});

test("multiSource: 单源失败 fail-open（其他源结果保留）", async () => {
  const ok = async () => [sourceDoc("https://x/ok", "OK")];
  const failing = async () => {
    throw new Error("source down");
  };
  const provider = createMultiSourceSearchProvider([ok, failing]);
  const docs = await provider.search!("q");
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.title, "OK");
});

test("multiSource: maxResults 截断合并结果", async () => {
  const a = async () => [sourceDoc("https://x/1", "A1"), sourceDoc("https://x/2", "A2")];
  const b = async () => [sourceDoc("https://x/3", "B1"), sourceDoc("https://x/4", "B2")];
  const provider = createMultiSourceSearchProvider([a, b]);
  const docs = await provider.search!("q", { maxResults: 3 });
  assert.equal(docs.length, 3);
});

function mockConnector(id: string, hits: ConnectorHit[]): Connector {
  return {
    id,
    name: id,
    domain: "literature",
    description: "mock connector",
    search: async () => hits,
  };
}

test("paperSource: 并行检索全部 connector 并归一化命中形状", async () => {
  const registry = new ConnectorRegistry();
  registry.register(
    mockConnector("arxiv", [{ id: "a1", title: "Paper A", summary: "summary A", url: "https://arxiv.org/a1" }]),
  );
  registry.register(
    mockConnector("openalex", [{ id: "o1", title: "Paper O", summary: undefined, url: "https://openalex.org/o1" }]),
  );
  const source = createPaperSearchSource(registry);
  const docs = await source("检索策略：分拣 AND 传感器", { maxResults: 5 });
  assert.equal(docs.length, 2);
  assert.deepEqual(
    docs.map(d => ({ title: d.title, snippet: d.snippet, url: d.url })),
    [
      { title: "Paper A", snippet: "summary A", url: "https://arxiv.org/a1" },
      { title: "Paper O", snippet: "", url: "https://openalex.org/o1" },
    ],
  );
  assert.equal(docs[0]!.publication_date, undefined);
});

test("paperSource: 单 connector 失败 fail-open（其余源结果保留）", async () => {
  const registry = new ConnectorRegistry();
  registry.register(mockConnector("arxiv", [{ id: "a1", title: "Paper A", url: "https://arxiv.org/a1" }]));
  registry.register({
    id: "broken",
    name: "broken",
    domain: "literature",
    description: "broken",
    search: async () => {
      throw new Error("down");
    },
  });
  const source = createPaperSearchSource(registry);
  const docs = await source("q", { maxResults: 5 });
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.title, "Paper A");
});
