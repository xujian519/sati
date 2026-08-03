import assert from "node:assert/strict";
import test from "node:test";
import { createArxivConnector } from "../../../src/literature/runtime/connectors/arxiv.js";
import { createCrossrefConnector } from "../../../src/literature/runtime/connectors/crossref.js";
import { createOpenAlexConnector } from "../../../src/literature/runtime/connectors/openalex.js";
import { createSemanticScholarConnector } from "../../../src/literature/runtime/connectors/semanticScholar.js";
import { ConnectorRegistry } from "../../../src/literature/runtime/ConnectorRegistry.js";
import { createPaperListSourcesTool } from "../../../src/literature/tool/paperListSources.js";
import { createPaperSearchTool } from "../../../src/literature/tool/paperSearch.js";

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T00:00:00Z</published>
    <title>Attention Is All You Need</title>
    <summary>The dominant sequence transduction models are based on complex recurrent networks.</summary>
    <author><name>Ashish Vaswani</name></author>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
  </entry>
</feed>`;

const context = { env: {}, cwd: "/", projectRoot: "/", abortSignal: undefined } as any;

/** 测试注入：跳过 arXiv/S2 的 per-host 限速与重试退避，避免用例拖慢。 */
function makeRegistry(fetchImpl: typeof fetch): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createArxivConnector({ fetchImpl, rateLimit: { minIntervalMs: 0 }, retry: { maxRetries: 0 } }));
  registry.register(createOpenAlexConnector({ fetchImpl }));
  registry.register(
    createSemanticScholarConnector({ fetchImpl, rateLimit: { minIntervalMs: 0 }, retry: { maxRetries: 0 } }),
  );
  registry.register(createCrossrefConnector({ fetchImpl }));
  return registry;
}

function makeSearchTool(fetchImpl: typeof fetch) {
  return createPaperSearchTool({ registry: makeRegistry(fetchImpl) });
}

function makeListTool(fetchImpl: typeof fetch) {
  return createPaperListSourcesTool({ registry: makeRegistry(fetchImpl) });
}

test("paper_search returns an unknown-db error with available sources", async () => {
  const tool = makeSearchTool(async () => new Response("", { status: 200 }));
  await assert.rejects(
    tool.execute({ db: "nope", query: "anything" }, context),
    err =>
      err instanceof Error &&
      (err as { code?: string }).code === "invalid_tool_input" &&
      /Available: arxiv, openalex, semantic-scholar, crossref/.test(err.message),
  );
});

test("paper_search surfaces rate-limit source errors with actionable guidance", async () => {
  const tool = makeSearchTool(async () => new Response("rate limited", { status: 429 }));
  await assert.rejects(
    tool.execute({ db: "arxiv", query: "attention" }, context),
    err =>
      err instanceof Error &&
      (err as { code?: string }).code === "tool_execution_failed" &&
      /rate limiting/i.test(err.message) &&
      /arXiv allows ~1 request every 3s/.test(err.message),
  );
});

test("paper_search returns empty result for genuine zero hits (not an error)", async () => {
  const tool = makeSearchTool(
    async () =>
      new Response(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>none</title></feed>`, {
        status: 200,
      }),
  );
  const result = await tool.execute({ db: "arxiv", query: "zzzz nonexistent" }, context);
  assert.equal(result.metadata?.count, 0);
  assert.ok(result.content[0].type === "text" && /No results/.test(result.content[0].text));
});

test("paper_search renders hits with pdf links", async () => {
  const tool = makeSearchTool(async () => new Response(ATOM_FEED, { status: 200 }));
  const result = await tool.execute({ db: "arxiv", query: "attention is all you need" }, context);

  assert.equal(result.metadata?.count, 1);
  assert.equal(result.metadata?.db, "arxiv");
  const text = result.content[0].type === "text" ? result.content[0].text : "";
  assert.ok(text.includes("## Attention Is All You Need"));
  assert.ok(text.includes("**id**: 1706.03762v7"));
  assert.ok(text.includes("**pdf**: http://arxiv.org/pdf/1706.03762v7"));
  assert.ok(text.includes("**url**: http://arxiv.org/abs/1706.03762v7"));
  assert.equal((result.data as { hits: unknown[] }).hits.length, 1);
});

test("paper_search clamps limit to 50", async () => {
  let url = "";
  const tool = makeSearchTool(async (input: RequestInfo | URL) => {
    url = String(input);
    return new Response(ATOM_FEED, { status: 200 });
  });
  await tool.execute({ db: "arxiv", query: "attention", limit: 999 }, context);
  assert.ok(url.includes("max_results=50"));
});

test("paper_list_sources lists all free literature sources", async () => {
  const tool = makeListTool(async () => new Response("", { status: 200 }));
  const result = await tool.execute({}, context);

  assert.equal(result.metadata?.count, 4);
  const text = result.content[0].type === "text" ? result.content[0].text : "";
  for (const id of ["arxiv", "openalex", "semantic-scholar", "crossref"]) {
    assert.ok(text.includes(`**${id}**`), `expected ${id} in ${text}`);
  }
});

test("paper_list_sources filters by domain", async () => {
  const tool = makeListTool(async () => new Response("", { status: 200 }));
  const result = await tool.execute({ domain: "literature" }, context);
  assert.equal(result.metadata?.count, 4);

  const empty = await tool.execute({ domain: "chemistry" }, context);
  assert.equal(empty.metadata?.count, 0);
});
