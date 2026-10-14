/**
 * knowledge_note_save 草稿闸门模式（WS2 / T2.3）。
 *
 * 契约：
 *  - 默认（无参）= draft 模式：execute 只写 pending 草稿，返回「待确认」消息，
 *    documents 层无新增行；direct 模式行为与现状逐字节一致（逃生口）；
 *  - 工具 inputSchema / description 保持不变：llm-replay fixture 的
 *    toolSchemaDigest 绑定工具 schema，任何描述文本变更都会使 fixture 失配，
 *    行为差异经工具返回文本与 docs note 说明（见
 *    docs/notes/implemented/2026-10-14-knowledge-draft-gate.md）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createKnowledgeNoteSaveTool } from "../../../src/tool/builtin/knowledgeNoteSave.js";
import { makeToolContext } from "../context-fixture.js";

function createFixture(): { dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "note-save-draft-test-"));
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
    CREATE TABLE knowledge_drafts (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      project TEXT, status TEXT NOT NULL DEFAULT 'pending', reject_reason TEXT, document_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  db.close();
  return { dbPath, dir };
}

/** 以 SATI_KNOWLEDGE_DB 重定向 knowledge 域解析（实时读 env，无缓存）。 */
function withKnowledgeDb<T>(t: test.TestContext, dbPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.SATI_KNOWLEDGE_DB;
  process.env.SATI_KNOWLEDGE_DB = dbPath;
  t.after(() => {
    if (prev === undefined) delete process.env.SATI_KNOWLEDGE_DB;
    else process.env.SATI_KNOWLEDGE_DB = prev;
  });
  return fn();
}

test("draft 模式（默认）：execute 写草稿、documents 无新增行、返回待确认消息", async t => {
  const { dbPath, dir } = createFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tool = createKnowledgeNoteSaveTool();

  const result = await withKnowledgeDb(t, dbPath, () =>
    tool.execute({ title: "答复要点", content: "创造性论证框架" }, makeToolContext()),
  );

  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.ok(text.includes("草稿"), "draft 模式应告知已提交草稿");
  assert.ok(text.includes("确认"), "draft 模式应告知待确认");
  assert.equal(result.data?.reason, "draft_pending");

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const docs = db.prepare("SELECT COUNT(*) AS c FROM documents").get() as { c: number };
    assert.equal(docs.c, 0, "draft 模式不得直写 documents 层");
    const drafts = db.prepare("SELECT COUNT(*) AS c FROM knowledge_drafts WHERE status = 'pending'").get() as {
      c: number;
    };
    assert.equal(drafts.c, 1, "应有 1 份 pending 草稿");
  } finally {
    db.close();
  }
});

test("draft 模式：同会话二次提交覆盖草稿（仍一行）", async t => {
  const { dbPath, dir } = createFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tool = createKnowledgeNoteSaveTool();

  await withKnowledgeDb(t, dbPath, async () => {
    await tool.execute({ title: "第一版", content: "c1" }, makeToolContext({ sessionId: "s1" }));
    await tool.execute({ title: "第二版", content: "c2" }, makeToolContext({ sessionId: "s1" }));
  });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const drafts = db
      .prepare("SELECT title FROM knowledge_drafts WHERE session_id = 's1' AND status = 'pending'")
      .all() as Array<{ title: string }>;
    assert.equal(drafts.length, 1, "同会话只保留一份 pending 草稿");
    assert.equal(drafts[0]?.title, "第二版", "内容应为覆盖后的版本");
  } finally {
    db.close();
  }
});

test("direct 模式（逃生口）：行为与现状一致——直写 documents 层", async t => {
  const { dbPath, dir } = createFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tool = createKnowledgeNoteSaveTool({ saveMode: "direct" });

  const result = await withKnowledgeDb(t, dbPath, () =>
    tool.execute({ title: "直写笔记", content: "立即入库" }, makeToolContext()),
  );

  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.ok(text.includes("已沉淀"), "direct 模式保持既有「已沉淀」消息");
  assert.equal(result.data?.reason, "inserted");

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const docs = db.prepare("SELECT COUNT(*) AS c FROM documents WHERE doc_type = 'personal_note'").get() as {
      c: number;
    };
    assert.equal(docs.c, 1, "direct 模式应立即写入 documents 层");
    const drafts = db.prepare("SELECT COUNT(*) AS c FROM knowledge_drafts").get() as { c: number };
    assert.equal(drafts.c, 0, "direct 模式不产生草稿");
  } finally {
    db.close();
  }
});

test("两模式共享输入校验：空 title/content 报错，不写任何状态", async t => {
  const { dbPath, dir } = createFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  for (const saveMode of [undefined, "direct" as const, "draft" as const]) {
    const tool = createKnowledgeNoteSaveTool(saveMode === undefined ? undefined : { saveMode });
    const result = await withKnowledgeDb(t, dbPath, () =>
      tool.execute({ title: "", content: "x" } as unknown as Parameters<typeof tool.execute>[0], makeToolContext()),
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.ok(text.includes("title 与 content 均不能为空"), `模式 ${String(saveMode)} 应报校验错`);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const docs = db.prepare("SELECT COUNT(*) AS c FROM documents").get() as { c: number };
    assert.equal(docs.c, 0);
    const drafts = db.prepare("SELECT COUNT(*) AS c FROM knowledge_drafts").get() as { c: number };
    assert.equal(drafts.c, 0);
  } finally {
    db.close();
  }
});
