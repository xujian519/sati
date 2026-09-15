import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

type KnowledgeDbRows = { kgNodes?: number; lawArticles?: number; embeddings?: number; documents?: number };

/**
 * 建一个临时 knowledge.db，schema 覆盖 probeKnowledgeDb 的四条计数语句，
 * 按需填充行数；返回库路径（调用方负责清理临时目录）。
 */
function makeKnowledgeDb(dir: string, rows: KnowledgeDbRows = {}): string {
  const dbPath = join(dir, "knowledge.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent', title TEXT NOT NULL, indexed_at TEXT NOT NULL);
    CREATE TABLE kg_nodes (id TEXT PRIMARY KEY, node_type TEXT NOT NULL, name TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent');
    CREATE TABLE embeddings (id INTEGER PRIMARY KEY, chunk_id INTEGER NOT NULL, document_id TEXT NOT NULL, vector BLOB NOT NULL, dim INTEGER NOT NULL DEFAULT 1024, indexed_at TEXT NOT NULL);
  `);
  const insertDoc = db.prepare(
    "INSERT INTO documents (id, source, doc_type, domain, title, indexed_at) VALUES (?, 't', ?, 'patent', 't', '2026-01-01')",
  );
  for (let i = 0; i < (rows.documents ?? 0); i++) insertDoc.run(`case-${i}`, "case");
  for (let i = 0; i < (rows.lawArticles ?? 0); i++) insertDoc.run(`law-${i}`, "law_article");
  const insertNode = db.prepare("INSERT INTO kg_nodes (id, node_type, name) VALUES (?, 'concept', 'n')");
  for (let i = 0; i < (rows.kgNodes ?? 0); i++) insertNode.run(`node-${i}`);
  const insertEmbedding = db.prepare(
    "INSERT INTO embeddings (chunk_id, document_id, vector, indexed_at) VALUES (0, 'x', X'00', '2026-01-01')",
  );
  for (let i = 0; i < (rows.embeddings ?? 0); i++) insertEmbedding.run();
  db.close();
  return dbPath;
}

/** 建一个不含 knowledge 表的 sqlite 文件（探测查询会抛错 → probe 为 null）。 */
function makeUnprobeableDb(dir: string): string {
  const dbPath = join(dir, "broken-knowledge.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE unrelated (x TEXT)");
  db.close();
  return dbPath;
}

/** 语义齐全的伪路径集合（除 case-law 走独立库外，全部 ready）。 */
function allReadyFakePaths(overrides: Partial<KnowledgeDbPaths> = {}): KnowledgeDbPaths {
  return paths({
    patentKgDb: "/data/patent_kg.db",
    lawDb: "/data/laws-full.db",
    wikiDir: "/data/wiki",
    vectorsDb: "/data/vectors.db",
    caseDb: "/data/cases.db",
    ...overrides,
  });
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
    caseLawAvailable: false,
    caseLawInjects: 0,
    legalFtsDegraded: false,
    caseLawFtsDegraded: false,
    likeFallbacks: 0,
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

  it("case-law 判据与装配对齐：空 knowledge.db 不误报 ready（即使 caseDb 指向同一主库）", () => {
    // A1/A5 修复：空库（documents 0 行）probe 成功但 documents=0 → missing；
    // 与 assemble 的 CaseLawSearchEngine.count()===0 → 关闭 行为一致。
    const dir = mkdtempSync(join(tmpdir(), "kb-diag-empty-"));
    const dbPath = makeKnowledgeDb(dir, { kgNodes: 1 });
    try {
      const caps = resolveKnowledgeCapabilities(paths({ knowledgeDb: dbPath, caseDb: dbPath }), {
        embeddingConfigured: false,
        rerankConfigured: false,
      });
      assert.equal(caps.find(cap => cap.id === "case-law")?.status, "missing", "空 documents 不应报 ready");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("case-law 语义显式化：独立 SATI_CASE_DB → ready 但 autoInject=false（仅工具通道）", () => {
    // issue #366：assemble.ts 的判例自动注入只从 options.knowledgeDb 接线，
    // 独立 caseDb 只被 patent_case_search 工具消费——ready 是真的，但含义是
    // 「工具可用」而非「已装配」，必须由 autoInject 显式区分。
    const caps = resolveKnowledgeCapabilities(paths({ caseDb: "/data/cases.db" }), {
      embeddingConfigured: false,
      rerankConfigured: false,
    });
    const cap = caps.find(c => c.id === "case-law");
    assert.equal(cap?.status, "ready");
    assert.equal(cap?.autoInject, false, "独立库不经 memory provider 自动注入");
    assert.match(cap?.detail ?? "", /patent_case_search/, "detail 应写明工具通道");
    assert.match(cap?.detail ?? "", /不自动注入/);
  });

  it("case-law 语义显式化：主库有判例 → ready 且 autoInject=true", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-diag-caseok-"));
    const dbPath = makeKnowledgeDb(dir, { documents: 3 });
    try {
      const caps = resolveKnowledgeCapabilities(paths({ knowledgeDb: dbPath }), {
        embeddingConfigured: false,
        rerankConfigured: false,
      });
      const cap = caps.find(c => c.id === "case-law");
      assert.equal(cap?.status, "ready");
      assert.equal(cap?.autoInject, true);
      assert.match(cap?.detail ?? "", /自动注入/);
      assert.match(cap?.detail ?? "", /3 篇/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("case-law：主库无判例文档但配了独立判例库 → ready（仅工具）", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-diag-caselegacy-"));
    const dbPath = makeKnowledgeDb(dir, { kgNodes: 1 });
    try {
      const caps = resolveKnowledgeCapabilities(paths({ knowledgeDb: dbPath, caseDb: "/data/cases.db" }), {
        embeddingConfigured: false,
        rerankConfigured: false,
      });
      const cap = caps.find(c => c.id === "case-law");
      assert.equal(cap?.status, "ready", "独立库可检索 → 报 ready");
      assert.equal(cap?.autoInject, false);
      assert.match(cap?.detail ?? "", /主库无判例文档/, "须同时说明主库为空（未自动注入的原因）");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("case-law：主库不可探测且无独立库 → missing（不再因 caseDb 回落而误报 ready）", () => {
    // 修复前：probe===null 时只要 paths.caseDb 为真即报 ready，而 caseDb 在
    // config.ts 里会回落到 knowledge.db 本身——于是「主库缺表/损坏」报 ready，
    // 与判定注释「probe 失败且主库存在 → missing」相矛盾（诊断说谎）。
    const dir = mkdtempSync(join(tmpdir(), "kb-diag-broken-"));
    const dbPath = makeUnprobeableDb(dir);
    try {
      const caps = resolveKnowledgeCapabilities(paths({ knowledgeDb: dbPath, caseDb: dbPath }), {
        embeddingConfigured: false,
        rerankConfigured: false,
      });
      const cap = caps.find(c => c.id === "case-law");
      assert.equal(cap?.status, "missing");
      assert.equal(cap?.autoInject, false);
      assert.match(cap?.detail ?? "", /knowledge.db 不可用/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("autoInject 标注矩阵：数据能力项显式标注，语义开关项不适用", () => {
    const caps = resolveKnowledgeCapabilities(allReadyFakePaths(), {
      embeddingConfigured: true,
      rerankConfigured: true,
    });
    const byId = new Map(caps.map(cap => [cap.id, cap]));
    for (const id of ["patent-kg", "patent-ipc", "patent-wiki", "legal-fts"] as const) {
      assert.equal(byId.get(id)?.autoInject, true, `${id} 经 memory provider 注入`);
    }
    assert.equal(byId.get("case-law")?.autoInject, false);
    for (const id of ["semantic-embedding", "semantic-vectors", "rerank"] as const) {
      assert.equal(byId.get(id)?.autoInject, undefined, `${id} 非数据能力项不标注通道`);
    }
  });

  it("运行时 FTS 降级联动：legal-fts/case-law 如实降级为 missing", () => {
    // H3：桌面端无 FTS5 的 Node 下引擎粘性降级 LIKE——诊断不再误报 ready。
    const caps = resolveKnowledgeCapabilities(paths({ lawDb: "/data/laws.db", caseDb: "/data/knowledge.db" }), {
      embeddingConfigured: false,
      rerankConfigured: false,
      runtime: statsSnapshot({ legalFtsDegraded: true, caseLawFtsDegraded: true }),
    });
    const legal = caps.find(cap => cap.id === "legal-fts");
    const caseLaw = caps.find(cap => cap.id === "case-law");
    assert.equal(legal?.status, "missing");
    assert.match(legal?.detail ?? "", /LIKE/);
    assert.equal(caseLaw?.status, "missing");
    assert.match(caseLaw?.detail ?? "", /LIKE/);
  });

  it("运行时 FTS 正常时不降级（回归）", () => {
    const caps = resolveKnowledgeCapabilities(paths({ lawDb: "/data/laws.db", caseDb: "/data/knowledge.db" }), {
      embeddingConfigured: false,
      rerankConfigured: false,
      runtime: statsSnapshot({ legalFtsDegraded: false, caseLawFtsDegraded: false }),
    });
    assert.equal(caps.find(cap => cap.id === "legal-fts")?.status, "ready");
    assert.equal(caps.find(cap => cap.id === "case-law")?.status, "ready");
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

  it("全部 ready 且全部自动注入时不带任何括号提示", () => {
    // 需真实主库（四条计数 + 判例）才能构成「全部 ready 且 autoInject=true」。
    const dir = mkdtempSync(join(tmpdir(), "kb-diag-fmt-"));
    try {
      const dbPath = makeKnowledgeDb(dir, { kgNodes: 3, lawArticles: 2, embeddings: 5, documents: 4 });
      const caps = resolveKnowledgeCapabilities(paths({ knowledgeDb: dbPath, wikiDir: "/data/wiki" }), {
        embeddingConfigured: true,
        rerankConfigured: true,
      });
      const text = formatKnowledgeCapabilities(caps);
      assert.ok(!text.includes("("), `不应包含提示括号: ${text}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ready 但未自动注入的项必须带提示（否则会被读成已装配）", () => {
    const caps = resolveKnowledgeCapabilities(allReadyFakePaths(), {
      embeddingConfigured: true,
      rerankConfigured: true,
    });
    const text = formatKnowledgeCapabilities(caps);
    assert.match(text, /case-law=ready\(/, "ready 且 autoInject=false 项应带括号提示");
    assert.match(text, /不自动注入/);
    // 其余 ready 行仍不带提示，清单保持可扫读。
    assert.match(text, /patent-kg=ready(?![(\w])/);
  });
});

describe("logKnowledgeCapabilities", () => {
  it("全部 ready 且全部自动注入时走无注解的 info 输出", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-diag-log-"));
    try {
      const dbPath = makeKnowledgeDb(dir, { kgNodes: 3, lawArticles: 2, embeddings: 5, documents: 4 });
      const calls: Array<[string, string]> = [];
      logKnowledgeCapabilities(
        paths({ knowledgeDb: dbPath, wikiDir: "/data/wiki" }),
        { embeddingConfigured: true, rerankConfigured: true },
        {
          info: message => calls.push(["info", message]),
          warn: message => calls.push(["warn", message]),
        },
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.[0], "info");
      assert.equal(calls[0]?.[1], "[sati] knowledge: all ready");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("全部 ready 但含未自动注入项时，info 文案点名该通道", () => {
    // 「all ready」若不加注解，会把「工具可用」读成「已装配」（issue #366）。
    const calls: Array<[string, string]> = [];
    logKnowledgeCapabilities(
      allReadyFakePaths(),
      { embeddingConfigured: true, rerankConfigured: true },
      {
        info: message => calls.push(["info", message]),
        warn: message => calls.push(["warn", message]),
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "info");
    assert.match(calls[0]?.[1] ?? "", /case-law 仅经工具可用，未自动注入/);
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
