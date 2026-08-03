import assert from "node:assert/strict";
import test from "node:test";
import { xmlAttr, xmlBlocks, xmlSelfClosing, xmlText } from "../../../../src/literature/runtime/shared/xml.js";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is All You Need</title>
    <summary>   The dominant sequence transduction models &amp; are based on complex recurrent networks.   </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <published>2017-06-12T00:00:00Z</published>
    <arxiv:primary_category term="cs.CL"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2001.00001</id>
    <title>Second Paper</title>
    <link title="pdf" href="http://arxiv.org/pdf/2001.00001"/>
  </entry>
</feed>`;

test("xmlBlocks extracts every entry block", () => {
  const blocks = xmlBlocks(FEED, "entry");
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].includes("Attention Is All You Need"));
});

test("xmlText returns first inner text, entity-decoded and whitespace-collapsed", () => {
  assert.equal(xmlText(FEED, "title"), "Attention Is All You Need");
  assert.equal(
    xmlText(FEED, "summary"),
    "The dominant sequence transduction models & are based on complex recurrent networks.",
  );
  assert.equal(xmlText(FEED, "missing"), undefined);
});

test("xmlAttr reads attribute on namespaced self-closing tag", () => {
  assert.equal(xmlAttr(FEED, "arxiv:primary_category", "term"), "cs.CL");
  assert.equal(xmlAttr(FEED, "arxiv:primary_category", "nope"), undefined);
});

test("xmlSelfClosing finds self-closing links with attribute maps", () => {
  const links = xmlSelfClosing(FEED, "link");
  assert.equal(links.length, 2);
  const pdf = links.find(l => (l.attrs.title ?? "").toLowerCase() === "pdf");
  assert.equal(pdf?.attrs.href, "http://arxiv.org/pdf/1706.03762v7");
});

test("xmlSelfClosing handles attribute order independence", () => {
  const xml = `<feed><link href="http://x.test/1" title="pdf" rel="related"/></feed>`;
  const links = xmlSelfClosing(xml, "link");
  assert.equal(links[0].attrs.href, "http://x.test/1");
  assert.equal(links[0].attrs.title, "pdf");
});

test("xmlSelfClosing ignores paired elements", () => {
  const xml = `<feed><link href="http://x.test">text</link></feed>`;
  assert.equal(xmlSelfClosing(xml, "link").length, 0);
});

test("xml helpers are defensive on malformed input", () => {
  assert.equal(xmlText("<entry>no close", "entry"), undefined);
  assert.deepEqual(xmlBlocks("garbage", "entry"), []);
  assert.deepEqual(xmlSelfClosing("garbage", "link"), []);
  assert.equal(xmlAttr("garbage", "link", "href"), undefined);
});
