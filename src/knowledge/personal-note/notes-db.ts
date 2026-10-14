/**
 * sati-notes.db —— Sati 自有笔记/草稿真源库（WS2.1）。
 *
 * 背景：knowledge.db 是 XiaoNuo 管道产物，更新模式为文件级整体替换
 * （build-local-data.ts：有库跳过 / --force 重建，产物拷贝覆盖）——
 * Sati 运行期写入（personal_note / 草稿）住在这里会被刷新静默清空
 * （见 docs/notes/proposed/2026-10-14-knowledge-supersede-semantics.md）。
 *
 * 架构：
 *  - sati-notes.db 是唯一真源（notes 表 = 已确认笔记；drafts 表 = 草稿闸门；
 *    meta 表 = 版本/签名/导入门控）；
 *  - knowledge.db 只承载**可重建的检索投影**（documents/chunks/docs_fts），
 *    全部现有检索路径（FTS/判例引擎/回源）读法不变；
 *  - 投影 freshness 用文件签名（size+mtime）检测：管道刷新替换 knowledge.db
 *    → 签名失配 → 写路径自动全量重投影（旧笔记恢复，草稿零丢失）。
 *
 * 一次性导入：首次打开 sidecar 时从 knowledge.db 导入存量 personal_note
 * 与旧版 knowledge_drafts（meta import_v1 门控，不重复导入）。
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerChunkUncompress } from "../shared/chunk-compression.js";
import { openKnowledgeDb } from "../shared/db-version.js";
import { KNOWLEDGE_DB } from "../shared/schema-versions.js";
import { insertPersonalNoteDocument } from "./note-document.js";

/** 库身份魔数（"NOTE"）。 */
export const NOTES_DB_APPLICATION_ID = 0x4e4f5445;

/** 当前 schema 版本（迁移阶梯见 MIGRATIONS）。 */
export const NOTES_DB_SCHEMA_VERSION = 1;

const META_IMPORT_V1 = "import_v1";
const META_KNOWLEDGE_SIG = "knowledge_sig";

const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  db => {
    db.exec(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        project TEXT,
        session_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmed_at TEXT
      );
      CREATE TABLE drafts (
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
      CREATE UNIQUE INDEX uq_drafts_pending_session ON drafts(session_id) WHERE status = 'pending';
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  },
];

function migrate(db: DatabaseSync): void {
  const appId = (db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id;
  if (appId !== 0 && appId !== NOTES_DB_APPLICATION_ID) {
    throw new Error(`application_id 为 ${appId}，不是 sati-notes 库（期望 ${NOTES_DB_APPLICATION_ID}）`);
  }
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version > NOTES_DB_SCHEMA_VERSION) {
    throw new Error(
      `sati-notes 库版本（${version}）高于当前程序支持（${NOTES_DB_SCHEMA_VERSION}），请升级 Sati 后重试`,
    );
  }
  for (let v = version; v < NOTES_DB_SCHEMA_VERSION; v += 1) {
    MIGRATIONS[v]?.(db);
  }
  db.exec(`PRAGMA user_version = ${NOTES_DB_SCHEMA_VERSION}`);
  db.exec(`PRAGMA application_id = ${NOTES_DB_APPLICATION_ID}`);
}

/** knowledge.db 文件签名（size+mtime）：整体替换后必然失配。 */
function statSignature(dbPath: string): string {
  const stat = statSync(dbPath);
  return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
}

function readMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

type LegacyNoteRow = {
  id: string;
  title: string;
  indexed_at: string;
  chunk_index: number;
  content: string;
};

/**
 * 一次性导入（import_v1 门控）：knowledge.db 存量 personal_note → notes 表；
 * 旧版 knowledge_drafts 表（WS2 早期版本）→ drafts 表。任一来源读取失败
 * 不阻断 sidecar 创建（记录后继续，存量可后续手工迁移）。
 */
function importFromKnowledgeDb(db: DatabaseSync, knowledgeDbPath: string | undefined): void {
  if (!knowledgeDbPath || !existsSync(knowledgeDbPath)) return;
  try {
    const opened = openKnowledgeDb(knowledgeDbPath, KNOWLEDGE_DB, { readOnly: true });
    const kdb = opened.db;
    try {
      registerChunkUncompress(kdb);
      // 存量 personal_note → notes（按 id 去重，content 按 chunk_index 聚合）。
      const rows = kdb
        .prepare(
          `SELECT d.id AS id, d.title AS title, d.indexed_at AS indexed_at,
                  c.chunk_index AS chunk_index, sati_uncompress(c.content) AS content
           FROM documents d JOIN chunks c ON c.document_id = d.id
           WHERE d.source = 'project' AND d.doc_type = 'personal_note'
           ORDER BY d.id, c.chunk_index ASC`,
        )
        .all() as unknown as LegacyNoteRow[];
      const byId = new Map<string, { title: string; indexedAt: string; parts: string[] }>();
      for (const row of rows) {
        let entry = byId.get(row.id);
        if (!entry) {
          entry = { title: row.title, indexedAt: row.indexed_at, parts: [] };
          byId.set(row.id, entry);
        }
        entry.parts.push(row.content);
      }
      const insertNote = db.prepare(
        `INSERT INTO notes (id, title, content, created_at, updated_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      );
      for (const [id, note] of byId) {
        insertNote.run(id, note.title, note.parts.join("\n"), note.indexedAt, note.indexedAt, note.indexedAt);
      }
      // 旧版 knowledge_drafts（WS2 早期落在 knowledge.db 的草稿）→ drafts。
      const hasLegacyDrafts =
        (
          kdb
            .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='knowledge_drafts'")
            .get() as { c: number }
        ).c > 0;
      if (hasLegacyDrafts) {
        const legacyDrafts = kdb.prepare("SELECT * FROM knowledge_drafts").all() as Array<Record<string, unknown>>;
        const insertDraft = db.prepare(
          `INSERT INTO drafts (id, session_id, title, content, project, status, reject_reason, document_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        );
        for (const draft of legacyDrafts) {
          insertDraft.run(
            String(draft.id),
            String(draft.session_id),
            String(draft.title),
            String(draft.content),
            draft.project === null || draft.project === undefined ? null : String(draft.project),
            String(draft.status ?? "pending"),
            draft.reject_reason === null || draft.reject_reason === undefined ? null : String(draft.reject_reason),
            draft.document_id === null || draft.document_id === undefined ? null : String(draft.document_id),
            String(draft.created_at),
            String(draft.updated_at),
          );
        }
      }
    } finally {
      kdb.close();
    }
  } catch {
    // 导入失败不阻断 sidecar 创建（真源从本库开始累积；存量导入可手工重放）。
  }
  writeMeta(db, META_IMPORT_V1, "1");
}

/**
 * 打开（不存在则创建）sati-notes.db：建目录、跑迁移阶梯、按需一次性导入。
 * 返回**调用方持有**的连接（须 close()）。
 */
export function ensureNotesDb(notesDbPath: string, knowledgeDbPath?: string): DatabaseSync {
  mkdirSync(dirname(notesDbPath), { recursive: true });
  const db = new DatabaseSync(notesDbPath);
  try {
    migrate(db);
    if (readMeta(db, META_IMPORT_V1) !== "1") {
      importFromKnowledgeDb(db, knowledgeDbPath);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * 签名检测 + 全量重投影：knowledge.db 被管道刷新替换（签名失配）时，
 * 清空旧投影并以 sidecar notes 为真源重建。投影失败抛错（调用方 fail-closed）。
 */
export function resyncProjectionIfNeeded(notesDb: DatabaseSync, knowledgeDbPath: string): void {
  const sig = statSignature(knowledgeDbPath);
  if (readMeta(notesDb, META_KNOWLEDGE_SIG) === sig) return;

  const opened = openKnowledgeDb(knowledgeDbPath, KNOWLEDGE_DB);
  const kdb = opened.db;
  try {
    const hasFts =
      (
        kdb.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='docs_fts'").get() as {
          c: number;
        }
      ).c > 0;
    kdb.exec("BEGIN");
    try {
      if (hasFts) {
        const chunkRows = kdb
          .prepare(
            `SELECT c.id AS chunk_id FROM chunks c
             JOIN documents d ON d.id = c.document_id
             WHERE d.source = 'project' AND d.doc_type = 'personal_note'`,
          )
          .all() as Array<{ chunk_id: number }>;
        const delFts = kdb.prepare("DELETE FROM docs_fts WHERE rowid = ?");
        for (const row of chunkRows) delFts.run(row.chunk_id);
      }
      kdb
        .prepare(
          "DELETE FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE source = 'project' AND doc_type = 'personal_note')",
        )
        .run();
      kdb.prepare("DELETE FROM documents WHERE source = 'project' AND doc_type = 'personal_note'").run();
      const notes = notesDb.prepare("SELECT id, title, content FROM notes ORDER BY created_at ASC").all() as Array<{
        id: string;
        title: string;
        content: string;
      }>;
      for (const note of notes) {
        insertPersonalNoteDocument(kdb, { documentId: note.id, title: note.title, content: note.content });
      }
      kdb.exec("COMMIT");
    } catch (error) {
      kdb.exec("ROLLBACK");
      throw error;
    }
  } finally {
    kdb.close();
  }
  writeMeta(notesDb, META_KNOWLEDGE_SIG, statSignature(knowledgeDbPath));
}

export type ProjectableNote = { id: string; title: string; content: string };

/**
 * 投影单条笔记到 knowledge.db（先签名检测/重投影，再幂等插入）；
 * 完成后刷新签名。任何失败抛错——调用方 fail-closed（draft 保持 pending）。
 */
export function projectNoteToKnowledgeDb(notesDb: DatabaseSync, knowledgeDbPath: string, note: ProjectableNote): void {
  resyncProjectionIfNeeded(notesDb, knowledgeDbPath);
  const opened = openKnowledgeDb(knowledgeDbPath, KNOWLEDGE_DB);
  const kdb = opened.db;
  try {
    kdb.exec("BEGIN");
    try {
      // 幂等：重试/重投影后重复投影同一 note 时跳过（主键即 noteDocumentId）。
      const exists = kdb.prepare("SELECT id FROM documents WHERE id = ?").get(note.id);
      if (!exists) {
        insertPersonalNoteDocument(kdb, { documentId: note.id, title: note.title, content: note.content });
      }
      kdb.exec("COMMIT");
    } catch (error) {
      kdb.exec("ROLLBACK");
      throw error;
    }
  } finally {
    kdb.close();
  }
  writeMeta(notesDb, META_KNOWLEDGE_SIG, statSignature(knowledgeDbPath));
}
