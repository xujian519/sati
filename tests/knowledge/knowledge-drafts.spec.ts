/**
 * sati-notes.db 草稿闸门 + 检索投影（WS2.1）。
 *
 * 契约：
 *  - Sati 自有 sidecar（sati-notes.db，env SATI_NOTES_DB）是草稿与笔记的唯一
 *    真源；knowledge.db（XiaoNuo 管道产物，文件级整体替换）只承载可重建的
 *    检索投影（documents/chunks/docs_fts）；
 *  - 草稿 save/list/reject 只写 sidecar，绝不碰 knowledge.db；
 *  - confirm 先把笔记投影进 knowledge.db（幂等：撞主键视为已投影），再标记
 *    sidecar confirmed；投影前做签名检测——knowledge.db 被产物刷新替换后
 *    自动全量重投影（旧笔记恢复 + 新笔记入库），草稿零丢失；
 *  - 首次打开 sidecar 时一次性导入 knowledge.db 存量 personal_note 与
 *    旧版 knowledge_drafts（meta import_v1 门控，不重复导入）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  confirmKnowledgeDraft,
  listPendingKnowledgeDrafts,
  rejectKnowledgeDraft,
  saveKnowledgeDraft,
} from "../../src/knowledge/personal-note/drafts.js";
import { ensureNotesDb } from "../../src/knowledge/personal-note/notes-db.js";

function createKnowledgeFixture(dir: string): string {
  const dbPath = join(dir, "knowledge.db");
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
  return dbPath;
}

function withTwoDbFixture(t: test.TestContext): { notesDb: string; knowledgeDb: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "notes-sidecar-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { notesDb: join(dir, "sati-notes.db"), knowledgeDb: createKnowledgeFixture(dir), dir };
}

function openReadOnly(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true });
}

test("saveKnowledgeDraft：只写 sidecar，不碰 knowledge.db；同会话覆盖复用草稿行", t => {
  const { notesDb, knowledgeDb } = withTwoDbFixture(t);
  const first = saveKnowledgeDraft(notesDb, { sessionId: "s1", title: "t1", content: "c1" });
  assert.ok(first.draftId);
  assert.equal(first.overwrote, false);

  const second = saveKnowledgeDraft(notesDb, { sessionId: "s1", title: "t2", content: "c2" });
  assert.equal(second.overwrote, true);
  assert.equal(second.draftId, first.draftId, "覆盖复用同一草稿行");

  saveKnowledgeDraft(notesDb, { sessionId: "s2", title: "t3", content: "c3" });

  // knowledge.db 零触碰：草稿全程只住 sidecar。
  const kdb = openReadOnly(knowledgeDb);
  try {
    const docs = kdb.prepare("SELECT COUNT(*) AS c FROM documents").get() as { c: number };
    assert.equal(docs.c, 0, "knowledge.db 不得出现草稿相关内容");
  } finally {
    kdb.close();
  }

  const sidecar = openReadOnly(notesDb);
  try {
    const pending = sidecar.prepare("SELECT COUNT(*) AS c FROM drafts WHERE status = 'pending'").get() as { c: number };
    assert.equal(pending.c, 2, "s1 覆盖后 + s2 = 2 份 pending");
  } finally {
    sidecar.close();
  }
});

test("listPendingKnowledgeDrafts：只列 pending、按 updated_at 倒序", t => {
  const { notesDb } = withTwoDbFixture(t);
  saveKnowledgeDraft(notesDb, { sessionId: "s1", title: "旧", content: "c1" });
  saveKnowledgeDraft(notesDb, { sessionId: "s2", title: "新", content: "c2" });
  const rejected = saveKnowledgeDraft(notesDb, { sessionId: "s3", title: "拒", content: "c3" });
  rejectKnowledgeDraft(notesDb, rejected.draftId, "理由");

  const drafts = listPendingKnowledgeDrafts(notesDb);
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0]?.sessionId, "s2", "最新更新的草稿排最前");
  assert.equal(drafts[1]?.sessionId, "s1");
  assert.ok(drafts.every(d => d.status === "pending"));
});

test("confirmKnowledgeDraft：投影到 knowledge.db（documents+chunks+fts）并回填 sidecar", t => {
  const { notesDb, knowledgeDb } = withTwoDbFixture(t);
  const { draftId } = saveKnowledgeDraft(notesDb, {
    sessionId: "s1",
    title: "OA 答复要点",
    content: "创造性三步法论证框架",
    project: "proj-a",
  });

  const result = confirmKnowledgeDraft({ notesDb, knowledgeDb }, draftId);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.documentId, "确认后应回写 documentId");

  const kdb = openReadOnly(knowledgeDb);
  try {
    const doc = kdb.prepare("SELECT source, doc_type, title FROM documents WHERE id = ?").get(result.documentId) as
      | { source: string; doc_type: string; title: string }
      | undefined;
    assert.equal(doc?.source, "project");
    assert.equal(doc?.doc_type, "personal_note");
    assert.equal(doc?.title, "OA 答复要点");
    const chunk = kdb.prepare("SELECT content FROM chunks WHERE document_id = ?").get(result.documentId) as
      | { content: string }
      | undefined;
    assert.ok(chunk?.content.includes("三步法"));
    const fts = kdb.prepare("SELECT rowid FROM docs_fts WHERE docs_fts MATCH '三步法'").all() as Array<{
      rowid: number;
    }>;
    assert.ok(fts.length >= 1, "FTS 应可召回投影的笔记");
  } finally {
    kdb.close();
  }

  const sidecar = openReadOnly(notesDb);
  try {
    const draft = sidecar.prepare("SELECT status, document_id FROM drafts WHERE id = ?").get(draftId) as {
      status: string;
      document_id: string | null;
    };
    assert.equal(draft.status, "confirmed");
    assert.equal(draft.document_id, result.documentId, "document_id 应回填");
  } finally {
    sidecar.close();
  }
});

test("confirmKnowledgeDraft 幂等重试：投影已存在（撞主键）视为成功并补记 confirmed", t => {
  const { notesDb, knowledgeDb } = withTwoDbFixture(t);
  const input = { title: "同标题", content: "同内容", project: "p" };
  const { draftId } = saveKnowledgeDraft(notesDb, { sessionId: "s1", ...input });

  // 第一次确认：投影成功、标记 confirmed。
  const first = confirmKnowledgeDraft({ notesDb, knowledgeDb }, draftId);
  assert.equal(first.ok, true);

  // 模拟 sidecar 标记失败后的重试（草稿被手工置回 pending）。
  const sidecar = new DatabaseSync(notesDb);
  sidecar.prepare("UPDATE drafts SET status = 'pending', document_id = NULL WHERE id = ?").run(draftId);
  sidecar.close();

  const retry = confirmKnowledgeDraft({ notesDb, knowledgeDb }, draftId);
  assert.equal(retry.ok, true, "投影撞主键应按幂等成功处理，不得 insert_failed");
  if (retry.ok) assert.ok(retry.documentId);
});

test("confirmKnowledgeDraft 守卫：knowledge.db 缺失 → knowledge_db_not_found；未知 id / 非 pending", t => {
  const { notesDb, dir } = withTwoDbFixture(t);
  const missingDb = join(dir, "no-such-knowledge.db");
  const { draftId } = saveKnowledgeDraft(notesDb, { sessionId: "s1", title: "t", content: "c" });

  const noDb = confirmKnowledgeDraft({ notesDb, knowledgeDb: missingDb }, draftId);
  assert.equal(noDb.ok, false);
  if (!noDb.ok) assert.equal(noDb.code, "knowledge_db_not_found");

  const missing = confirmKnowledgeDraft({ notesDb, knowledgeDb: join(dir, "knowledge.db") }, "no-such-id");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "draft_not_found");

  rejectKnowledgeDraft(notesDb, draftId, "不要");
  const rejected = confirmKnowledgeDraft({ notesDb, knowledgeDb: join(dir, "knowledge.db") }, draftId);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, "draft_not_pending");

  const kdb = openReadOnly(join(dir, "knowledge.db"));
  try {
    const docs = kdb.prepare("SELECT COUNT(*) AS c FROM documents").get() as { c: number };
    assert.equal(docs.c, 0, "失败的确认绝不写 knowledge.db");
  } finally {
    kdb.close();
  }
});

test("产物刷新（文件级替换）后：确认触发签名检测 + 全量重投影，旧笔记自动恢复", t => {
  const { notesDb, knowledgeDb, dir } = withTwoDbFixture(t);

  // 确认笔记 A 并投影。
  const draftA = saveKnowledgeDraft(notesDb, { sessionId: "s1", title: "笔记A", content: "A 的内容", project: "p" });
  const confirmA = confirmKnowledgeDraft({ notesDb, knowledgeDb }, draftA.draftId);
  assert.equal(confirmA.ok, true);

  // 模拟 XiaoNuo 管道刷新：knowledge.db 整个换成新文件（personal_note 投影丢失）。
  rmSync(knowledgeDb);
  createKnowledgeFixture(dir);
  const wiped = openReadOnly(knowledgeDb);
  try {
    const docs = wiped.prepare("SELECT COUNT(*) AS c FROM documents").get() as { c: number };
    assert.equal(docs.c, 0, "前置：刷新后投影已清空");
  } finally {
    wiped.close();
  }

  // 确认笔记 B：签名失配 → 重投影（A 恢复）+ B 入库。
  const draftB = saveKnowledgeDraft(notesDb, { sessionId: "s2", title: "笔记B", content: "B 的内容", project: "p" });
  const confirmB = confirmKnowledgeDraft({ notesDb, knowledgeDb }, draftB.draftId);
  assert.equal(confirmB.ok, true);

  const kdb = openReadOnly(knowledgeDb);
  try {
    const titles = (
      kdb.prepare("SELECT title FROM documents WHERE doc_type = 'personal_note'").all() as Array<{ title: string }>
    ).map(r => r.title);
    assert.ok(titles.includes("笔记A"), "重投影应恢复刷新前的笔记 A");
    assert.ok(titles.includes("笔记B"), "新确认的笔记 B 应入库");
  } finally {
    kdb.close();
  }
});

test("rejectKnowledgeDraft：留拒痕（90 天负记忆）；reject 不存在的 id 报 draft_not_found", t => {
  const { notesDb } = withTwoDbFixture(t);
  const { draftId } = saveKnowledgeDraft(notesDb, { sessionId: "s1", title: "t", content: "c" });
  const result = rejectKnowledgeDraft(notesDb, draftId, "内容不准确");
  assert.equal(result.ok, true);

  const sidecar = openReadOnly(notesDb);
  try {
    const draft = sidecar.prepare("SELECT status, reject_reason FROM drafts WHERE id = ?").get(draftId) as {
      status: string;
      reject_reason: string;
    };
    assert.equal(draft.status, "rejected");
    assert.equal(draft.reject_reason, "内容不准确");
  } finally {
    sidecar.close();
  }

  const missing = rejectKnowledgeDraft(notesDb, "no-such-id");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "draft_not_found");
});

test("拒痕负记忆保留 90 天：超期 rejected 在下次 save 时被惰性清理", t => {
  const { notesDb } = withTwoDbFixture(t);
  const { draftId } = saveKnowledgeDraft(notesDb, { sessionId: "s-old", title: "旧拒稿", content: "c" });
  rejectKnowledgeDraft(notesDb, draftId, "过时");

  const sidecar = new DatabaseSync(notesDb);
  const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
  sidecar.prepare("UPDATE drafts SET updated_at = ? WHERE id = ?").run(old, draftId);
  sidecar.close();

  saveKnowledgeDraft(notesDb, { sessionId: "s-new", title: "新草稿", content: "c2" });

  const read = openReadOnly(notesDb);
  try {
    const stale = read.prepare("SELECT COUNT(*) AS c FROM drafts WHERE id = ?").get(draftId) as { c: number };
    assert.equal(stale.c, 0, "超期拒痕应被清理");
  } finally {
    read.close();
  }
});

test("首次打开 sidecar：一次性导入 knowledge.db 存量 personal_note 与旧草稿（import_v1 门控）", t => {
  const { notesDb, knowledgeDb } = withTwoDbFixture(t);

  // 预置存量：knowledge.db 里有一条旧 personal_note 投影 + 一张旧版 knowledge_drafts 表。
  const kdb = new DatabaseSync(knowledgeDb);
  kdb.exec("BEGIN");
  kdb
    .prepare(
      `INSERT INTO documents (id, source, doc_type, domain, title, indexed_at, char_count, chunk_count)
     VALUES ('legacy-note-1', 'project', 'personal_note', 'patent', '存量笔记', ?, 4, 1)`,
    )
    .run(new Date().toISOString());
  kdb
    .prepare(
      `INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count)
     VALUES ('legacy-note-1', 0, 'paragraph', '存量笔记正文', 6)`,
    )
    .run();
  kdb.exec(`
    CREATE TABLE knowledge_drafts (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      project TEXT, status TEXT NOT NULL DEFAULT 'pending', reject_reason TEXT, document_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO knowledge_drafts VALUES ('legacy-draft-1', 's-old', '旧草稿', '正文', NULL, 'pending', NULL, NULL, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
  `);
  kdb.exec("COMMIT");
  kdb.close();

  // 第一次打开：导入发生。
  ensureNotesDb(notesDb, knowledgeDb);
  const sidecar = openReadOnly(notesDb);
  try {
    const note = sidecar.prepare("SELECT title, content FROM notes WHERE id = 'legacy-note-1'").get() as
      | { title: string; content: string }
      | undefined;
    assert.ok(note, "存量 personal_note 应导入 sidecar notes 表");
    assert.equal(note.content, "存量笔记正文");
    const draft = sidecar.prepare("SELECT title FROM drafts WHERE id = 'legacy-draft-1'").get() as
      | { title: string }
      | undefined;
    assert.ok(draft, "旧版 knowledge_drafts 应导入 sidecar drafts 表");
  } finally {
    sidecar.close();
  }

  // 第二次打开：不重复导入。
  ensureNotesDb(notesDb, knowledgeDb);
  const again = openReadOnly(notesDb);
  try {
    const count = again.prepare("SELECT COUNT(*) AS c FROM notes WHERE id = 'legacy-note-1'").get() as { c: number };
    assert.equal(count.c, 1, "导入须由 import_v1 门控，重复打开不得重复");
  } finally {
    again.close();
  }
});

test("ensureNotesDb：无 knowledge.db 时 sidecar 独立成库（草稿不依赖管道产物）", t => {
  const dir = mkdtempSync(join(tmpdir(), "notes-standalone-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const notesDb = join(dir, "sati-notes.db");

  ensureNotesDb(notesDb, join(dir, "no-such.db"));
  assert.equal(existsSync(notesDb), true, "sidecar 应独立创建");

  const { draftId } = saveKnowledgeDraft(notesDb, { sessionId: "s1", title: "t", content: "c" });
  assert.ok(draftId);
});
