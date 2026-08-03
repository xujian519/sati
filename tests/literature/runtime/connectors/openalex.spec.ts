import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAlexConnector } from "../../../../src/literature/runtime/connectors/openalex.js";

const SEARCH_RESPONSE = {
  meta: { count: 1 },
  results: [
    {
      id: "https://openalex.org/W2741809807",
      doi: "https://doi.org/10.48550/arXiv.1706.03762",
      display_name: "Attention Is All You Need",
      publication_year: 2017,
      cited_by_count: 120000,
      relevance_score: 0.95,
      abstract_inverted_index: { Attention: [0], Is: [1], All: [2], You: [3], Need: [4] },
      authorships: [{ author: { display_name: "Ashish Vaswani" } }],
      primary_location: {
        source: { display_name: "arXiv" },
        landing_page_url: "https://arxiv.org/abs/1706.03762",
      },
    },
  ],
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

test("openalex rebuilds abstracts from inverted index and normalizes hits", async () => {
  const connector = createOpenAlexConnector({
    fetchImpl: async () => jsonResponse(SEARCH_RESPONSE),
  });

  const hits = await connector.search("attention is all you need", { limit: 5 });

  assert.equal(hits.length, 1);
  const hit = hits[0];
  assert.equal(hit.id, "W2741809807");
  assert.equal(hit.title, "Attention Is All You Need");
  assert.equal(hit.summary, "Attention Is All You Need");
  assert.equal(hit.score, 0.95);
  assert.equal(hit.url, "https://openalex.org/W2741809807");
});

test("openalex adds mailto polite-pool param", async () => {
  let url = "";
  const connector = createOpenAlexConnector({
    mailto: "researcher@example.com",
    fetchImpl: async (input: RequestInfo | URL) => {
      url = String(input);
      return jsonResponse({ results: [] });
    },
  });

  await connector.search("transformer");
  assert.ok(url.includes("mailto=researcher%40example.com"));
  assert.ok(url.includes("per-page=10"));
});

test("openalex falls back to OPENALEX_MAILTO env when option absent", async () => {
  const previous = process.env.OPENALEX_MAILTO;
  process.env.OPENALEX_MAILTO = "env@example.com";
  try {
    let url = "";
    const connector = createOpenAlexConnector({
      fetchImpl: async (input: RequestInfo | URL) => {
        url = String(input);
        return jsonResponse({ results: [] });
      },
    });
    await connector.search("attention");
    assert.ok(url.includes("mailto=env%40example.com"));
  } finally {
    if (previous === undefined) delete process.env.OPENALEX_MAILTO;
    else process.env.OPENALEX_MAILTO = previous;
  }
});

test("openalex fetch resolves a DOI as a raw path segment", async () => {
  let url = "";
  const connector = createOpenAlexConnector({
    fetchImpl: async (input: RequestInfo | URL) => {
      url = String(input);
      return jsonResponse(SEARCH_RESPONSE.results[0]);
    },
  });

  const record = await connector.fetch!("10.48550/arXiv.1706.03762");
  assert.ok((record as { id?: string }).id?.includes("W2741809807"));
  assert.ok(url.includes("/works/doi:10.48550/arXiv.1706.03762?"));
});
