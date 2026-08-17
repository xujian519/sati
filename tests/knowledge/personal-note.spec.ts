import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EmbeddingClient } from "../../src/model/embedding/types.js";
import { savePersonalNote } from "../../src/tool/builtin/knowledgeNoteSave.js";
import { PersonalNoteStore, PersonalNoteVectorIndex } from "../../src/knowledge/personal-note/index.js";
import { CaseLawSearchEngine } from "../../src/knowledge/case-law/case-law-search.js";

/**
 * personal_note 语义召回单元测试。
 *
 * fixture 与真实 knowledge.db 的 documents/chunks 一致（不含 docs_fts——
 * store 与 searchSemantic 不依赖 FTS；savePersonalNote 探测无 FTS 时自动跳过）。
 */

function createFixture(): { dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "personal-note-test-"));
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
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
      chunk_type TEXT NOT NULL, heading TEXT, content TEXT NOT NULL, char_count INTEGER DEFAULT 0
    );
  `);
  db.close();
  return { dbPath, dir };
}

function withFixture(t: test.TestContext): { dbPath: string; dir: string } {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  return fixture;
}

/** 插入一条非 project 对照文档（不应被 store 枚举）。 */
function insertRawCase(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("BEGIN");
  db.prepare(
    `INSERT INTO documents (id, source, doc_type, domain, title, indexed_at, char_count, chunk_count)
     VALUES ('raw-case-1', 'raw', 'case', 'patent', '某无效复审决定', ?, 10, 1)`,
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count)
     VALUES ('raw-case-1', 0, 'paragraph', '无效决定正文', 6)`,
  ).run();
  db.exec("COMMIT");
  db.close();
}

/** 概念词命中的确定性 stub embedding client（共享概念词越多余弦越高）。 */
const CONCEPTS = ["答复", "风格", "写法", "意见陈述", "检索", "通道"];
function makeStubClient(): EmbeddingClient {
  return {
    dimensions: CONCEPTS.length,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(text => CONCEPTS.map(concept => (text.includes(concept) ? 1 : 0)));
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  };
}

test("PersonalNoteStore.list 只枚举 project personal_note 并聚合正文", t => {
  const { dbPath } = withFixture(t);
  savePersonalNote(dbPath, { title: "OA 答复风格修订要点", content: "去除加粗与小标题。", project: "proj-a" });
  savePersonalNote(dbPath, { title: "专利检索通道方法", content: "CNIPA 与 Google Patents。", project: "proj-a" });
  insertRawCase(dbPath);

  const store = new PersonalNoteStore(dbPath);
  const rows = store.list();
  assert.equal(rows.length, 2, "应仅返回 2 条 project personal_note（排除 raw case）");
  assert.ok(rows.every(row => row.title.length > 0 && row.content.length > 0));
  assert.ok(rows.some(row => row.title.includes("答复风格")));
  store.close();
});

test("PersonalNoteStore.snapshotVersion 随笔记新增变化", t => {
  const { dbPath } = withFixture(t);
  const store = new PersonalNoteStore(dbPath);
  const before = store.snapshotVersion();
  savePersonalNote(dbPath, { title: "新笔记", content: "正文", project: "p" });
  const after = store.snapshotVersion();
  assert.notEqual(before, after, "新增笔记后快照版本应变化");
  store.close();
});

test("PersonalNoteStore.list 支持 LIMIT/OFFSET 分页", t => {
  const { dbPath } = withFixture(t);
  for (let i = 1; i <= 5; i++) {
    savePersonalNote(dbPath, { title: `笔记${i}`, content: `正文内容${i}`, project: "proj-a" });
  }
  const store = new PersonalNoteStore(dbPath);
  const all = store.list();
  assert.equal(all.length, 5);

  const page1 = store.list({ limit: 2 });
  assert.equal(page1.length, 2, "limit=2 应只返回 2 条");
  const page2 = store.list({ limit: 2, offset: 2 });
  assert.equal(page2.length, 2, "offset=2 后应返回后续 2 条");
  const tail = store.list({ limit: 2, offset: 4 });
  assert.equal(tail.length, 1, "末页应只返回剩余 1 条");

  const ids = [page1, page2, tail].flatMap(rows => rows.map(r => r.id));
  assert.equal(new Set(ids).size, 5, "分页各页不应重复且应覆盖全部笔记");
  assert.deepEqual(new Set(ids), new Set(all.map(r => r.id)), "分页并集应等于全量集合");
  store.close();
});

test("PersonalNoteStore.listAllPaged 与 list 全量语义一致（分页聚合）", t => {
  const { dbPath } = withFixture(t);
  for (let i = 1; i <= 5; i++) {
    savePersonalNote(dbPath, { title: `笔记${i}`, content: `正文内容${i}`, project: "proj-a" });
  }
  const store = new PersonalNoteStore(dbPath);
  const all = store.list();
  const paged = store.listAllPaged(2);
  assert.equal(paged.length, all.length, "分页拉取应与全量条数一致");
  assert.deepEqual(paged.map(r => r.id).sort(), all.map(r => r.id).sort(), "分页拉取应覆盖全部笔记");
  store.close();
});

test("PersonalNoteVectorIndex.search 语义命中沉淀笔记", async t => {
  const { dbPath, dir } = withFixture(t);
  savePersonalNote(dbPath, {
    title: "OA 答复风格修订要点",
    content: "去除加粗与小标题，采用代理人惯用写法，直接陈述意见。",
    project: "proj-a",
  });
  savePersonalNote(dbPath, {
    title: "专利检索通道方法",
    content: "CNIPA 与 Google Patents 检索通道选择。",
    project: "proj-a",
  });

  const store = new PersonalNoteStore(dbPath);
  const index = new PersonalNoteVectorIndex({
    store,
    client: makeStubClient(),
    storePath: join(dir, "personal-note.jsonl"),
  });
  const hits = await index.search("意见陈述书的写作风格应该怎么组织", 5);
  assert.ok(hits.length > 0, "语义检索应有命中");
  const top = store.list().find(row => row.id === hits[0].id);
  assert.ok(top, "top 命中应能回源到笔记");
  assert.ok(top!.title.includes("答复风格"), `top 命中应为答复风格笔记，实际 ${top!.title}`);
  store.close();
});

test("PersonalNoteVectorIndex 新增笔记后检索可召回（增量同步）", async t => {
  const { dbPath, dir } = withFixture(t);
  savePersonalNote(dbPath, { title: "初始检索方法笔记", content: "检索通道选择。", project: "p" });
  const store = new PersonalNoteStore(dbPath);
  const index = new PersonalNoteVectorIndex({
    store,
    client: makeStubClient(),
    storePath: join(dir, "personal-note.jsonl"),
  });
  // 首次检索触发全量同步（仅含初始笔记）。
  await index.search("检索", 5);

  // 沉淀新笔记（模拟 knowledge_note_save 后续写入）。
  const saved = savePersonalNote(dbPath, { title: "答复风格要点", content: "意见陈述书写法", project: "p" });
  assert.equal(saved.reason, "inserted");

  // 再次检索：快照变化触发增量同步，新笔记应可召回。
  const hits = await index.search("意见陈述 风格 写法", 5);
  assert.ok(
    hits.some(hit => hit.id === saved.documentId),
    "新沉淀笔记应在下次检索时被增量同步并可召回",
  );
  store.close();
});

test("CaseLawSearchEngine.searchSemantic 融合 personal_note 语义召回", async t => {
  const { dbPath, dir } = withFixture(t);
  const saved = savePersonalNote(dbPath, {
    title: "OA 答复风格修订要点",
    content: "去除加粗与小标题，采用代理人惯用写法，直接陈述意见。",
    project: "proj-a",
  });
  assert.equal(saved.reason, "inserted");

  const engine = new CaseLawSearchEngine(dbPath);
  const store = new PersonalNoteStore(dbPath);
  const index = new PersonalNoteVectorIndex({
    store,
    client: makeStubClient(),
    storePath: join(dir, "personal-note.jsonl"),
  });
  engine.setNoteSemantic(index);
  assert.equal(engine.semanticAvailable, true, "注入 personal_note 语义源后 semanticAvailable 应为 true");

  const hits = await engine.searchSemantic("意见陈述书的写作风格怎么组织", 5);
  const noteHit = hits.find(hit => hit.documentId === saved.documentId);
  assert.ok(noteHit, "searchSemantic 应召回沉淀笔记");
  assert.equal(noteHit!.via, "semantic");
  assert.ok(noteHit!.title.includes("答复风格"));
  engine.close();
  store.close();
});
