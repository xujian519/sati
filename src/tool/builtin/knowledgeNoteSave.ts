/**
 * knowledge_note_save — 项目知识沉淀工具（personal_note 反馈回路）。
 *
 * 把项目产出（OA 答复要点、无效分析结论、检索心得）写入 knowledge.db
 * 的 personal_note 文档层（documents + chunks + docs_fts），使后续
 * `patent_case_search` / 语义检索可召回，实现"产出反哺知识、越用越强"。
 *
 * 两种写入模式（WS2 草稿闸门，决策见 docs/notes/implemented/2026-10-14-knowledge-draft-gate.md）：
 * - `draft`（默认，D1）：AI 只提交 pending 草稿，经 `/api/web/knowledge-drafts/confirm`
 *   人工确认后才入库——AI 沉淀不再直触知识库；
 * - `direct`（逃生口）：保持旧行为直写 documents 层（knowledgeNoteSaveMode: direct）。
 *
 * ⚠️ 本工具的 name / inputSchema / description 字节参与 llm-replay fixture 的
 * toolSchemaDigest 绑定：改任何描述文本都会使 fixture 失配须重录。模式差异只体现在
 * 运行时行为与返回文本，不体现在 schema。
 *
 * 知识库只读边界（显式声明）：
 * - 只写 source='project'、doc_type='personal_note' 的文档行；
 * - 不动 kg_nodes / kg_edges / law_article 等核心只读数据；
 * - knowledge.db 以短连接 + 事务写入（不持有长连接），journal_mode=delete
 *   下不影响既有关键路径的只读访问（短暂写锁，用完即关）。
 *
 * 幂等：id = sha1(project|title|content) 前 16 位，同内容重复保存直接跳过。
 */

import { existsSync } from "node:fs";
import { resolveKnowledgeDbPaths } from "../../knowledge/config.js";
import { saveKnowledgeDraft } from "../../knowledge/personal-note/drafts.js";
import { insertPersonalNoteDocument, noteDocumentId } from "../../knowledge/personal-note/note-document.js";
import { openKnowledgeDb } from "../../knowledge/shared/db-version.js";
import { KNOWLEDGE_DB } from "../../knowledge/shared/schema-versions.js";
import type { SatiToolDefinition } from "../protocol/types.js";

/** 写入模式：draft（默认，草稿闸门）或 direct（直写逃生口）。 */
export type KnowledgeNoteSaveMode = "direct" | "draft";

/** 向后兼容 re-export：既有引用方（测试/resolver）从本模块导入 noteDocumentId。 */
export { noteDocumentId };

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
  /** draft 模式下为草稿 id。 */
  draftId?: string;
  reason?: "inserted" | "duplicate" | "skipped" | "draft_pending" | "draft_overwritten";
  charCount?: number;
};

export type CreateKnowledgeNoteSaveToolOptions = {
  /** 缺省 "draft"（草稿闸门，D1 决策）。 */
  saveMode?: KnowledgeNoteSaveMode;
};

/** 内容/标题上限（防单条笔记撑爆 FTS 与上下文）。 */
const MAX_TITLE_CHARS = 200;
const MAX_CONTENT_CHARS = 20_000;

/** 写入实现（导出便于测试注入 dbPath）。事务内含重复检查，幂等且原子。 */
export function savePersonalNote(dbPath: string, input: KnowledgeNoteSaveInput): KnowledgeNoteSaveOutput {
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title || !content) {
    return { saved: false, reason: "skipped" };
  }
  const documentId = noteDocumentId(input.project, title, content);

  // 短连接 + 事务（journal_mode=delete 下写锁短暂；用完即关）。
  // 写路径同样做版本校验：真源版本不符时拒绝写入，避免向旧库写新格式数据。
  const opened = openKnowledgeDb(dbPath, KNOWLEDGE_DB);
  const db = opened.db;
  try {
    db.exec("BEGIN");
    try {
      // 重复检查与写入同事务：并发下不会出现"检查通过后重复插入"的竞态窗口。
      if (db.prepare("SELECT id FROM documents WHERE id = ?").get(documentId)) {
        db.exec("ROLLBACK");
        return { saved: false, documentId, reason: "duplicate" };
      }
      const { charCount } = insertPersonalNoteDocument(db, { documentId, title, content });
      db.exec("COMMIT");
      return { saved: true, documentId, reason: "inserted", charCount };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export function createKnowledgeNoteSaveTool(
  options: CreateKnowledgeNoteSaveToolOptions = {},
): SatiToolDefinition<KnowledgeNoteSaveInput, KnowledgeNoteSaveOutput> {
  const saveMode = options.saveMode ?? "draft";
  return {
    name: "knowledge_note_save",
    outputSchema: {
      type: "object",
      required: ["reason"],
      properties: {
        documentId: { type: "string" },
        draftId: { type: "string" },
        charCount: { type: "integer" },
        reason: { type: "string" },
      },
    },
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
    execute: async (input: KnowledgeNoteSaveInput, context) => {
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
        if (saveMode === "draft") {
          // 草稿闸门（WS2）：只写 pending 草稿，确认通道见
          // /api/web/knowledge-drafts/confirm（HTTP 面，不经 agent 工具表）。
          const draft = saveKnowledgeDraft(knowledgeDb, {
            sessionId: context.sessionId ?? "unknown-session",
            title,
            content,
            project: input.project,
          });
          const message = draft.overwrote
            ? `已更新本会话知识草稿（id=${draft.draftId}），待确认后入库。`
            : `已提交知识草稿（id=${draft.draftId}），待确认后入库；同会话重复提交将覆盖本草稿。`;
          const result: KnowledgeNoteSaveOutput = {
            saved: false,
            draftId: draft.draftId,
            reason: draft.overwrote ? "draft_overwritten" : "draft_pending",
            charCount: content.length,
          };
          return { content: [{ type: "text", text: message }], data: result };
        }
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
