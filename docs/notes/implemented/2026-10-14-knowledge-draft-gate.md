# Agent Note: knowledge_note_save 草稿闸门（draft gate）

Status: implemented

## Problem

`knowledge_note_save` 让 agent 把项目产出（OA 答复要点、无效分析结论、检索心得）直写 knowledge.db 的 personal_note 层，后续检索可召回。直写意味着：**AI 产出的知识未经任何人确认就成为长期知识库的一部分**——幻觉、过时结论、半成品分析都会沉淀并在后续检索中污染上下文，且无任何审批留痕与「不该这样写」的负反馈回路。

上游参照：dsh-patent-workbench 的草稿闸门（AI 只提交 pending 草稿、用户确认才入库、拒绝留拒痕），调研见 `docs/plans/2026-10-14-knowledge-governance-import.md` WS2。

## Decision

- **两种写入模式**：`draft`（默认，D1）= agent 只写 `knowledge_drafts` pending 草稿，人工经 `/api/web/knowledge-drafts/confirm` 确认后才在**同一事务**内写 documents + chunks + docs_fts 并回填 `document_id`；`direct` = 旧直写行为（`memory.knowledgeNoteSaveMode: direct` 逃生口）。
- **确认通道走既有 `/api/web/*` HTTP 面**（Bearer 鉴权），**不注册为 agent 工具、不新增 WebSocket 协议帧**（D2）。
- **同会话单 pending 草稿**：重复提交覆盖内容（部分唯一索引 `WHERE status='pending'` 兜底并发）。
- **confirm 事务原子性**：任何失败整单回滚——草稿保持 pending 可重试，绝不产生孤儿 documents/chunks 行。
- **拒痕 = 负记忆**：拒绝记录 `reject_reason`，保留 90 天（惰性清理），防止同一错误内容被反复提交。
- **表用 `CREATE TABLE IF NOT EXISTS` 幂等创建**：KNOWLEDGE_DB 是版本 1 的 source 库（XiaoNuo 管道产物），bump 版本会使存量 v1 库 fail-loud 拒开——加表走「写入点幂等建表」，与既有 `docs_fts` hasFts 探测同一先例。
- **UI 确认面板不在本 PR**：路由先行，面板后续单独立项。

## Alternatives considered

- **修改 knowledge_note_save 的 description 说明草稿语义** — 落选：工具 schema（含描述文本）参与 llm-replay fixture 的 toolSchemaDigest 绑定，任何文本变更都使 fixture 失配须重录；模式差异改为只体现在运行时返回文本，schema 字节不动（经 `tests/tool/builtin/knowledgeNoteSaveDraft.spec.ts` 锁定双模式行为）。
- **confirm 注册为 agent 工具（knowledge_note_confirm）** — 落选：新增工具会改变默认工具集 → 同样破坏 fixture toolSchemaDigest；且确认动作的发起方是人（UI）而非 LLM，放进 agent 工具面是错误抽象。最终落为 HTTP 路由 + 纯函数服务。
- **confirm 走新 WebSocket 协议方法** — 落选：触发协议版本 bump + 事件矩阵 + UI i18n 全套成本（D2 明确避开）；`/api/web/*` HTTP 面已承载同类「UI 直取」职责（projects/files），一致性更好。
- **confirm 直接内联 documents 插入逻辑** — 落选：直写与确认两条路径必须写同一组表，双份插入逻辑必然漂移；抽 `note-document.ts` 为唯一实现。
- **覆盖草稿生成新行（保留旧 pending 历史）** — 落选：部分唯一索引约束「每会话一份 pending」，新行设计需引入 superseded 类状态，复杂度换不来审计价值；更新原行保留 created_at 即可。
- **默认 direct、草稿 opt-in** — 落选（D1 用户拍板）：与 dsh「默认治理、可关闭」哲学一致；升级用户的行为变化在 PR 中明示，逃生口保证可回退。

## Consequences

换来了：AI 沉淀的知识首次有了人工审批层与负反馈回路（拒痕）；confirm 路径复用直写幂等键（`sha1(project|title|content)`），重复确认天然去重；HTTP 路由零协议成本，UI 面板可随时接上。

付出了：`knowledge_note_save` 的 schema 语义与运行行为分离（描述仍写「沉淀到知识库」，实际默认先沉淀为草稿）——这是避开 fixture 重录的既定取舍，未来若重录 fixture 应同步描述文本；draft 模式下 agent 不知道「何时被确认」，会话内续写时可能重复提交（同会话覆盖语义缓解，跨会话重复靠幂等键与人工拒稿兜住）。
