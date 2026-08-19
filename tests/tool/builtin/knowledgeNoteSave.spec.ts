import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createKnowledgeNoteSaveTool,
  noteDocumentId,
  savePersonalNote,
} from "../../../src/tool/builtin/knowledgeNoteSave.js";
import { CaseLawSearchEngine } from "../../../src/knowledge/case-law/case-law-search.js";

/**
 * knowledge_note_save 单元测试（personal_note 反馈回路）。
 *
 * fixture 与真实 knowledge.db 的 documents/chunks/docs_fts 一致
 * （contentless trigram FTS5，rowid 即 chunks.id）。
 */

function createFixture(): { dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "note-save-test-"));
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
    CREATE VIRTUAL TABLE docs_fts USING fts5(
      title, content, module, domain, tags, tokenize='trigram', content='', contentless_delete=1
    );
  `);
  db.close();
  return { dbPath, dir };
}

function withFixture(t: test.TestContext): string {
  const { dbPath, dir } = createFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dbPath;
}

test("savePersonalNote 写入 documents + chunks + docs_fts", t => {
  const dbPath = withFixture(t);
  const result = savePersonalNote(dbPath, {
    title: "OA 答复要点：创造性三步法",
    content: "答复创造性 A22.3 时，重点论证区别特征的技术启示判断。",
    project: "proj-a",
  });
  assert.equal(result.reason, "inserted");
  assert.equal(result.saved, true);
  assert.ok(result.documentId, "应生成 documentId");

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const doc = db
      .prepare("SELECT source, doc_type, domain, title FROM documents WHERE id = ?")
      .get(result.documentId!) as { source: string; doc_type: string; domain: string; title: string };
    assert.equal(doc.source, "project", "source 应为 project 标记用户沉淀");
    assert.equal(doc.doc_type, "personal_note");
    assert.equal(doc.domain, "patent");
    const chunk = db.prepare("SELECT content FROM chunks WHERE document_id = ?").get(result.documentId!) as {
      content: string;
    };
    assert.ok(chunk.content.includes("创造性 A22.3"));
  } finally {
    db.close();
  }
});

test("幂等：同内容重复保存返回 duplicate 且不新增行", t => {
  const dbPath = withFixture(t);
  const input = { title: "t", content: "内容", project: "p" };
  const first = savePersonalNote(dbPath, input);
  const second = savePersonalNote(dbPath, input);
  assert.equal(first.reason, "inserted");
  assert.equal(second.reason, "duplicate");
  assert.equal(first.documentId, second.documentId);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM documents WHERE id = ?").get(first.documentId!) as { c: number }
    ).c;
    assert.equal(count, 1, "重复保存不应新增行");
  } finally {
    db.close();
  }
});

test("空 title/content 跳过", t => {
  const dbPath = withFixture(t);
  assert.equal(savePersonalNote(dbPath, { title: "  ", content: "x" }).reason, "skipped");
  assert.equal(savePersonalNote(dbPath, { title: "x", content: "" }).reason, "skipped");
});

test("保存后可被 CaseLawSearchEngine 全文检索召回", t => {
  // 自管清理顺序：engine.close() 必须先于 rmSync（after 钩子按注册序执行，
  // 若复用 withFixture 的 rm 钩子，Windows 上句柄未释放导致 EBUSY）。
  const { dbPath, dir } = createFixture();
  savePersonalNote(dbPath, {
    title: "无效分析结论：区别特征与预料不到效果",
    content: "无效宣告分析中，区别特征产生了预料不到的技术效果。",
    project: "proj-b",
  });
  const engine = new CaseLawSearchEngine(dbPath);
  t.after(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const hits = engine.search("预料不到的技术效果", { limit: 5 });
  assert.ok(hits.length >= 1, "FTS 应召回沉淀的笔记");
  assert.equal(hits[0]?.docType, "personal_note");
});

test("noteDocumentId 稳定且随内容变化", () => {
  const id1 = noteDocumentId("p", "t", "c");
  assert.equal(noteDocumentId("p", "t", "c"), id1, "同输入幂等");
  assert.notEqual(noteDocumentId("p", "t", "c2"), id1, "内容变化 id 变化");
  assert.notEqual(noteDocumentId("p2", "t", "c"), id1, "项目变化 id 变化");
});

test("工具 execute：正常保存返回插入消息", async t => {
  const dbPath = withFixture(t);
  const tool = createKnowledgeNoteSaveTool();
  const { makeToolContext } = await import("../context-fixture.js");
  // 通过 SATI_KNOWLEDGE_DB 注入 fixture 库路径，让 execute 命中"库存在"分支。
  // resolveKnowledgeDbPaths 每次调用实时读 env（无缓存），CI 无 ~/.sati 库也能稳定断言；
  // 写入路径由 savePersonalNote 用例覆盖，此处仅验证输入校验分支。
  const prevDb = process.env.SATI_KNOWLEDGE_DB;
  process.env.SATI_KNOWLEDGE_DB = dbPath;
  t.after(() => {
    if (prevDb === undefined) delete process.env.SATI_KNOWLEDGE_DB;
    else process.env.SATI_KNOWLEDGE_DB = prevDb;
  });
  const missing = await tool.execute(
    { title: "", content: "x" } as unknown as Parameters<typeof tool.execute>[0],
    makeToolContext(),
  );
  const text = missing.content[0]?.type === "text" ? missing.content[0].text : "";
  assert.ok(text.includes("title 与 content 均不能为空"));
});
