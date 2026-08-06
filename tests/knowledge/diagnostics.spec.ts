import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatKnowledgeCapabilities,
  logKnowledgeCapabilities,
  resolveKnowledgeCapabilities,
} from "../../src/knowledge/diagnostics.js";
import type { KnowledgeDbPaths } from "../../src/knowledge/config.js";
import type { KnowledgeRuntimeStatsSnapshot } from "../../src/knowledge/shared/knowledge-stats.js";

function paths(overrides: Partial<KnowledgeDbPaths> = {}): KnowledgeDbPaths {
  return { dataDir: "/tmp/sati-knowledge-test", ...overrides };
}

function statsSnapshot(overrides: Partial<KnowledgeRuntimeStatsSnapshot> = {}): KnowledgeRuntimeStatsSnapshot {
  return {
    cacheHits: 0,
    cacheMisses: 0,
    semanticCalls: 0,
    semanticFailures: 0,
    rerankCalls: 0,
    rerankFailures: 0,
    breakers: [],
    kgFtsMode: "unknown",
    wikiSemanticIndex: "disabled",
    ...overrides,
  };
}

describe("resolveKnowledgeCapabilities", () => {
  it("数据与语义配置全齐时全部 ready", () => {
    const caps = resolveKnowledgeCapabilities(
      paths({
        patentKgDb: "/data/patent_kg.db",
        lawDb: "/data/laws-full.db",
        wikiDir: "/data/wiki",
        vectorsDb: "/data/vectors.db",
        caseDb: "/data/knowledge.db",
      }),
      { embeddingConfigured: true, rerankConfigured: true },
    );
    for (const cap of caps) {
      assert.equal(cap.status, "ready", `${cap.id} 应为 ready`);
    }
  });

  it("全部缺失时：数据项 missing、语义项 disabled、IPC 恒 ready", () => {
    const caps = resolveKnowledgeCapabilities(paths(), { embeddingConfigured: false, rerankConfigured: false });
    const byId = new Map(caps.map(cap => [cap.id, cap.status]));
    assert.equal(byId.get("patent-kg"), "missing");
    assert.equal(byId.get("patent-wiki"), "missing");
    assert.equal(byId.get("legal-fts"), "missing");
    assert.equal(byId.get("case-law"), "missing");
    assert.equal(byId.get("semantic-embedding"), "disabled");
    assert.equal(byId.get("semantic-vectors"), "disabled");
    assert.equal(byId.get("rerank"), "disabled");
    // IPC 审查标准随仓库内置，恒可用
    assert.equal(byId.get("patent-ipc"), "ready");
  });

  it("部分缺失时各自独立判定", () => {
    const caps = resolveKnowledgeCapabilities(paths({ patentKgDb: "/data/patent_kg.db", wikiDir: "/data/wiki" }), {
      embeddingConfigured: true,
      rerankConfigured: false,
    });
    const byId = new Map(caps.map(cap => [cap.id, cap]));
    assert.equal(byId.get("patent-kg")?.status, "ready");
    assert.equal(byId.get("legal-fts")?.status, "missing");
    assert.equal(byId.get("semantic-embedding")?.status, "ready");
    assert.equal(byId.get("rerank")?.status, "disabled");
  });

  it("缺失项带配置提示（环境变量名/命令）", () => {
    const caps = resolveKnowledgeCapabilities(paths(), { embeddingConfigured: false, rerankConfigured: false });
    const byId = new Map(caps.map(cap => [cap.id, cap]));
    assert.equal(byId.get("legal-fts")?.detail, "SATI_LAW_DB");
    assert.equal(byId.get("patent-kg")?.detail, "SATI_PATENT_KG_DB");
    assert.match(byId.get("semantic-vectors")?.detail ?? "", /embeddings/, "应提示 knowledge.db embeddings 状态");
    assert.equal(byId.get("semantic-embedding")?.detail, "memory.embedding.enabled");
  });

  it("诊断判定与 assemble 行为一致：无 lawDb 时法律能力 missing", () => {
    // 与 assemble.spec "所有数据库缺失时仅返回无图谱专利 provider" 对应：
    // 无 lawDb 时 LegalMemoryProvider 不组装，诊断应标记 legal-fts=missing。
    const caps = resolveKnowledgeCapabilities(paths({ patentKgDb: "/data/patent_kg.db" }), {
      embeddingConfigured: false,
      rerankConfigured: false,
    });
    const legal = caps.find(cap => cap.id === "legal-fts");
    assert.equal(legal?.status, "missing");
  });

  it("不传运行时快照时不追加运行时能力项", () => {
    const caps = resolveKnowledgeCapabilities(paths(), { embeddingConfigured: false, rerankConfigured: false });
    assert.ok(!caps.some(cap => cap.id === "kg-fts-tokenizer"));
    assert.ok(!caps.some(cap => cap.id === "wiki-semantic-index"));
  });

  it("trigram 模式：kg-fts-tokenizer=ready 且无升级提示", () => {
    const caps = resolveKnowledgeCapabilities(paths(), {
      embeddingConfigured: false,
      rerankConfigured: false,
      runtime: statsSnapshot({ kgFtsMode: "trigram" }),
    });
    const fts = caps.find(cap => cap.id === "kg-fts-tokenizer");
    assert.equal(fts?.status, "ready");
    assert.equal(fts?.detail, "trigram");
  });

  it("unicode61 模式：ready 但提示升级 trigram 脚本", () => {
    const caps = resolveKnowledgeCapabilities(paths(), {
      embeddingConfigured: false,
      rerankConfigured: false,
      runtime: statsSnapshot({ kgFtsMode: "unicode61" }),
    });
    const fts = caps.find(cap => cap.id === "kg-fts-tokenizer");
    assert.equal(fts?.status, "ready");
    assert.match(fts?.detail ?? "", /migrate-kg-fts-trigram/);
  });

  it("like 降级（桌面端 FTS5 缺失）：kg-fts-tokenizer=missing", () => {
    const caps = resolveKnowledgeCapabilities(paths(), {
      embeddingConfigured: false,
      rerankConfigured: false,
      runtime: statsSnapshot({ kgFtsMode: "like" }),
    });
    const fts = caps.find(cap => cap.id === "kg-fts-tokenizer");
    assert.equal(fts?.status, "missing");
    assert.match(fts?.detail ?? "", /LIKE/);
  });

  it("wiki 语义索引：warming/ready 为 ready，failed 为 missing", () => {
    const warming = resolveKnowledgeCapabilities(paths(), {
      embeddingConfigured: true,
      rerankConfigured: false,
      runtime: statsSnapshot({ wikiSemanticIndex: "warming" }),
    });
    assert.equal(warming.find(cap => cap.id === "wiki-semantic-index")?.status, "ready");
    assert.match(warming.find(cap => cap.id === "wiki-semantic-index")?.detail ?? "", /预热中/);

    const failed = resolveKnowledgeCapabilities(paths(), {
      embeddingConfigured: true,
      rerankConfigured: false,
      runtime: statsSnapshot({ wikiSemanticIndex: "failed" }),
    });
    assert.equal(failed.find(cap => cap.id === "wiki-semantic-index")?.status, "missing");
    assert.match(failed.find(cap => cap.id === "wiki-semantic-index")?.detail ?? "", /预热失败/);
  });
});

describe("formatKnowledgeCapabilities", () => {
  it("ready 项无提示，缺失项带括号提示", () => {
    const caps = resolveKnowledgeCapabilities(paths(), { embeddingConfigured: false, rerankConfigured: false });
    const text = formatKnowledgeCapabilities(caps);
    assert.match(text, /patent-ipc=ready/);
    assert.match(text, /legal-fts=missing\(SATI_LAW_DB\)/);
    assert.match(text, /semantic-vectors=disabled\(.*embeddings.*\)/);
  });

  it("全部 ready 时不带任何括号提示", () => {
    const caps = resolveKnowledgeCapabilities(
      paths({
        patentKgDb: "/data/patent_kg.db",
        lawDb: "/data/laws-full.db",
        wikiDir: "/data/wiki",
        vectorsDb: "/data/vectors.db",
        caseDb: "/data/knowledge.db",
      }),
      { embeddingConfigured: true, rerankConfigured: true },
    );
    const text = formatKnowledgeCapabilities(caps);
    assert.ok(!text.includes("("), `不应包含提示括号: ${text}`);
  });
});

describe("logKnowledgeCapabilities", () => {
  it("全部 ready 时走 info 输出", () => {
    const calls: Array<[string, string]> = [];
    logKnowledgeCapabilities(
      paths({
        patentKgDb: "/data/patent_kg.db",
        lawDb: "/data/laws-full.db",
        wikiDir: "/data/wiki",
        vectorsDb: "/data/vectors.db",
        caseDb: "/data/knowledge.db",
      }),
      { embeddingConfigured: true, rerankConfigured: true },
      {
        info: message => calls.push(["info", message]),
        warn: message => calls.push(["warn", message]),
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "info");
    assert.match(calls[0]?.[1] ?? "", /all ready/);
  });

  it("存在缺失/关闭项时走 warn 输出清单", () => {
    const calls: Array<[string, string]> = [];
    logKnowledgeCapabilities(
      paths(),
      { embeddingConfigured: false, rerankConfigured: false },
      {
        info: message => calls.push(["info", message]),
        warn: message => calls.push(["warn", message]),
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "warn");
    assert.match(calls[0]?.[1] ?? "", /legal-fts=missing\(SATI_LAW_DB\)/);
  });
});
