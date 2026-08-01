import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RecallHeaderEntry } from "edgeclaw-memory-core";
import { fuseManifestWithSemantic, SEMANTIC_SEARCH_LIMIT } from "edgeclaw-memory-core";

function makeEntry(relativePath: string, updatedAt: string): RecallHeaderEntry {
  return {
    name: relativePath.split("/").pop() ?? relativePath,
    description: `desc ${relativePath}`,
    type: "project",
    scope: "project",
    updatedAt,
    file: relativePath,
    relativePath,
    absolutePath: `/mem/${relativePath}`,
  };
}

describe("fuseManifestWithSemantic", () => {
  it("无语义命中时原样返回 manifest", () => {
    const manifest = [makeEntry("a.md", "t1")];
    const fused = fuseManifestWithSemantic(manifest, []);
    assert.equal(fused, manifest);
  });

  it("语义独有命中以占位条目加入候选（description 带 score）", () => {
    const manifest = [makeEntry("recent.md", "t1")];
    const fused = fuseManifestWithSemantic(manifest, [{ relativePath: "old-semantic.md", score: 0.9 }]);
    const ids = fused.map(entry => entry.relativePath);
    assert.ok(ids.includes("old-semantic.md"));
    const placeholder = fused.find(entry => entry.relativePath === "old-semantic.md")!;
    assert.ok(placeholder.description.includes("0.9000"), "占位符 description 应携带 score");
  });

  it("交集条目 RRF 分数累加后置顶", () => {
    // b 同时在 manifest rank 0 与语义 rank 0：RRF 累加最高
    const manifest = [makeEntry("a.md", "t3"), makeEntry("b.md", "t2"), makeEntry("c.md", "t1")];
    const fused = fuseManifestWithSemantic(manifest, [
      { relativePath: "b.md", score: 0.99 },
      { relativePath: "x.md", score: 0.5 },
    ]);
    assert.equal(fused[0]!.relativePath, "b.md");
  });

  it("语义独有命中排序合理（高语义分优于低 manifest rank 差）", () => {
    // 语义独有 hit 在语义路 rank 0（1/61）；manifest 尾部的 c 在 rank 2（1/63）→ hit 应靠前
    const manifest = [makeEntry("a.md", "t3"), makeEntry("b.md", "t2"), makeEntry("c.md", "t1")];
    const fused = fuseManifestWithSemantic(manifest, [{ relativePath: "sem-only.md", score: 0.95 }]);
    const index = fused.findIndex(entry => entry.relativePath === "sem-only.md");
    assert.ok(index >= 0);
    assert.ok(index < fused.findIndex(entry => entry.relativePath === "c.md"));
  });

  it("SEMANTIC_SEARCH_LIMIT 导出存在", () => {
    assert.equal(typeof SEMANTIC_SEARCH_LIMIT, "number");
    assert.ok(SEMANTIC_SEARCH_LIMIT > 0);
  });
});
