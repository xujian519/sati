import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildKnowledgeResolvers } from "../../src/knowledge/assemble.js";
import { KnowledgeRuntimeStats } from "../../src/knowledge/shared/knowledge-stats.js";
import { finalizeVectorsDb, openVectorsDbWriter, setCorpusMeta } from "../../src/knowledge/shared/vector-db-writer.js";

const baseOptions = {
  embeddingDir: "/tmp/sati-embedding-test",
  logger: { warn: () => {} },
};

describe("buildKnowledgeResolvers", () => {
  it("所有数据库缺失时仅返回无图谱专利 provider（可降级）", () => {
    const resolvers = buildKnowledgeResolvers({ ...baseOptions });
    assert.equal(resolvers.length, 1);
  });

  it("KG 打开失败时降级为无图谱专利 provider（不抛错）", () => {
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

  it("vectors.db 打开后把实际已索引语料写进运行时快照（#376 A6 的施效侧）", () => {
    // 诊断据该快照与「被消费语料」求交；若这一侧不上报，判据就退化成路径存在性。
    const dir = mkdtempSync(join(tmpdir(), "sati-assemble-vdb-"));
    try {
      const vectorsDb = join(dir, "vectors.db");
      const writer = openVectorsDbWriter(vectorsDb);
      setCorpusMeta(writer, {
        corpus: "kg",
        dimensions: 4,
        model: "test",
        chunkChars: 1200,
        chunkOverlap: 200,
        builtAt: "t",
      });
      finalizeVectorsDb(writer);
      writer.close();

      const stats = new KnowledgeRuntimeStats();
      buildKnowledgeResolvers({ ...baseOptions, vectorsDb, stats });
      assert.deepEqual(stats.snapshot().vectorDbProbe, { opened: true, corpora: ["kg"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("vectors.db 打开失败时上报 opened=false（诊断据此降级，而非「路径存在即 ready」）", () => {
    const stats = new KnowledgeRuntimeStats();
    buildKnowledgeResolvers({ ...baseOptions, vectorsDb: "/nonexistent/vectors.db", stats });
    const probe = stats.snapshot().vectorDbProbe;
    assert.equal(probe?.opened, false);
    assert.ok(probe && (probe.opened === false ? probe.reason.length > 0 : false), "应带失败原因");
  });
});
