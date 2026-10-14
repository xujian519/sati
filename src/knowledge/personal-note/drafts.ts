/**
 * knowledge_drafts 草稿闸门（WS2）：AI 沉淀先入草稿、人确认后入库。
 *
 * 设计来源：dsh-patent-workbench 的 task_drafts 草稿闸门（AI 只写 pending，
 * 用户确认才真入库；拒绝留拒痕作负记忆）。取舍记录见
 * docs/notes/implemented/2026-10-14-knowledge-draft-gate.md。
 *
 * 关键约束：
 *  - 同会话单 pending 草稿（部分唯一索引兜底并发），重复提交覆盖内容；
 *  - confirm 在同一事务内写 documents + chunks + docs_fts 并回填 document_id，
 *    任何失败整事务回滚——绝不产生孤儿行、草稿保持 pending 可重试；
 *  - 拒痕（rejected + reason）保留 90 天作负记忆，超期在下次 save 时惰性清理；
 *  - 表用 CREATE TABLE IF NOT EXISTS 幂等创建：knowledge.db 是 XiaoNuo 管道产物
 *    （KNOWLEDGE_DB 版本 1 的 source 库不可 bump 版本，否则存量库 fail-loud 拒开），
 *    加表走「写入点幂等建表」（与既有 docs_fts hasFts 探测同先例）。
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openKnowledgeDb } from "../shared/db-version.js";
import { KNOWLEDGE_DB } from "../shared/schema-versions.js";
import { insertPersonalNoteDocument, noteDocumentId } from "./note-document.js";

export type KnowledgeDraftStatus = "pending" | "confirmed" | "rejected";

export type KnowledgeDraftRecord = {
  id: string;
  sessionId: string;
  title: string;
  content: string;
  project?: string;
  status: KnowledgeDraftStatus;
  rejectReason?: string;
  /** confirm 成功后回填的 documents.id。 */
  documentId?: string;
  createdAt: string;
  updatedAt: string;
};

export type SaveKnowledgeDraftInput = {
  sessionId: string;
  title: string;
  content: string;
  project?: string;
};

export type SaveKnowledgeDraftResult = {
  draftId: string;
  /** true = 覆盖了同会话既有 pending 草稿。 */
  overwrote: boolean;
};

export type DraftMutationError = {
  ok: false;
  code: "draft_not_found" | "draft_not_pending" | "insert_failed";
  message: string;
};

export type ConfirmKnowledgeDraftResult = { ok: true; documentId: string } | DraftMutationError;
export type RejectKnowledgeDraftResult = { ok: true } | DraftMutationError;

/** 拒痕（负记忆）保留期：90 天，超期在下次 save 时惰性清理。 */
const REJECTED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** 幂等建表（部分唯一索引：每会话最多一份 pending 草稿）。 */
function ensureDraftsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_drafts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      project TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      document_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_drafts_pending_session
      ON knowledge_drafts(session_id) WHERE status = 'pending';
  `);
}

function openDraftsDb(dbPath: string): DatabaseSync {
  const opened = openKnowledgeDb(dbPath, KNOWLEDGE_DB);
  ensureDraftsTable(opened.db);
  return opened.db;
}

type DraftRow = {
  id: string;
  session_id: string;
  title: string;
  content: string;
  project: string | null;
  status: KnowledgeDraftStatus;
  reject_reason: string | null;
  document_id: string | null;
  created_at: string;
  updated_at: string;
};

function toRecord(row: DraftRow): KnowledgeDraftRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    content: row.content,
    project: row.project ?? undefined,
    status: row.status,
    rejectReason: row.reject_reason ?? undefined,
    documentId: row.document_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 惰性清理超期拒痕（负记忆保留 90 天）；在 save 事务内顺带执行。 */
function pruneStaleRejected(db: DatabaseSync, now: Date): void {
  const cutoff = new Date(now.getTime() - REJECTED_RETENTION_MS).toISOString();
  db.prepare("DELETE FROM knowledge_drafts WHERE status = 'rejected' AND updated_at < ?").run(cutoff);
}

/**
 * 保存草稿：同会话已有 pending 则覆盖（更新内容、保留 id 与 created_at），
 * 否则新建。多步写入在同一事务内（含拒痕清理）。
 */
export function saveKnowledgeDraft(dbPath: string, input: SaveKnowledgeDraftInput): SaveKnowledgeDraftResult {
  const db = openDraftsDb(dbPath);
  try {
    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
      pruneStaleRejected(db, new Date(now));
      const existing = db
        .prepare("SELECT id FROM knowledge_drafts WHERE session_id = ? AND status = 'pending'")
        .get(input.sessionId) as { id: string } | undefined;
      if (existing) {
        db.prepare("UPDATE knowledge_drafts SET title = ?, content = ?, project = ?, updated_at = ? WHERE id = ?").run(
          input.title,
          input.content,
          input.project ?? null,
          now,
          existing.id,
        );
        db.exec("COMMIT");
        return { draftId: existing.id, overwrote: true };
      }
      const draftId = randomUUID();
      db.prepare(
        `INSERT INTO knowledge_drafts (id, session_id, title, content, project, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(draftId, input.sessionId, input.title, input.content, input.project ?? null, now, now);
      db.exec("COMMIT");
      return { draftId, overwrote: false };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

/** 列出 pending 草稿（updated_at 倒序，默认上限 100 条）。 */
export function listPendingKnowledgeDrafts(dbPath: string, options: { limit?: number } = {}): KnowledgeDraftRecord[] {
  const limit = options.limit ?? 100;
  const db = openDraftsDb(dbPath);
  try {
    const rows = db
      .prepare("SELECT * FROM knowledge_drafts WHERE status = 'pending' ORDER BY updated_at DESC, rowid DESC LIMIT ?")
      .all(limit) as unknown as DraftRow[];
    return rows.map(toRecord);
  } finally {
    db.close();
  }
}

/**
 * 确认草稿入库：同一事务内写 documents + chunks + docs_fts 并回填
 * document_id；任何失败 ROLLBACK（草稿保持 pending 可重试，无孤儿行）。
 */
export function confirmKnowledgeDraft(dbPath: string, draftId: string): ConfirmKnowledgeDraftResult {
  const db = openDraftsDb(dbPath);
  try {
    db.exec("BEGIN");
    try {
      const draft = db.prepare("SELECT * FROM knowledge_drafts WHERE id = ?").get(draftId) as unknown as
        | DraftRow
        | undefined;
      if (!draft) {
        db.exec("ROLLBACK");
        return { ok: false, code: "draft_not_found", message: `草稿不存在：${draftId}` };
      }
      if (draft.status !== "pending") {
        db.exec("ROLLBACK");
        return { ok: false, code: "draft_not_pending", message: `草稿状态为 ${draft.status}，不能确认` };
      }
      const documentId = noteDocumentId(draft.project ?? undefined, draft.title, draft.content);
      try {
        insertPersonalNoteDocument(db, { documentId, title: draft.title, content: draft.content });
      } catch (error) {
        db.exec("ROLLBACK");
        return {
          ok: false,
          code: "insert_failed",
          message: `笔记入库失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      db.prepare("UPDATE knowledge_drafts SET status = 'confirmed', document_id = ?, updated_at = ? WHERE id = ?").run(
        documentId,
        new Date().toISOString(),
        draftId,
      );
      db.exec("COMMIT");
      return { ok: true, documentId };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

/** 拒绝草稿：留拒痕（reason 可选），保留 90 天作负记忆。 */
export function rejectKnowledgeDraft(dbPath: string, draftId: string, reason?: string): RejectKnowledgeDraftResult {
  const db = openDraftsDb(dbPath);
  try {
    const draft = db.prepare("SELECT status FROM knowledge_drafts WHERE id = ?").get(draftId) as
      | { status: KnowledgeDraftStatus }
      | undefined;
    if (!draft) {
      return { ok: false, code: "draft_not_found", message: `草稿不存在：${draftId}` };
    }
    if (draft.status !== "pending") {
      return { ok: false, code: "draft_not_pending", message: `草稿状态为 ${draft.status}，不能拒绝` };
    }
    db.prepare("UPDATE knowledge_drafts SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ?").run(
      reason ?? null,
      new Date().toISOString(),
      draftId,
    );
    return { ok: true };
  } finally {
    db.close();
  }
}
