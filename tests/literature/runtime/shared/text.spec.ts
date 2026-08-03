import assert from "node:assert/strict";
import test from "node:test";
import { fromInverted, decodeEntities, snippet, stripTags } from "../../../../src/literature/runtime/shared/text.js";

test("decodeEntities decodes named, hex, and decimal entities", () => {
  assert.equal(decodeEntities("a &amp; b &lt; c &gt; d &quot;q&quot; &apos;e&apos;"), "a & b < c > d \"q\" 'e'");
  assert.equal(decodeEntities("&#x41;&#66;&#67;"), "ABC");
  assert.equal(decodeEntities("&#65;&#98;"), "Ab");
  assert.equal(decodeEntities("&nbsp;"), " ");
});

test("decodeEntities leaves unknown entities untouched", () => {
  assert.equal(decodeEntities("&unknown; &amp;"), "&unknown; &");
});

test("stripTags removes JATS tags and collapses whitespace", () => {
  assert.equal(stripTags("<jats:p>Attention is  all   you need</jats:p>"), "Attention is all you need");
  assert.equal(stripTags("<p>a &amp; b</p>"), "a & b");
  assert.equal(stripTags(undefined), undefined);
  assert.equal(stripTags("<p>  </p>"), undefined);
});

test("snippet truncates at word boundary with ellipsis", () => {
  const text = "word ".repeat(100).trim();
  const out = snippet(text, 50);
  assert.ok(out!.endsWith("…"));
  assert.ok(out!.length <= 54);
});

test("snippet returns short text unchanged and undefined for empty", () => {
  assert.equal(snippet("hello world"), "hello world");
  assert.equal(snippet(undefined), undefined);
  assert.equal(snippet("<b></b>"), undefined);
});

test("fromInverted rebuilds OpenAlex abstract from inverted index", () => {
  const index = { the: [0], quick: [1], brown: [2], fox: [3] };
  assert.equal(fromInverted(index), "the quick brown fox");
});

test("fromInverted tolerates out-of-order positions and gaps", () => {
  const index = { fox: [3], quick: [1], the: [0] };
  assert.equal(fromInverted(index), "the quick fox");
  assert.equal(fromInverted({ a: [0], b: [5] }), "a b");
});

test("fromInverted returns undefined for null/empty", () => {
  assert.equal(fromInverted(undefined), undefined);
  assert.equal(fromInverted(null), undefined);
  assert.equal(fromInverted({}), undefined);
});
