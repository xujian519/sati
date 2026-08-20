import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CaseLawSearchEngine, createCaseLawSemanticSource } from "../../src/knowledge/case-law/case-law-search.js";
import { KnowledgeEmbeddingSearch } from "../../src/knowledge/shared/knowledge-embeddings.js";

/**
 * CaseLawSearchEngine 单元测试。
 *
 * fixture 用 contentless trigram FTS5（与真实 knowledge.db 的 docs_fts 一致）：
 * docs_fts.rowid 即 chunks.id，正文经 chunks.content 回源，再 JOIN documents。
 */
function createEngine(includeFts = true): { engine: CaseLawSearchEngine; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "case-law-test-"));
  const dbPath = join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent',
      title TEXT NOT NULL, file_path TEXT, module TEXT, priority TEXT, level TEXT, publish_date TEXT,
      case_number TEXT, court TEXT, decision_number TEXT, article_number TEXT, content_hash TEXT,
      indexed_at TEXT NOT NULL, char_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id),
      chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, heading TEXT, content TEXT NOT NULL, char_count INTEGER DEFAULT 0
    );
    CREATE INDEX idx_chunks_document ON chunks(document_id, chunk_index);
  `);
  if (includeFts) {
    db.exec(
      `CREATE VIRTUAL TABLE docs_fts USING fts5(
        title, content, module, domain, tags, tokenize='trigram', content='', contentless_delete=1
      )`,
    );
  }
  const insertDoc = db.prepare(
    `INSERT INTO documents (id, source, doc_type, domain, title, case_number, court, decision_number, char_count, chunk_count, indexed_at)
     VALUES (?, ?, ?, 'patent', ?, ?, ?, ?, ?, ?, '2026-07-01T00:00:00.000Z')`,
  );
  insertDoc.run("d1", "raw", "case", "专利无效复审决定 008073341", "008073341", null, "566693", 300, 2);
  insertDoc.run("d2", "raw", "judgment", "某专利侵权判决", null, "最高人民法院", null, 200, 1);
  insertDoc.run("d3", "raw", "case", "另一无效决定", "999999999", null, "777777", 100, 1);
  insertDoc.run("d4", "wiki", "case", "创造性-审查标准-磨削抛光", null, null, null, 150, 1);
  // P1 转义用例：d5 title 含字面 %（搜 "100%" 应字面匹配）；d6 为通配对照
  // （% 若被当作通配符会误命中 d6，字面匹配则只有 d5）。
  insertDoc.run("d5", "raw", "case", "100% 有效率方案", null, null, null, 120, 1);
  insertDoc.run("d6", "raw", "case", "100X有效率方案", null, null, null, 90, 1);

  const insertChunk = db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, chunk_type, heading, content, char_count)
     VALUES (?, ?, ?, 'paragraph', NULL, ?, ?)`,
  );
  insertChunk.run(1, "d1", 0, "本案涉及创造性三步法判断，审查员认为技术方案显而易见。", 150);
  insertChunk.run(2, "d1", 1, "合议组认为区别特征产生了预料不到的技术效果。", 100);
  insertChunk.run(3, "d2", 0, "判决书正文：创造性判断应采用三步法框架进行认定。", 120);
  insertChunk.run(4, "d3", 0, "本决定认为权利要求不具备新颖性。", 80);
  insertChunk.run(5, "d4", 0, "创造性审查标准：技术启示的判断应当结合本领域技术人员认知。", 150);
  insertChunk.run(6, "d5", 0, "本案权利要求清楚，无需过多说明。", 90);
  // d6 content 追加英文小写（P1 #4b 大小写不敏感对照：大写查询应命中小写正文）
  insertChunk.run(7, "d6", 0, "本案权利要求清楚，无需过多说明。A novel reactor design is disclosed.", 90);

  if (includeFts) {
    // contentless 表：content 参数被忽略（不存储），仅建立索引词。
    const insertFts = db.prepare(
      `INSERT INTO docs_fts (rowid, title, content, module, domain, tags) VALUES (?, ?, ?, NULL, 'patent', NULL)`,
    );
    insertFts.run(1, "专利无效复审决定 008073341", "本案涉及创造性三步法判断，审查员认为技术方案显而易见。");
    insertFts.run(2, "专利无效复审决定 008073341", "合议组认为区别特征产生了预料不到的技术效果。");
    insertFts.run(3, "某专利侵权判决", "判决书正文：创造性判断应采用三步法框架进行认定。");
    insertFts.run(4, "另一无效决定", "本决定认为权利要求不具备新颖性。");
    insertFts.run(5, "创造性-审查标准-磨削抛光", "创造性审查标准：技术启示的判断应当结合本领域技术人员认知。");
    insertFts.run(6, "100% 有效率方案", "本案权利要求清楚，无需过多说明。");
    insertFts.run(7, "100X有效率方案", "本案权利要求清楚，无需过多说明。A novel reactor design is disclosed.");
  }
  db.close();
  return { engine: new CaseLawSearchEngine(dbPath), dir };
}

function withEngine(t: test.TestContext, includeFts = true): CaseLawSearchEngine {
  const { engine, dir } = createEngine(includeFts);
  t.after(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return engine;
}

test("case-law: FTS 命中并按文档去重（一文档一行）", t => {
  const engine = withEngine(t);
  const hits = engine.search("创造性");
  assert.ok(hits.length >= 1, "应命中含 创造性 的判例");
  const d1 = hits.find(h => h.documentId === "d1");
  assert.ok(d1, "d1 应命中（两个 chunk 均含 创造性）");
  assert.equal(d1.via, "fts");
  // 文档级聚合：d1 的两个 chunk 只出一行
  assert.equal(hits.filter(h => h.documentId === "d1").length, 1);
  // 命中 chunk 取 bm25 最高者，且 snippet 非空（contentless 需 JOIN chunks 回源）
  assert.ok(d1.snippet.length > 0, "snippet 应经 chunks 回源");
});

test("case-law: FTS 排序 bm25 越高越靠前", t => {
  const engine = withEngine(t);
  const hits = engine.search("创造性");
  // 命中按 fts_rank 降序排列（不依赖具体文档顺序，仅验证排序正确）
  const ranks = hits.map(h => h.ftsRank ?? 0);
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i - 1]! >= ranks[i]!, "命中应按 bm25 降序");
  }
});

test("case-law: doc_type 过滤", t => {
  const engine = withEngine(t);
  const hits = engine.search("创造性", { docType: "judgment" });
  assert.ok(
    hits.every(h => h.docType === "judgment"),
    "应只返回 judgment",
  );
  assert.ok(
    hits.some(h => h.documentId === "d2"),
    "应命中 d2",
  );
});

test("case-law: court 过滤（子串匹配）", t => {
  const engine = withEngine(t);
  const hits = engine.search("创造性", { court: "最高" });
  assert.ok(
    hits.every(h => h.court?.includes("最高")),
    "应只返回含 最高 法院的判例",
  );
});

test("case-law: 2 字查询直接走 LIKE 降级（trigram 需 3+ 字符）", t => {
  const engine = withEngine(t);
  // 2 字查询：P1 两阶段 title 直查先行（"无效" 命中 d1/d3 的 title）。
  const hits = engine.search("无效");
  assert.ok(
    hits.some(h => h.documentId === "d1"),
    "LIKE 应 title 命中 d1",
  );
  assert.ok(
    hits.every(h => h.via === "like"),
    "2 字查询应走 LIKE",
  );
});

test("case-law: 无 docs_fts 表时整体降级 LIKE", t => {
  const engine = withEngine(t, false);
  assert.equal(engine.ftsAvailable, false);
  // 无 FTS 走 LIKE 两阶段：2 字 "无效" title 直查命中 d1/d3（阶段 2 亦放行）
  const hits = engine.search("无效");
  assert.ok(
    hits.some(h => h.documentId === "d1"),
    "无 FTS 时 LIKE 仍应命中 d1",
  );
  assert.ok(
    hits.every(h => h.via === "like"),
    "应标注 via=like",
  );
});

test("case-law: FTS 无命中时降级 LIKE", t => {
  const engine = withEngine(t);
  // "预料不到" 未出现在 FTS 词项（content 中无该 3 字连续串的完整 token？含于 d1 chunk2）
  const hits = engine.search("预料不到的技术效果");
  assert.ok(
    hits.some(h => h.documentId === "d1"),
    "FTS 无命中应降级 LIKE 命中 d1",
  );
});

test("case-law: getById 返回全文分块（按 chunk_index 排序）", t => {
  const engine = withEngine(t);
  const chunks = engine.getById("d1");
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.chunkIndex, 0);
  assert.equal(chunks[1]!.chunkIndex, 1);
  assert.ok(chunks[0]!.content.includes("三步法"));
});

test("case-law: 空查询与 limit 生效", t => {
  const engine = withEngine(t);
  assert.equal(engine.search("").length, 0);
  const hits = engine.search("创造性", { limit: 1 });
  assert.equal(hits.length, 1);
});

test("case-law: count 统计", t => {
  const engine = withEngine(t);
  assert.equal(engine.count(), 6);
});

test("case-law: excludeSource 排除 wiki 审查标准卡片", t => {
  const engine = withEngine(t);
  // 不带排除：d4（source=wiki）也应命中（其 content 含 创造性）
  const all = engine.search("创造性");
  assert.ok(
    all.some(h => h.documentId === "d4"),
    "无排除时 wiki 卡片应命中",
  );
  // 排除 wiki：d4 不再出现，d1（raw）仍命中
  const rawOnly = engine.search("创造性", { excludeSource: "wiki" });
  assert.ok(!rawOnly.some(h => h.documentId === "d4"), "排除后 wiki 卡片不应命中");
  assert.ok(
    rawOnly.some(h => h.documentId === "d1"),
    "排除后仍应命中 raw 判例",
  );
});

test("case-law: 无过滤热路径走预编译语句，重复调用结果稳定", t => {
  const engine = withEngine(t);
  assert.equal(engine.ftsAvailable, true, "带 docs_fts 的 fixture 应启用 FTS");
  // 无过滤 FTS 查询走构造器预编译的 stmtSearchFts（不再逐次 prepare）
  const first = engine.search("创造性");
  const second = engine.search("创造性");
  assert.deepEqual(
    first.map(h => h.documentId),
    second.map(h => h.documentId),
    "预编译路径重复调用结果应一致",
  );
  assert.ok(first.length >= 1);
});

test("case-law: LIKE 降级路径走预编译语句，重复调用稳定", t => {
  const engine = withEngine(t);
  // 2 字查询 title 直查（无过滤走构造器预编译 stmtLikeTitle）
  const first = engine.search("无效");
  const second = engine.search("无效");
  assert.ok(first.length >= 1, "2 字查询应命中");
  assert.deepEqual(
    first.map(h => h.documentId).sort(),
    second.map(h => h.documentId).sort(),
    "LIKE 预编译路径重复调用结果应一致",
  );
  assert.ok(
    first.every(h => h.via === "like"),
    "2 字查询应标注 via=like",
  );
});

// ---------------------------------------------------------------------------
// P1：LIKE 两阶段（2026-08）——UDF 不出现在 SQL，content 扫描受限且有截断信号。
// 无 FTS engine 强制走 LIKE；fixture 依赖：
//   d1 title 含 无效 / 最长 chunk 含 三步法（title 与 content 分开可验证阶段归属）
//   d2 title 含 侵权 / content 含 三步法框架（content-only 命中）
//   d3 title 含 无效 / content 含 新颖性（content-only 命中）
//   d5 title 含 字面 100% / d6 title 含 100X（转义对照）
// ---------------------------------------------------------------------------
test("P1: 阶段 1 title 直查命中，snippet 回源最长 chunk", t => {
  const engine = withEngine(t, false);
  const hits = engine.search("无效");
  const d1 = hits.find(h => h.documentId === "d1");
  assert.ok(d1, "title 命中 d1");
  assert.ok(d1.snippet.includes("三步法"), "snippet 应回源 d1 最长 chunk（chunk0）");
  assert.equal(d1.chunkIndex, 0, "chunkIndex 应为回源的最长 chunk 索引");
  assert.equal(d1.via, "like");
});

test("P1: 3+ 字 content-only 命中（阶段 2 JS 侧解压匹配）", t => {
  const engine = withEngine(t, false);
  // "新颖性" 只在 d3 的 content（title 均不含）；无 FTS → 阶段 2 受限扫描命中
  const hits = engine.search("新颖性");
  assert.ok(
    hits.some(h => h.documentId === "d3" && h.snippet.includes("新颖性")),
    "阶段 2 应 content 命中 d3",
  );
  assert.equal(engine.likeScanCapped, false, "fixture 文档数远小于扫描上限，不应截断");
});

test("P1: 2 字查询放行阶段 2（#4a 门槛放宽），content-only 命中按 rowid 升序", t => {
  const engine = withEngine(t, false);
  // "认为" 只在 d1/d3 的 content（title 不含）；#4a 起 2 字触发阶段 2 受限扫描
  // （cap 兜底，1 字仍只走阶段 1）。命中顺序 = 候选 rowid 升序（#19）。
  const hits = engine.search("认为");
  assert.deepEqual(
    hits.map(h => h.documentId),
    ["d1", "d3"],
    "2 字 content 命中按 rowid 升序返回（d1 rowid=1, d3 rowid=4）",
  );
  assert.ok(
    hits.every(h => h.snippet.includes("认为")),
    "snippet 应含关键词",
  );
  assert.equal(engine.likeScanCapped, false, "fixture 文档数远小于扫描上限，不应截断");
});

test("P1: 1 字查询只走阶段 1 title 直查", t => {
  const engine = withEngine(t, false);
  const hits = engine.search("无");
  assert.ok(
    hits.some(h => h.documentId === "d1"),
    "1 字 title 命中保留",
  );
  assert.equal(hits.length, 2, "d1/d3 title 均含 无");
});

test("P1: title 中的 % 与 _ 字面转义（不当作通配符）", t => {
  const engine = withEngine(t, false);
  // 无 FTS 强制 LIKE；"100%" 4 rune 触发阶段 2，但 content 无字面 "100%" → 只 title 命中
  const hits = engine.search("100%");
  assert.ok(
    hits.some(h => h.documentId === "d5"),
    "应字面命中 d5（title 含 100%）",
  );
  assert.ok(!hits.some(h => h.documentId === "d6"), "% 不得当作通配符误命中 d6（100X）");
});

test("P1: 过滤组合（docType + court + excludeSource）在阶段 2 生效", t => {
  const engine = withEngine(t, false);
  // "三步法框架" 在 d2 content；docType=judgment 时阶段 2 候选仅剩 d2
  const hits = engine.search("三步法框架", { docType: "judgment" });
  assert.ok(
    hits.some(h => h.documentId === "d2" && h.snippet.includes("三步法框架")),
    "docType 过滤下阶段 2 应命中 d2",
  );
  assert.ok(
    hits.every(h => h.docType === "judgment"),
    "应只返回 judgment",
  );
  // excludeSource 排除 wiki：d4（source=wiki）在阶段 2 候选中被剔除
  const rawOnly = engine.search("三步法框架", { excludeSource: "wiki" });
  assert.ok(
    rawOnly.every(h => h.source !== "wiki"),
    "excludeSource 应作用于阶段 2 候选",
  );
  // 无过滤时 d2 亦可被 content 命中（对照）
  const noFilter = engine.search("三步法框架");
  assert.ok(noFilter.some(h => h.documentId === "d2"));
});

test("P1: 阶段 2 扫描上限截断置 likeScanCapped", t => {
  const { engine, dir } = createEngine(false);
  engine.close();
  const capped = new CaseLawSearchEngine(join(dir, "test.db"), { likeScanCap: 2 });
  t.after(() => {
    capped.close();
    rmSync(dir, { recursive: true, force: true });
  });
  // cap=2：候选按 id 升序只扫 d1/d2；"新颖性" 在 d3（超出扫描窗口）→ 截断且无命中
  const hits = capped.search("新颖性");
  assert.equal(hits.length, 0, "d3 超出扫描窗口（cap=2）");
  assert.equal(capped.likeScanCapped, true, "候选数达上限应置截断信号");
  // 窗口内的命中仍工作：d2 的 "三步法框架" 在 cap=2 窗口内
  const inWindow = capped.search("三步法框架");
  assert.ok(
    inWindow.some(h => h.documentId === "d2"),
    "扫描窗口内 content 命中保留",
  );
});

test("P1: SATI_LIKE_TWO_PHASE=0 等价——构造注入 likeTwoPhase:false 走旧单阶段 SQL", t => {
  const { engine, dir } = createEngine(false);
  engine.close();
  const legacy = new CaseLawSearchEngine(join(dir, "test.db"), { likeTwoPhase: false });
  t.after(() => {
    legacy.close();
    rmSync(dir, { recursive: true, force: true });
  });
  // 旧路径：2 字 "认为" 经 UDF 解压 content 命中 d1（与两阶段行为不同）
  const hits = legacy.search("认为");
  assert.ok(
    hits.some(h => h.documentId === "d1" && h.snippet.includes("认为")),
    "回滚路径应保留 content 命中",
  );
});

test("P1: 大小写不敏感（#4b 双端小写）——大写查询命中小写正文", t => {
  const engine = withEngine(t, false);
  // d6 content 含小写 "reactor"（title 不含）；旧 JS includes 大小写敏感会漏掉
  // 大写查询（如「ABC 公司」搜小写正文）——双端 toLowerCase 后字面等价旧 LIKE。
  const hits = engine.search("REACTOR");
  assert.ok(
    hits.some(h => h.documentId === "d6" && h.snippet.includes("reactor")),
    "大写查询应命中小写 content",
  );
  // 反向：小写查询命中大写正文（fixture 无大写正文，用混合大小写词确认无崩溃）
  const lower = engine.search("reactor");
  assert.ok(
    lower.some(h => h.documentId === "d6"),
    "小写查询命中一致",
  );
});

test("P1: LIKE 截断后 FTS 干净路径不残留信号（#20 入口统一清零）", t => {
  const { engine, dir } = createEngine(true);
  engine.close();
  const e = new CaseLawSearchEngine(join(dir, "test.db"), { likeScanCap: 2 });
  t.after(() => {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  });
  // FTS 无命中（乱造词）→ LIKE 阶段 2 截断（cap=2 只扫 d1/d2）
  const missed = e.search("xyzzy发明");
  assert.equal(missed.length, 0, "乱造词 FTS/LIKE 均无命中");
  assert.equal(e.likeScanCapped, true, "LIKE 阶段 2 达上限应置截断信号");
  // 随后 FTS 干净命中：入口统一清零 → 不再残留上次 LIKE 的截断值
  const hit = e.search("创造性");
  assert.ok(hit.length >= 1, "FTS 应命中");
  assert.equal(e.likeScanCapped, false, "FTS 路径不残留 LIKE 截断信号（入口清零）");
});

test("P1: LIKE 模式超长降级空结果（pattern too complex 不抛异常）", t => {
  const engine = withEngine(t, false);
  // SQLite LIKE 模式长度上限（默认 50000 字节）：超长查询串（如整篇文书
  // 粘贴）执行时会抛 "LIKE or GLOB pattern too complex"。应降级返回空结果，
  // 而不是让检索流程中断（provider 层记 "判例检索异常"）。
  const huge = "发明".repeat(30000);
  const hits = engine.search(huge);
  assert.equal(hits.length, 0, "超长 LIKE 模式应降级空结果而非抛异常");
});

test("P4 #9b: semantic 未 ready 时 searchSemantic 触发预热（死门修复）", async t => {
  // 独立 fixture（documents/chunks/embeddings 三表，dim=4，与
  // embeddings-async-load.spec.ts 同构）：engine 注入未加载的真实
  // KnowledgeEmbeddingSearch → searchSemantic 应触发预热（tryWarm），
  // 而不是静默跳过让语义路永久死亡。
  const dir = mkdtempSync(join(tmpdir(), "case-law-semantic-"));
  const dbPath = join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent',
      title TEXT NOT NULL, file_path TEXT, module TEXT, priority TEXT, level TEXT, publish_date TEXT,
      case_number TEXT, court TEXT, decision_number TEXT, article_number TEXT, content_hash TEXT,
      indexed_at TEXT NOT NULL, char_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id),
      chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL, char_count INTEGER DEFAULT 0
    );
    CREATE TABLE embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, chunk_id INTEGER NOT NULL, document_id TEXT NOT NULL, vector BLOB NOT NULL, model TEXT NOT NULL DEFAULT 'bge-m3', dim INTEGER NOT NULL DEFAULT 4, indexed_at TEXT NOT NULL, norm REAL NOT NULL DEFAULT 0.0);
  `);
  db.prepare(
    `INSERT INTO documents (id, source, doc_type, title, indexed_at) VALUES ('d1', 'raw', 'case', '专利无效复审决定', '2026-01-01')`,
  ).run();
  const chunkId = db
    .prepare(`INSERT INTO chunks (document_id, chunk_index, chunk_type, content) VALUES ('d1', 0, 'text', '内容')`)
    .run().lastInsertRowid as number;
  const buf = Buffer.alloc(4 * 4);
  [1, 0, 0, 0].forEach((v, j) => buf.writeFloatLE(v, j * 4));
  db.prepare(
    `INSERT INTO embeddings (chunk_id, document_id, vector, dim, norm, indexed_at) VALUES (?, 'd1', ?, 4, 1.0, '2026-01-01')`,
  ).run(chunkId, buf);
  db.close();

  const engine = new CaseLawSearchEngine(dbPath);
  const embeddings = new KnowledgeEmbeddingSearch({ dbPath, logger: { warn: () => {} }, docTypes: ["case"] });
  t.after(() => {
    engine.close();
    embeddings.close();
    rmSync(dir, { recursive: true, force: true });
  });
  engine.setSemantic(createCaseLawSemanticSource(async texts => texts.map(() => [1, 0, 0, 0]), embeddings));

  assert.equal(embeddings.ready, false, "前置：语义矩阵未加载");
  const first = await engine.searchSemantic("创造性", 5);
  assert.deepEqual(first, [], "未 ready 时语义路跳过（无 embed 浪费）");
  // 死门修复：searchSemantic 应已触发后台预热——等待同一单飞完成
  await embeddings.loadAsync();
  assert.equal(embeddings.ready, true, "searchSemantic 应触发预热（预热通道不被关闭）");
  // 预热完成后语义路正常命中
  const second = await engine.searchSemantic("创造性", 5);
  assert.ok(second.length >= 1, "预热完成后语义路应命中");
  assert.equal(second[0]!.documentId, "d1");
  assert.equal(second[0]!.via, "semantic");
});
