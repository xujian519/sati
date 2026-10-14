/**
 * knowledge_drafts 草稿闸门（WS2 / T2.1–T2.2）。
 *
 * 契约：
 *  - AI 侧（knowledge_note_save draft 模式）只写 pending 草稿；同会话单草稿
 *    覆盖（部分唯一索引兜底），不同会话互不影响；
 *  - 确认（confirm）在同一事务内写 documents + chunks + docs_fts 并回填
 *    document_id；任何一步失败整事务回滚——绝不产生孤儿行、草稿仍 pending；
 *  - 拒绝（reject）留拒痕（status + reason），保留 90 天作负记忆，超期在
 *    下次 save 时惰性清理；
 *  - 表结构用 CREATE TABLE IF NOT EXISTS 幂等创建：knowledge.db 是 XiaoNuo
 *    管道产物（KNOWLEDGE_DB 版本 1 不可 bump，否则存量 v1 库 fail-loud 拒开），
 *    加表走「写入点幂等建表」而非版本迁移。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  confirmKnowledgeDraft,
  listPendingKnowledgeDrafts,
  rejectKnowledgeDraft,
  saveKnowledgeDraft,
} from "../../src/knowledge/personal-note/drafts.js";
import { savePersonalNote } from "../../src/tool/builtin/knowledgeNoteSave.js";

function createFixture(): { dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-drafts-test-"));
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

function openReadOnly(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true });
}

test("saveKnowledgeDraft：新建 pending；同会话覆盖（仍一行）；不同会话互不影响", t => {
  const dbPath = withFixture(t);
  const first = saveKnowledgeDraft(dbPath, { sessionId: "s1", title: "t1", content: "c1" });
  assert.ok(first.draftId);
  assert.equal(first.overwrote, false);

  const second = saveKnowledgeDraft(dbPath, { sessionId: "s1", title: "t2", content: "c2" });
  assert.equal(second.overwrote, true, "同会话重复提交应覆盖同一份草稿");
  assert.equal(second.draftId, first.draftId, "覆盖复用同一草稿行（更新内容，不产生历史行）");

  saveKnowledgeDraft(dbPath, { sessionId: "s2", title: "t3", content: "c3" });

  const db = openReadOnly(dbPath);
  try {
    const pending = db.prepare("SELECT COUNT(*) AS c FROM knowledge_drafts WHERE status = 'pending'").get() as {
      c: number;
    };
    assert.equal(pending.c, 2, "s1 覆盖后 + s2 = 2 份 pending");
  } finally {
    db.close();
  }
});

test("listPendingKnowledgeDrafts：只列 pending、按 updated_at 倒序", t => {
  const dbPath = withFixture(t);
  saveKnowledgeDraft(dbPath, { sessionId: "s1", title: "旧", content: "c1" });
  saveKnowledgeDraft(dbPath, { sessionId: "s2", title: "新", content: "c2" });
  const rejected = saveKnowledgeDraft(dbPath, { sessionId: "s3", title: "拒", content: "c3" });
  rejectKnowledgeDraft(dbPath, rejected.draftId, "理由");

  const drafts = listPendingKnowledgeDrafts(dbPath);
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0]?.sessionId, "s2", "最新更新的草稿排最前");
  assert.equal(drafts[1]?.sessionId, "s1");
  assert.ok(drafts.every(d => d.status === "pending"));
});

test("confirmKnowledgeDraft：事务内写 documents+chunks+fts 并回填 document_id", t => {
  const dbPath = withFixture(t);
  const { draftId } = saveKnowledgeDraft(dbPath, {
    sessionId: "s1",
    title: "OA 答复要点",
    content: "创造性三步法论证框架",
    project: "proj-a",
  });

  const result = confirmKnowledgeDraft(dbPath, draftId);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.documentId, "确认后应回写 documentId");
  }

  const db = openReadOnly(dbPath);
  try {
    const doc = db
      .prepare("SELECT source, doc_type, title FROM documents WHERE id = ?")
      .get(result.ok ? result.documentId : "") as { source: string; doc_type: string; title: string } | undefined;
    assert.equal(doc?.source, "project");
    assert.equal(doc?.doc_type, "personal_note");
    assert.equal(doc?.title, "OA 答复要点");
    const chunk = db
      .prepare("SELECT content FROM chunks WHERE document_id = ?")
      .get(result.ok ? result.documentId : "") as { content: string } | undefined;
    assert.ok(chunk?.content.includes("三步法"));
    const fts = db.prepare("SELECT rowid FROM docs_fts WHERE docs_fts MATCH '三步法'").all() as Array<{
      rowid: number;
    }>;
    assert.ok(fts.length >= 1, "FTS 应可召回确认的笔记");
    const draft = db.prepare("SELECT status, document_id FROM knowledge_drafts WHERE id = ?").get(draftId) as {
      status: string;
      document_id: string | null;
    };
    assert.equal(draft.status, "confirmed");
    assert.equal(draft.document_id, result.ok ? result.documentId : null, "document_id 应回填");
  } finally {
    db.close();
  }
});

test("confirmKnowledgeDraft 守卫：不存在的 id / 非 pending 状态均失败且不写库", t => {
  const dbPath = withFixture(t);
  const missing = confirmKnowledgeDraft(dbPath, "no-such-id");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "draft_not_found");

  const { draftId } = saveKnowledgeDraft(dbPath, { sessionId: "s1", title: "t", content: "c" });
  rejectKnowledgeDraft(dbPath, draftId, "不要这条");
  const rejected = confirmKnowledgeDraft(dbPath, draftId);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, "draft_not_pending");

  const db = openReadOnly(dbPath);
  try {
    const docs = db.prepare("SELECT COUNT(*) AS c FROM documents").get() as { c: number };
    assert.equal(docs.c, 0, "失败的确认绝不写 documents");
  } finally {
    db.close();
  }
});

test("confirmKnowledgeDraft 原子性：documents 撞主键 → 整事务回滚，草稿仍 pending", t => {
  const dbPath = withFixture(t);
  const input = { title: "同标题", content: "同内容", project: "p" };
  // 预置同内容直写笔记：确认时 documents 插入撞主键。
  const direct = savePersonalNote(dbPath, input);
  assert.equal(direct.reason, "inserted");

  const { draftId } = saveKnowledgeDraft(dbPath, { sessionId: "s1", ...input });
  const result = confirmKnowledgeDraft(dbPath, draftId);
  assert.equal(result.ok, false, "撞主键的确认应失败");
  if (!result.ok) assert.equal(result.code, "insert_failed");

  const db = openReadOnly(dbPath);
  try {
    const draft = db.prepare("SELECT status FROM knowledge_drafts WHERE id = ?").get(draftId) as { status: string };
    assert.equal(draft.status, "pending", "失败后草稿应保持 pending 可再次确认");
    const chunks = db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number };
    assert.equal(chunks.c, 1, "回滚后 chunks 仍为预置的 1 行，无孤儿");
  } finally {
    db.close();
  }
});

test("rejectKnowledgeDraft：留拒痕；reject 不存在的 id 报 draft_not_found", t => {
  const dbPath = withFixture(t);
  const { draftId } = saveKnowledgeDraft(dbPath, { sessionId: "s1", title: "t", content: "c" });
  const result = rejectKnowledgeDraft(dbPath, draftId, "内容不准确");
  assert.equal(result.ok, true);

  const db = openReadOnly(dbPath);
  try {
    const draft = db.prepare("SELECT status, reject_reason FROM knowledge_drafts WHERE id = ?").get(draftId) as {
      status: string;
      reject_reason: string;
    };
    assert.equal(draft.status, "rejected");
    assert.equal(draft.reject_reason, "内容不准确");
  } finally {
    db.close();
  }

  const missing = rejectKnowledgeDraft(dbPath, "no-such-id");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "draft_not_found");
});

test("拒痕负记忆保留 90 天：超期 rejected 在下次 save 时被惰性清理", t => {
  const dbPath = withFixture(t);
  const { draftId } = saveKnowledgeDraft(dbPath, { sessionId: "s-old", title: "旧拒稿", content: "c" });
  rejectKnowledgeDraft(dbPath, draftId, "过时");

  // 手工把拒痕挪到 91 天前（惰性清理按 updated_at 判定）。
  const db = new DatabaseSync(dbPath);
  const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE knowledge_drafts SET updated_at = ? WHERE id = ?").run(old, draftId);
  db.close();

  saveKnowledgeDraft(dbPath, { sessionId: "s-new", title: "新草稿", content: "c2" });

  const read = openReadOnly(dbPath);
  try {
    const stale = read.prepare("SELECT COUNT(*) AS c FROM knowledge_drafts WHERE id = ?").get(draftId) as {
      c: number;
    };
    assert.equal(stale.c, 0, "超期拒痕应被清理");
  } finally {
    read.close();
  }
});
