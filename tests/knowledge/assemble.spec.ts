import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildKnowledgeResolvers } from "../../src/knowledge/assemble.js";

const baseOptions = {
  embeddingDir: "/tmp/sati-embedding-test",
  logger: { warn: () => {} },
};

describe("buildKnowledgeResolvers", () => {
  it("所有数据库缺失时仅返回无图谱专利 provider（可降级）", () => {
    const resolvers = buildKnowledgeResolvers({ ...baseOptions });
    assert.equal(resolvers.length, 1);
  });

  it("vectors.db 缺失时正常运行（语义召回关闭）", () => {
    const resolvers = buildKnowledgeResolvers({
      ...baseOptions,
      patentKgDb: "/nonexistent/patent_kg.db",
      lawDb: "/nonexistent/laws.db",
      wikiDir: "/nonexistent/wiki",
    });
    // KG 打开失败跳过专利；law 打开失败跳过法律 → 空列表（不抛错）
    assert.equal(resolvers.length, 0);
  });

  it("indexWiki=false 时不给专利 provider 注入 embedding（不抛错）", () => {
    const resolvers = buildKnowledgeResolvers({
      ...baseOptions,
      patentKgDb: "/nonexistent/patent_kg.db",
      indexWiki: false,
      embedding: undefined,
    });
    assert.equal(resolvers.length, 0); // KG 打开失败跳过，仅验证不抛错
  });
});
