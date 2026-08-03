import assert from "node:assert/strict";
import test from "node:test";
import { createCrossrefConnector } from "../../../../src/literature/runtime/connectors/crossref.js";

const SEARCH_RESPONSE = {
  message: {
    "total-results": 1,
    items: [
      {
        DOI: "10.48550/arXiv.1706.03762",
        title: ["Attention Is All You Need"],
        subtitle: ["Transformer"],
        abstract: "<jats:p>The dominant sequence transduction models are based on complex recurrent networks.</jats:p>",
        author: [{ given: "Ashish", family: "Vaswani" }, { name: "Noam Shazeer" }],
        "container-title": ["Advances in Neural Information Processing Systems"],
        issued: { "date-parts": [[2017]] },
        score: 12.5,
        URL: "https://doi.org/10.48550/arXiv.1706.03762",
      },
    ],
  },
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

test("crossref strips JATS abstract and normalizes hits", async () => {
  const connector = createCrossrefConnector({
    fetchImpl: async () => jsonResponse(SEARCH_RESPONSE),
  });

  const hits = await connector.search("attention is all you need");

  assert.equal(hits.length, 1);
  const hit = hits[0];
  assert.equal(hit.id, "10.48550/arXiv.1706.03762");
  assert.equal(hit.title, "Attention Is All You Need: Transformer");
  assert.equal(hit.summary, "The dominant sequence transduction models are based on complex recurrent networks.");
  assert.equal(hit.score, 12.5);
  assert.equal(hit.url, "https://doi.org/10.48550/arXiv.1706.03762");
});

test("crossref appends mailto and select projection", async () => {
  let url = "";
  const connector = createCrossrefConnector({
    fetchImpl: async (input: RequestInfo | URL) => {
      url = String(input);
      return jsonResponse({ message: { items: [] } });
    },
  });

  await connector.search("transformer", { limit: 3 });
  assert.ok(url.includes("rows=3"));
  assert.ok(url.includes("mailto=sati@users.noreply.github.com"));
  assert.ok(url.includes("select=DOI,title"));
});
