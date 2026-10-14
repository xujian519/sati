/**
 * 草稿闸门服务（WS2/WS2.1）：真源为 Sati 自有 sati-notes.db。
 *
 * - save / list / reject 只写 sidecar，绝不碰 knowledge.db（管道产物）；
 * - confirm 顺序：守卫 → 投影进 knowledge.db（签名检测/重投影 + 幂等插入）
 *   → sidecar 事务（notes 真源行 + 草稿标记 confirmed）。投影失败抛回
 *   projection_failed，草稿保持 pending 可重试；sidecar 失败时投影为孤儿，
 *   重试经幂等投影收敛，最终一致。
 * - 拒痕（rejected + reason）保留 90 天作负记忆，超期在下次 save 时惰性清理。
 *
 * 设计取舍记录：docs/notes/implemented/2026-10-14-knowledge-draft-gate.md
 * 与 docs/notes/proposed/2026-10-14-knowledge-supersede-semantics.md。
 */

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { noteDocumentId } from "./note-document.js";
import { ensureNotesDb, projectNoteToKnowledgeDb } from "./notes-db.js";

export type KnowledgeDraftStatus = "pending" | "confirmed" | "rejected";

export type KnowledgeDraftRecord = {
  id: string;
  sessionId: string;
  title: string;
  content: string;
  project?: string;
  status: KnowledgeDraftStatus;
  rejectReason?: string;
  /** confirm 成功后回填的 documents.id（= notes.id = noteDocumentId）。 */
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
  code: "draft_not_found" | "draft_not_pending" | "knowledge_db_not_found" | "projection_failed";
  message: string;
};

export type ConfirmKnowledgeDraftResult = { ok: true; documentId: string } | DraftMutationError;
export type RejectKnowledgeDraftResult = { ok: true } | DraftMutationError;

/** 拒痕（负记忆）保留期：90 天，超期在下次 save 时惰性清理。 */
const REJECTED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

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

function openSidecar(notesDbPath: string, knowledgeDbPath?: string): DatabaseSync {
  return ensureNotesDb(notesDbPath, knowledgeDbPath);
}

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
  db.prepare("DELETE FROM drafts WHERE status = 'rejected' AND updated_at < ?").run(cutoff);
}

/**
 * 保存草稿：同会话已有 pending 则覆盖（更新内容、保留 id 与 created_at），
 * 否则新建。只写 sidecar。
 */
export function saveKnowledgeDraft(notesDbPath: string, input: SaveKnowledgeDraftInput): SaveKnowledgeDraftResult {
  const db = openSidecar(notesDbPath);
  try {
    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
      pruneStaleRejected(db, new Date(now));
      const existing = db
        .prepare("SELECT id FROM drafts WHERE session_id = ? AND status = 'pending'")
        .get(input.sessionId) as { id: string } | undefined;
      if (existing) {
        db.prepare("UPDATE drafts SET title = ?, content = ?, project = ?, updated_at = ? WHERE id = ?").run(
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
        `INSERT INTO drafts (id, session_id, title, content, project, status, created_at, updated_at)
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

/** 列出 pending 草稿（updated_at 倒序，默认上限 100 条）。只读 sidecar。 */
export function listPendingKnowledgeDrafts(
  notesDbPath: string,
  options: { limit?: number } = {},
): KnowledgeDraftRecord[] {
  const limit = options.limit ?? 100;
  const db = openSidecar(notesDbPath);
  try {
    const rows = db
      .prepare("SELECT * FROM drafts WHERE status = 'pending' ORDER BY updated_at DESC, rowid DESC LIMIT ?")
      .all(limit) as unknown as DraftRow[];
    return rows.map(toRecord);
  } finally {
    db.close();
  }
}

/**
 * 确认草稿入库：投影进 knowledge.db（签名检测/重投影 + 幂等插入），
 * 再于 sidecar 事务内写 notes 真源行并标记 confirmed。投影失败 →
 * projection_failed（草稿保持 pending 可重试，无孤儿）。
 */
export function confirmKnowledgeDraft(
  paths: { notesDb: string; knowledgeDb: string },
  draftId: string,
): ConfirmKnowledgeDraftResult {
  if (!existsSync(paths.knowledgeDb)) {
    return { ok: false, code: "knowledge_db_not_found", message: "未找到 knowledge.db，无法投影入库" };
  }
  const db = openSidecar(paths.notesDb, paths.knowledgeDb);
  try {
    const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(draftId) as unknown as DraftRow | undefined;
    if (!draft) {
      return { ok: false, code: "draft_not_found", message: `草稿不存在：${draftId}` };
    }
    if (draft.status !== "pending") {
      return { ok: false, code: "draft_not_pending", message: `草稿状态为 ${draft.status}，不能确认` };
    }

    // 1) 投影（失败 → 草稿仍 pending，整体可重试）。
    const documentId = noteDocumentId(draft.project ?? undefined, draft.title, draft.content);
    try {
      projectNoteToKnowledgeDb(db, paths.knowledgeDb, { id: documentId, title: draft.title, content: draft.content });
    } catch (error) {
      return {
        ok: false,
        code: "projection_failed",
        message: `笔记投影失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // 2) sidecar 真源行 + 标记 confirmed（幂等：重试时 notes 已存在则跳过插入）。
    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO notes (id, title, content, project, session_id, created_at, updated_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).run(documentId, draft.title, draft.content, draft.project, draft.session_id, now, now, now);
      db.prepare("UPDATE drafts SET status = 'confirmed', document_id = ?, updated_at = ? WHERE id = ?").run(
        documentId,
        now,
        draftId,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { ok: true, documentId };
  } finally {
    db.close();
  }
}

/** 拒绝草稿：留拒痕（reason 可选），保留 90 天作负记忆。只写 sidecar。 */
export function rejectKnowledgeDraft(
  notesDbPath: string,
  draftId: string,
  reason?: string,
): RejectKnowledgeDraftResult {
  const db = openSidecar(notesDbPath);
  try {
    const draft = db.prepare("SELECT status FROM drafts WHERE id = ?").get(draftId) as
      | { status: KnowledgeDraftStatus }
      | undefined;
    if (!draft) {
      return { ok: false, code: "draft_not_found", message: `草稿不存在：${draftId}` };
    }
    if (draft.status !== "pending") {
      return { ok: false, code: "draft_not_pending", message: `草稿状态为 ${draft.status}，不能拒绝` };
    }
    db.prepare("UPDATE drafts SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ?").run(
      reason ?? null,
      new Date().toISOString(),
      draftId,
    );
    return { ok: true };
  } finally {
    db.close();
  }
}
