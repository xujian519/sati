import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WikiCardLoader } from "../../src/knowledge/patent/wiki-card-loader.js";

const WIKI_PATH = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "src", "knowledge", "patent", "wiki");

describe("wiki-card-loader 目录过滤检索（searchIn/listDir）", () => {
  const loader = new WikiCardLoader(WIKI_PATH);

  it("searchIn 按目录前缀过滤检索", () => {
    const hits = loader.searchIn("专利实务/说明书", "充分公开", 10);
    assert.ok(hits.length > 0, "说明书目录应检索到充分公开卡片");
    for (const card of hits) {
      assert.ok(card.id.startsWith("专利实务/说明书/"), `卡片 ${card.id} 应位于说明书目录`);
    }
  });

  it("searchIn 空前缀 = 全目录检索（与 search 一致）", () => {
    const kw = "实施例";
    assert.ok(loader.searchIn("", kw, 5).length > 0);
    assert.equal(loader.searchIn("", kw, 5).length, loader.search(kw, 5).length);
  });

  it("searchIn 前缀按路径边界匹配（不误匹配兄弟前缀目录）", () => {
    // "专利实务/附图" 不应匹配 "专利实务/附图说明" 之类假设目录（当前 wiki 无，验证不过滤）
    const figures = loader.searchIn("专利实务/附图", "", 100);
    for (const card of figures) {
      assert.ok(card.id.startsWith("专利实务/附图/"), `卡片 ${card.id} 应位于附图目录`);
    }
  });

  it("listDir 列出目录下全部卡片", () => {
    const figures = loader.listDir("专利实务/附图", 50);
    assert.ok(
      figures.some(c => c.id.includes("说明书附图规范")),
      "附图目录应含说明书附图规范",
    );
    for (const card of figures) {
      assert.ok(card.id.startsWith("专利实务/附图/"), `卡片 ${card.id} 应位于附图目录`);
    }
  });
});
