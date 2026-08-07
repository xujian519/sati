/**
 * knowledge_note_save — 项目知识沉淀工具（personal_note 反馈回路）。
 *
 * 把项目产出（OA 答复要点、无效分析结论、检索心得）写入 knowledge.db
 * 的 personal_note 文档层（documents + chunks + docs_fts），使后续
 * `patent_case_search` / 语义检索可召回，实现"产出反哺知识、越用越强"。
 *
 * 知识库只读边界（显式声明）：
 * - 只写 source='project'、doc_type='personal_note' 的文档行；
 * - 不动 kg_nodes / kg_edges / law_article 等核心只读数据；
 * - knowledge.db 以短连接 + 事务写入（不持有长连接），journal_mode=delete
 *   下不影响既有关键路径的只读访问（短暂写锁，用完即关）。
 *
 * 幂等：id = sha1(project|title|content) 前 16 位，同内容重复保存直接跳过。
 */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolveKnowledgeDbPaths } from "../../knowledge/config.js";
import type { SatiToolDefinition } from "../protocol/types.js";

export type KnowledgeNoteSaveInput = {
  /** 笔记标题（≤200 字符；将作为 documents.title 与 FTS 索引词）。 */
  title: string;
  /** 笔记正文（≤20_000 字符；写入 chunks + FTS 索引）。 */
  content: string;
  /** 来源项目标签（如 projectKey，可选；参与幂等 hash 与检索过滤）。 */
  project?: string;
};

export type KnowledgeNoteSaveOutput = {
  saved: boolean;
  documentId?: string;
  reason?: "inserted" | "duplicate" | "skipped";
  charCount?: number;
};

/** 内容/标题上限（防单条笔记撑爆 FTS 与上下文）。 */
const MAX_TITLE_CHARS = 200;
const MAX_CONTENT_CHARS = 20_000;

/** 笔记 id：sha1(project|title|content) 前 16 位（幂等键）。 */
export function noteDocumentId(project: string | undefined, title: string, content: string): string {
  return createHash("sha1")
    .update(`${project ?? ""}|${title}|${content}`)
    .digest("hex")
    .slice(0, 16);
}

/** 写入实现（导出便于测试注入 dbPath）。 */
export function savePersonalNote(
  dbPath: string,
  input: KnowledgeNoteSaveInput,
): { saved: boolean; documentId?: string; reason: "inserted" | "duplicate" | "skipped"; charCount?: number } {
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title || !content) {
    return { saved: false, reason: "skipped" };
  }
  const documentId = noteDocumentId(input.project, title, content);

  // 短连接 + 事务（journal_mode=delete 下写锁短暂；用完即关）。
  const db = new DatabaseSync(dbPath);
  try {
    const existing = db.prepare("SELECT id FROM documents WHERE id = ?").get(documentId);
    if (existing) {
      return { saved: false, documentId, reason: "duplicate" };
    }
    const hasFts =
      (
        db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='docs_fts'").get() as {
          c: number;
        }
      ).c > 0;

    db.exec("BEGIN");
    try {
      const indexedAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO documents (id, source, doc_type, domain, title, indexed_at, char_count, chunk_count, content_hash)
         VALUES (?, 'project', 'personal_note', 'patent', ?, ?, ?, 1, ?)`,
      ).run(documentId, title, indexedAt, content.length, documentId);
      const chunk = db
        .prepare(
          `INSERT INTO chunks (document_id, chunk_index, chunk_type, heading, content, char_count)
           VALUES (?, 0, 'paragraph', NULL, ?, ?)`,
        )
        .run(documentId, content, content.length);
      const chunkId = Number(chunk.lastInsertRowid);
      if (hasFts) {
        // contentless FTS：仅建立索引词（rowid 即 chunks.id）。
        db.prepare(
          "INSERT INTO docs_fts (rowid, title, content, module, domain, tags) VALUES (?, ?, ?, NULL, 'patent', NULL)",
        ).run(chunkId, title, content);
      }
      db.exec("COMMIT");
      return { saved: true, documentId, reason: "inserted", charCount: content.length };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export function createKnowledgeNoteSaveTool(): SatiToolDefinition<KnowledgeNoteSaveInput, KnowledgeNoteSaveOutput> {
  return {
    name: "knowledge_note_save",
    title: "Knowledge Note Save",
    description:
      "把项目专利产出（OA 答复要点、无效分析结论、检索心得）沉淀到知识库 personal_note 层，后续检索可召回。" +
      "用于定稿后建议沉淀：如 'knowledge_note_save({title, content, project})'。只写 personal_note 文档层，不改核心只读数据。",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "笔记标题（≤200 字符，作为 FTS 索引词）" },
        content: { type: "string", description: "笔记正文（≤20,000 字符）" },
        project: { type: "string", description: "来源项目标签（可选，参与幂等与检索过滤）" },
      },
      required: ["title", "content"],
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    checkAvailability: () => {
      const { knowledgeDb } = resolveKnowledgeDbPaths();
      if (!knowledgeDb || !existsSync(knowledgeDb)) {
        return {
          ok: false,
          code: "setup_required",
          reason: "未找到 knowledge.db（默认路径 ~/.sati/knowledge/knowledge.db，可用 SATI_KNOWLEDGE_DB 指定）",
        };
      }
      return { ok: true };
    },
    execute: async (input: KnowledgeNoteSaveInput) => {
      const { knowledgeDb } = resolveKnowledgeDbPaths();
      if (!knowledgeDb || !existsSync(knowledgeDb)) {
        return {
          content: [
            {
              type: "text",
              text: "错误：未找到 knowledge.db，无法沉淀笔记。请配置 SATI_KNOWLEDGE_DB 或放入默认目录 ~/.sati/knowledge/。",
            },
          ],
          metadata: { error: "knowledge_db_not_found" },
        };
      }
      const title = input.title.trim();
      const content = input.content.trim();
      if (!title || !content) {
        return { content: [{ type: "text", text: "错误：title 与 content 均不能为空。" }] };
      }
      if (Array.from(title).length > MAX_TITLE_CHARS) {
        return { content: [{ type: "text", text: `错误：title 超过 ${MAX_TITLE_CHARS} 字符上限。` }] };
      }
      if (Array.from(content).length > MAX_CONTENT_CHARS) {
        return { content: [{ type: "text", text: `错误：content 超过 ${MAX_CONTENT_CHARS} 字符上限。` }] };
      }
      try {
        const result = savePersonalNote(knowledgeDb, input);
        const message =
          result.reason === "inserted"
            ? `已沉淀笔记（id=${result.documentId}，${result.charCount} 字符），后续可经 patent_case_search / 语义检索召回。`
            : result.reason === "duplicate"
              ? `笔记已存在（id=${result.documentId}），跳过重复保存。`
              : "笔记跳过（内容为空）。";
        return { content: [{ type: "text", text: message }], data: result };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `笔记保存失败：${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          metadata: { error: "knowledge_note_save_failed" },
        };
      }
    },
  };
}
