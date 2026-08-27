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

describe("wiki-card-loader 卡片数量水位（TD-KNOWLEDGE-N08）", () => {
  it("数量落在去重后健康区间，防重复树回灌", () => {
    // 2026-08-27 删除「复审无效/复审无效」嵌套重复树（206 张逐字节相同副本）后，
    // 全库从 1549 降至 ~1344；曾存在的幽灵断言「>1500」锁定的是被污染基线。
    // 复发检测另见 scripts/measure-techdebt.mjs 的 knowledgeDupMd 指标。
    const count = new WikiCardLoader(WIKI_PATH).count();
    assert.ok(count > 1200, `期望 >1200 张，实际 ${count}`);
    assert.ok(count < 1500, `期望 <1500 张（不应回灌重复树），实际 ${count}`);
  });
});
