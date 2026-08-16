import assert from "node:assert/strict";
import test from "node:test";
import { parseLawRefsCount, toNode } from "../../src/knowledge/shared/kg/row-mapper.js";

test("toNode: unified schema law_refs JSON 解析为 lawRefsCount", () => {
  const node = toNode({
    id: "n1",
    node_type: "article",
    name: "专利法",
    title: null,
    content: null,
    law_refs: '["ref-a","ref-b","ref-c"]',
    source: null,
    full_ref: null,
    chapter: null,
    article_number: null,
  });
  assert.equal(node.lawRefsCount, 3);
  assert.equal(node.id, "n1");
  assert.equal(node.nodeType, "article");
  assert.equal(node.name, "专利法");
});

test("toNode: legacy schema law_refs_count 优先于 JSON 解析", () => {
  const node = toNode({
    id: "n2",
    node_type: "node",
    name: null,
    title: null,
    content: "正文",
    law_refs_count: 7,
    source: "src",
    full_ref: null,
    chapter: null,
    article_number: "22",
    version: "2020",
  });
  assert.equal(node.lawRefsCount, 7);
  assert.equal(node.version, "2020");
  assert.equal(node.articleNumber, "22");
});

test("toNode: 空列映射为 undefined", () => {
  const node = toNode({
    id: "n3",
    node_type: null,
    name: null,
    title: null,
    content: null,
    source: null,
    full_ref: null,
    chapter: null,
    article_number: null,
  });
  assert.equal(node.name, undefined);
  assert.equal(node.title, undefined);
  assert.equal(node.lawRefsCount, undefined);
  assert.equal(node.nodeType, "");
});

test("parseLawRefsCount: 非法 JSON / 非数组 / 空值返回 undefined", () => {
  assert.equal(parseLawRefsCount("not-json"), undefined);
  assert.equal(parseLawRefsCount("{}"), undefined);
  assert.equal(parseLawRefsCount(null), undefined);
  assert.equal(parseLawRefsCount(""), undefined);
});
