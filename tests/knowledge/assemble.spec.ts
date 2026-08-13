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

  it("KG 打开失败时降级为无图谱专利 provider（wiki/IPC 保留，不整体丢失）", () => {
    const resolvers = buildKnowledgeResolvers({
      ...baseOptions,
      patentKgDb: "/nonexistent/patent_kg.db",
      lawDb: "/nonexistent/laws.db",
      wikiDir: "/nonexistent/wiki",
    });
    // A2 修复：KG 打开失败降级 push 无图谱 provider（与 patentKgDb 未配置一致）；
    // law 打开失败跳过法律 → 共 1 个 resolver（不抛错）
    assert.equal(resolvers.length, 1);
  });

  it("indexWiki=false 时不给专利 provider 注入 embedding（不抛错）", () => {
    const resolvers = buildKnowledgeResolvers({
      ...baseOptions,
      patentKgDb: "/nonexistent/patent_kg.db",
      indexWiki: false,
      embedding: undefined,
    });
    assert.equal(resolvers.length, 1); // A2 修复：KG 打开失败仍 push 无图谱 provider
  });
});
