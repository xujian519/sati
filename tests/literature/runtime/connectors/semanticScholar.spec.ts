import assert from "node:assert/strict";
import test from "node:test";
import { createSemanticScholarConnector } from "../../../../src/literature/runtime/connectors/semanticScholar.js";
import type { Connector } from "../../../../src/literature/protocol/types.js";

/** 测试注入：跳过 keyless 1s per-host 限速，避免用例拖慢。 */
function makeConnector(fetchImpl: typeof fetch, options: { apiKey?: string } = {}): Connector {
  return createSemanticScholarConnector({ ...options, fetchImpl, rateLimit: { minIntervalMs: 0 } });
}

const SEARCH_RESPONSE = {
  total: 1,
  data: [
    {
      paperId: "204e3073870fae3d05bcbc2f6a8e263d9b72e776",
      title: "Attention Is All You Need",
      abstract: "The dominant sequence transduction models are based on complex recurrent networks.",
      url: "https://www.semanticscholar.org/paper/Attention-Is-All-You-Need-204e3073870fae3d05bcbc2f6a8e263d9b72e776",
      year: 2017,
      venue: "NeurIPS",
      citationCount: 120000,
      externalIds: { ArXiv: "1706.03762" },
      authors: [{ name: "Ashish Vaswani" }, { name: "Noam Shazeer" }],
    },
  ],
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

test("semantic scholar normalizes hits with citation score", async () => {
  const connector = makeConnector(async () => jsonResponse(SEARCH_RESPONSE));

  const hits = await connector.search("attention is all you need");

  assert.equal(hits.length, 1);
  const hit = hits[0];
  assert.equal(hit.id, "204e3073870fae3d05bcbc2f6a8e263d9b72e776");
  assert.equal(hit.title, "Attention Is All You Need");
  assert.equal(hit.score, 120000);
  assert.equal(hit.summary, "The dominant sequence transduction models are based on complex recurrent networks.");
});

test("semantic scholar sends no x-api-key header on keyless tier", async () => {
  let headers: Record<string, string> | undefined;
  const connector = makeConnector(async (_input, init) => {
    headers = (init?.headers ?? {}) as Record<string, string>;
    return jsonResponse({ data: [] });
  });

  await connector.search("attention");
  assert.equal(headers?.["x-api-key"], undefined);
});

test("semantic scholar sends x-api-key header when key configured", async () => {
  let headers: Record<string, string> | undefined;
  const connector = makeConnector(
    async (_input, init) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse({ data: [] });
    },
    { apiKey: "s2-test-key" },
  );

  await connector.search("transformer");
  assert.equal(headers?.["x-api-key"], "s2-test-key");
});
