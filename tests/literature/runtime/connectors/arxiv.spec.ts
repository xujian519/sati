import assert from "node:assert/strict";
import test from "node:test";
import { createArxivConnector } from "../../../../src/literature/runtime/connectors/arxiv.js";
import type { Connector } from "../../../../src/literature/protocol/types.js";

/** 测试注入：跳过 arXiv 3s per-host 限速，避免用例拖慢。 */
function makeConnector(fetchImpl: typeof fetch): Connector {
  return createArxivConnector({ fetchImpl, rateLimit: { minIntervalMs: 0 } });
}

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query: all:attention</title>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-07-19T15:24:00Z</updated>
    <published>2017-06-12T00:00:00Z</published>
    <title>Attention Is All You Need</title>
    <summary>The dominant sequence transduction models are based on complex recurrent networks.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2001.00001v1</id>
    <published>2020-01-01T00:00:00Z</published>
    <title>Second Paper</title>
    <author><name>Jane Doe</name></author>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.AI"/>
    <link title="pdf" href="http://arxiv.org/pdf/2001.00001v1" rel="related" type="application/pdf"/>
  </entry>
</feed>`;

const ERROR_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/api/errors#malformed</id>
    <title>Error</title>
    <summary>Query can not be processed.</summary>
  </entry>
</feed>`;

const EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query: all:zzzz</title>
</feed>`;

function atomResponse(xml: string, status = 200): Response {
  return new Response(xml, { status, headers: { "content-type": "application/atom+xml" } });
}

test("arxiv parses Atom feed into normalized hits with pdf links", async () => {
  let url = "";
  const connector = makeConnector(async (input: RequestInfo | URL) => {
    url = String(input);
    return atomResponse(ATOM_FEED);
  });

  const hits = await connector.search("attention is all you need", { limit: 10 });

  assert.equal(hits.length, 2);
  const first = hits[0];
  assert.equal(first.id, "1706.03762v7");
  assert.equal(first.title, "Attention Is All You Need");
  assert.equal(first.url, "http://arxiv.org/abs/1706.03762v7");
  assert.equal(first.extra?.pdf, "http://arxiv.org/pdf/1706.03762v7");
  assert.ok(first.summary?.includes("dominant sequence"));
  assert.ok(url.includes("search_query=all%3Aattention%20is%20all%20you%20need"));
  assert.ok(url.includes("max_results=10"));
});

test("arxiv wraps bare queries in all: but passes fielded queries through", async () => {
  const urls: string[] = [];
  const connector = makeConnector(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return atomResponse(EMPTY_FEED);
  });

  await connector.search("ti:transformer AND cat:cs.LG");
  assert.ok(urls[0].includes("search_query=ti%3Atransformer%20AND%20cat%3Acs.LG"));
  assert.ok(!urls[0].includes("all%3A"));

  await connector.search("quantum computing");
  assert.ok(urls[1].includes("search_query=all%3Aquantum%20computing"));
});

test("arxiv clamps limit to 50", async () => {
  let url = "";
  const connector = makeConnector(async (input: RequestInfo | URL) => {
    url = String(input);
    return atomResponse(EMPTY_FEED);
  });

  await connector.search("anything", { limit: 100 });
  assert.ok(url.includes("max_results=50"));
});

test("arxiv treats 200 + Error entry as an error, not a hit", async () => {
  const connector = makeConnector(async () => atomResponse(ERROR_FEED));
  await assert.rejects(connector.search("malformed query"), /arXiv rejected the query/);
});

test("arxiv rejects non-Atom bodies as source errors", async () => {
  const connector = makeConnector(async () => new Response("<html>rate limited</html>", { status: 200 }));
  await assert.rejects(connector.search("anything"), /non-Atom response/);
});

test("arxiv search with zero results returns empty array", async () => {
  const connector = makeConnector(async () => atomResponse(EMPTY_FEED));
  const hits = await connector.search("zzzz nonexistent");
  assert.deepEqual(hits, []);
});

test("arxiv fetch resolves a bare id via id_list", async () => {
  let url = "";
  const connector = makeConnector(async (input: RequestInfo | URL) => {
    url = String(input);
    return atomResponse(ATOM_FEED);
  });
  const record = await connector.fetch!("1706.03762");
  assert.ok((record as { id: string }).id.includes("1706.03762"));
  assert.ok(url.includes("id_list=1706.03762&max_results=1"));
});
