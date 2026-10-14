/**
 * knowledge_note_save 草稿闸门模式（WS2 / WS2.1 sidecar 版）。
 *
 * 契约：
 *  - 默认（无参）= draft 模式：execute 只写 sidecar（sati-notes.db）pending 草稿，
 *    返回「待确认」消息，knowledge.db 零触碰；direct 模式 = sidecar 真源 +
 *    knowledge.db 投影，行为与旧直写语义一致（逃生口）；
 *  - 工具 inputSchema / description 保持不变：llm-replay fixture 的
 *    toolSchemaDigest 绑定工具 schema，任何描述文本变更都会使 fixture 失配，
 *    行为差异经工具返回文本与 docs note 说明。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createKnowledgeNoteSaveTool } from "../../../src/tool/builtin/knowledgeNoteSave.js";
import { makeToolContext } from "../context-fixture.js";

function createFixture(): { notesDb: string; knowledgeDb: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "note-save-draft-test-"));
  const knowledgeDb = join(dir, "knowledge.db");
  const db = new DatabaseSync(knowledgeDb);
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
  return { notesDb: join(dir, "sati-notes.db"), knowledgeDb, dir };
}

/** 以 SATI_KNOWLEDGE_DB / SATI_NOTES_DB 重定向 knowledge 域解析（实时读 env，无缓存）。 */
function withDbEnv<T>(
  t: test.TestContext,
  paths: { notesDb: string; knowledgeDb: string },
  fn: () => Promise<T>,
): Promise<T> {
  const prevDb = process.env.SATI_KNOWLEDGE_DB;
  const prevNotes = process.env.SATI_NOTES_DB;
  process.env.SATI_KNOWLEDGE_DB = paths.knowledgeDb;
  process.env.SATI_NOTES_DB = paths.notesDb;
  t.after(() => {
    if (prevDb === undefined) delete process.env.SATI_KNOWLEDGE_DB;
    else process.env.SATI_KNOWLEDGE_DB = prevDb;
    if (prevNotes === undefined) delete process.env.SATI_NOTES_DB;
    else process.env.SATI_NOTES_DB = prevNotes;
  });
  return fn();
}

test("draft 模式（默认）：execute 写 sidecar 草稿、knowledge.db 零触碰、返回待确认消息", async t => {
  const { notesDb, knowledgeDb, dir } = createFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tool = createKnowledgeNoteSaveTool();

  const result = await withDbEnv(t, { notesDb, knowledgeDb }, () =>
    tool.execute({ title: "答复要点", content: "创造性论证框架" }, makeToolContext()),
  );

  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.ok(text.includes("草稿"), "draft 模式应告知已提交草稿");
  assert.ok(text.includes("确认"), "draft 模式应告知待确认");
  assert.equal(result.data?.reason, "draft_pending");

  const sidecar = new DatabaseSync(notesDb, { readOnly: true });
  try {
    const drafts = sidecar.prepare("SELECT COUNT(*) AS c FROM drafts WHERE status = 'pending'").get() as { c: number };
    assert.equal(drafts.c, 1, "sidecar 应有 1 份 pending 草稿");
    const notes = sidecar.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number };
    assert.equal(notes.c, 0, "草稿阶段不得写 notes 真源表");
  } finally {
    sidecar.close();
  }

  const kdb = new DatabaseSync(knowledgeDb, { readOnly: true });
  try {
    const docs = kdb.prepare("SELECT COUNT(*) AS c FROM documents").get() as { c: number };
    assert.equal(docs.c, 0, "draft 模式不得触碰 knowledge.db");
  } finally {
    kdb.close();
  }
});

test("draft 模式：同会话二次提交覆盖草稿（仍一行）", async t => {
  const { notesDb, knowledgeDb, dir } = createFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tool = createKnowledgeNoteSaveTool();

  await withDbEnv(t, { notesDb, knowledgeDb }, async () => {
    await tool.execute({ title: "第一版", content: "c1" }, makeToolContext({ sessionId: "s1" }));
    await tool.execute({ title: "第二版", content: "c2" }, makeToolContext({ sessionId: "s1" }));
  });

  const sidecar = new DatabaseSync(notesDb, { readOnly: true });
  try {
    const drafts = sidecar
      .prepare("SELECT title FROM drafts WHERE session_id = 's1' AND status = 'pending'")
      .all() as Array<{ title: string }>;
    assert.equal(drafts.length, 1, "同会话只保留一份 pending 草稿");
    assert.equal(drafts[0]?.title, "第二版", "内容应为覆盖后的版本");
  } finally {
    sidecar.close();
  }
});

test("direct 模式（逃生口）：sidecar 真源 + knowledge.db 投影，保持旧直写语义", async t => {
  const { notesDb, knowledgeDb, dir } = createFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tool = createKnowledgeNoteSaveTool({ saveMode: "direct" });

  const result = await withDbEnv(t, { notesDb, knowledgeDb }, () =>
    tool.execute({ title: "直写笔记", content: "立即入库" }, makeToolContext()),
  );

  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.ok(text.includes("已沉淀"), "direct 模式保持既有「已沉淀」消息");
  assert.equal(result.data?.reason, "inserted");

  const kdb = new DatabaseSync(knowledgeDb, { readOnly: true });
  try {
    const docs = kdb.prepare("SELECT COUNT(*) AS c FROM documents WHERE doc_type = 'personal_note'").get() as {
      c: number;
    };
    assert.equal(docs.c, 1, "direct 模式应投影到 knowledge.db documents 层");
  } finally {
    kdb.close();
  }
  const sidecar = new DatabaseSync(notesDb, { readOnly: true });
  try {
    const notes = sidecar.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number };
    assert.equal(notes.c, 1, "direct 模式真源落 sidecar notes 表");
    const drafts = sidecar.prepare("SELECT COUNT(*) AS c FROM drafts").get() as { c: number };
    assert.equal(drafts.c, 0, "direct 模式不产生草稿");
  } finally {
    sidecar.close();
  }
});

test("两模式共享输入校验：空 title/content 报错，不写任何状态", async t => {
  const { notesDb, knowledgeDb, dir } = createFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  for (const saveMode of [undefined, "direct" as const, "draft" as const]) {
    const tool = createKnowledgeNoteSaveTool(saveMode === undefined ? undefined : { saveMode });
    const result = await withDbEnv(t, { notesDb, knowledgeDb }, () =>
      tool.execute({ title: "", content: "x" } as unknown as Parameters<typeof tool.execute>[0], makeToolContext()),
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.ok(text.includes("title 与 content 均不能为空"), `模式 ${String(saveMode)} 应报校验错`);
  }

  // 全部 execute 均在校验分支返回，sidecar 可能尚未创建——先 ensure 再只读统计。
  const { ensureNotesDb } = await import("../../../src/knowledge/personal-note/notes-db.js");
  ensureNotesDb(notesDb).close();
  const sidecar = new DatabaseSync(notesDb, { readOnly: true });
  try {
    const notes = sidecar.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number };
    assert.equal(notes.c, 0);
    const drafts = sidecar.prepare("SELECT COUNT(*) AS c FROM drafts").get() as { c: number };
    assert.equal(drafts.c, 0);
  } finally {
    sidecar.close();
  }
});
