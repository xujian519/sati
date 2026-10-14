/**
 * `/api/web/knowledge-drafts` HTTP 路由（WS2 / T2.4 确认通道）。
 *
 * 走 GatewayServer 既有 `/api/web/*` HTTP 面（Bearer token 鉴权），**不新增
 * WebSocket 协议帧**（D2 决策：避开协议版本与事件矩阵成本）。
 *
 * 契约：
 *  - GET    /api/web/knowledge-drafts        → { drafts: pending[] }
 *  - POST   /api/web/knowledge-drafts/confirm { id } → { ok, documentId }
 *  - POST   /api/web/knowledge-drafts/reject  { id, reason? } → { ok }
 *  - knowledge.db 缺失 → 404 knowledge_db_not_found（降级不静默）；
 *  - 守卫错误透传：draft_not_found → 404，draft_not_pending → 409。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { handleWebApiRequest } from "../../src/adapters/web/httpRouter.js";
import { saveKnowledgeDraft } from "../../src/knowledge/personal-note/drafts.js";
import type { Gateway } from "../../src/gateway/protocol/types.js";

const TOKEN = "test-token";

function mockRequest(method: string, url: string, body?: unknown, token?: string): IncomingMessage {
  const bodyBuffer = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return {
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    async *[Symbol.asyncIterator]() {
      if (bodyBuffer) yield bodyBuffer;
    },
  } as unknown as IncomingMessage;
}

type CapturedResponse = {
  response: ServerResponse;
  statusCode: number;
  jsonBody: unknown;
};

function mockResponse(): CapturedResponse {
  const captured: CapturedResponse = {
    response: undefined as unknown as ServerResponse,
    statusCode: 0,
    jsonBody: undefined,
  };
  captured.response = {
    writeHead(code: number) {
      captured.statusCode = code;
      return this;
    },
    end(body?: string) {
      if (body) captured.jsonBody = JSON.parse(body);
    },
  } as unknown as ServerResponse;
  return captured;
}

async function call(method: string, url: string, body?: unknown, token: string | undefined = TOKEN) {
  const res = mockResponse();
  const handled = await handleWebApiRequest(mockRequest(method, url, body, token), res.response, {
    gateway: {} as Gateway,
    token: TOKEN,
  });
  return { handled, ...res };
}

function createFixture(): { dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "web-drafts-test-"));
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
    CREATE VIRTUAL TABLE docs_fts USING fts5(
      title, content, module, domain, tags, tokenize='trigram', content='', contentless_delete=1
    );
  `);
  db.close();
  return { dbPath, dir };
}

function withKnowledgeDb(t: test.TestContext, dbPath: string): void {
  const prev = process.env.SATI_KNOWLEDGE_DB;
  process.env.SATI_KNOWLEDGE_DB = dbPath;
  t.after(() => {
    if (prev === undefined) delete process.env.SATI_KNOWLEDGE_DB;
    else process.env.SATI_KNOWLEDGE_DB = prev;
  });
}

test("Bearer 错误 → 401，不触及业务", async t => {
  const { dbPath, dir } = createFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  withKnowledgeDb(t, dbPath);
  const res = await call("GET", "/api/web/knowledge-drafts", undefined, "wrong-token");
  assert.equal(res.handled, true);
  assert.equal(res.statusCode, 401);
});

test("GET 列出 pending 草稿", async t => {
  const { dbPath, dir } = createFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  withKnowledgeDb(t, dbPath);
  saveKnowledgeDraft(dbPath, { sessionId: "s1", title: "草稿一", content: "c1" });

  const res = await call("GET", "/api/web/knowledge-drafts");
  assert.equal(res.statusCode, 200);
  const body = res.jsonBody as { drafts: Array<{ title: string; sessionId: string }> };
  assert.equal(body.drafts.length, 1);
  assert.equal(body.drafts[0]?.title, "草稿一");
});

test("knowledge.db 缺失 → 404 knowledge_db_not_found（降级不静默）", async t => {
  withKnowledgeDb(t, join(mkdtempSync(join(tmpdir(), "web-drafts-missing-")), "no-such.db"));
  const res = await call("GET", "/api/web/knowledge-drafts");
  assert.equal(res.statusCode, 404);
  const body = res.jsonBody as { error: { code: string } };
  assert.equal(body.error.code, "knowledge_db_not_found");
});

test("knowledge.db 损坏 → 500 knowledge_drafts_error（fail-closed 可观测）", async t => {
  const dir = mkdtempSync(join(tmpdir(), "web-drafts-corrupt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const badPath = join(dir, "bad.db");
  writeFileSync(badPath, "not a sqlite database");
  withKnowledgeDb(t, badPath);
  const res = await call("GET", "/api/web/knowledge-drafts");
  assert.equal(res.statusCode, 500);
  const body = res.jsonBody as { error: { code: string } };
  assert.equal(body.error.code, "knowledge_drafts_error");
});

test("POST confirm：合法草稿 → 200 且文档入库；无 id body → 400", async t => {
  const { dbPath, dir } = createFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  withKnowledgeDb(t, dbPath);
  const { draftId } = saveKnowledgeDraft(dbPath, { sessionId: "s1", title: "确认我", content: "正文" });

  const ok = await call("POST", "/api/web/knowledge-drafts/confirm", { id: draftId });
  assert.equal(ok.statusCode, 200);
  const body = ok.jsonBody as { ok: boolean; documentId: string };
  assert.equal(body.ok, true);
  assert.ok(body.documentId);

  const bad = await call("POST", "/api/web/knowledge-drafts/confirm", {});
  assert.equal(bad.statusCode, 400);
});

test("POST confirm：未知 id → 404；已 reject → 409", async t => {
  const { dbPath, dir } = createFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  withKnowledgeDb(t, dbPath);
  const { draftId } = saveKnowledgeDraft(dbPath, { sessionId: "s1", title: "t", content: "c" });
  await call("POST", "/api/web/knowledge-drafts/reject", { id: draftId, reason: "不要" });

  const missing = await call("POST", "/api/web/knowledge-drafts/confirm", { id: "no-such" });
  assert.equal(missing.statusCode, 404);

  const notPending = await call("POST", "/api/web/knowledge-drafts/confirm", { id: draftId });
  assert.equal(notPending.statusCode, 409);
  const body = notPending.jsonBody as { error: { code: string } };
  assert.equal(body.error.code, "draft_not_pending");
});

test("POST reject：无 reason 也可拒绝（reason 可选）", async t => {
  const { dbPath, dir } = createFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  withKnowledgeDb(t, dbPath);
  const { draftId } = saveKnowledgeDraft(dbPath, { sessionId: "s1", title: "t", content: "c" });

  const res = await call("POST", "/api/web/knowledge-drafts/reject", { id: draftId });
  assert.equal(res.statusCode, 200);
});
