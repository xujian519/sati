# 引入 dsh-patent-workbench 知识库治理机制 — 方案与任务拆解

> 日期：2026-10-14
> 状态：已评审，决策 D1–D3 已确认，可开工
> 来源调研：
> - dsh-patent-workbench v1.17.0（commit `90ceae8`）知识库机制解剖
> - Sati 知识/记忆体系盘点（EdgeClaw 记忆 + MemoryResolver 三层知识 + 自研向量/FTS）

## 1. 结论回顾

dsh 的**检索引擎**（纯关键词 IDF、61 条标定、上限 5000 条）对 Sati 无迁移价值——Sati 已有 FTS5 + 语义 + RRF + rerank，全面领先。

值得引入的是其**治理面**三个机制，恰好命中 Sati 缺口：

| 机制 | dsh 做法 | Sati 缺口 | 价值/成本 |
|---|---|---|---|
| WS1 召回日志 + 引用回填 | 每次检索落 `knowledge_recall_log`（含跳过原因、被谁引用回填） | 仅瞬时 `ContextDiagnostic` 码，无持久化日志，无「注入后是否被用上」闭环 | 高价值 / 低成本 |
| WS2 写入草稿闸门 | AI 只写 pending 草稿，人确认才入库；拒绝留拒痕 | `knowledge_note_save` 直写 knowledge.db，无审批层 | 高价值 / 中成本（涉及 UI + 协议） |
| WS3 条目压制语义 | `superseded_by` / `valid_until` 整体压制 + 前像修订 | 知识层无显式失效机制 | 中价值 / 低代码，但有 schema 归属问题 |

**不引入**：IDF 打分、逐字抽词、阈值标定表、宿主事件信封、13 字段 SessionState。

## 2. 总体策略

- **按 WS1 → WS2 → WS3 顺序分三个 PR**，各自独立可交付、可回滚。
- 只引入「机制」，不引入 dsh 代码（语料量纲与宿主契约均不兼容）。
- 每个 PR 遵守 AGENTS.md：docs/notes 决策记录（含 Alternatives considered）、核心模块测试、`pnpm check` 先绿、Conventional Commits、分支 + PR。

## 3. WS1：召回日志 + 引用回填

### 设计

新增 `src/context/memory/recall-log.ts`：

- **存储**：独立 Sati 自有状态库（**不写 knowledge.db**——那是 XiaoNuo 管道产物，写日志会污染外部契约；也避免与 edgeclaw 记忆库的 global/project scope 纠缠）。建议 `~/.sati/state/memory-recall-log.db`，复用 `src/shared/sqlite.ts`，带 schema 版本迁移。
- 表 `memory_recall_log`：
  - `id` / `turn_id` / `session_id` / `query` / `resolver_codes_json`（命中的 provider）/ `hit_ids_json`（含分数与片段摘要）/ `injected`（bool）/ `skip_reason`（timeout | empty_context | no_hits | disabled）/ `diagnostics_json` / `cited_ids_json`（回合结束后回填，可空）/ `created_at`
  - 保留策略：滚动 2000 行（对齐 dsh 的 KEEP_ROWS）。
- **写入点**（唯一出口原则）：
  1. `MemoryAttachmentBuilder.build()` 返回处（`src/context/memory/MemoryAttachmentBuilder.ts:84-122`）——成功注入、空结果、超时/异常三类路径都要落，**降级不静默**（AGENTS.md 规则 11：skip 必须有原因）。
  2. 引用回填：turn 收尾钩子（`src/agent/loop/turnExit.ts` 的 captureTurn 附近）扫描本回合 assistant 输出是否包含注入条目标识。**保守优先：宁可漏标不可瞎标**（对齐 dsh autoCite 原则）。
- **MemoryResolver 契约**：`MemoryRetrieveResult` 需暴露结构化命中列表（id + score + snippet）。若现有 `systemContext` 是纯文本，需在 `MemoryResolver.ts` 增加可选 `hits` 字段（向后兼容，各 provider 渐进填充）。
- **不新增 AgentEvent 帧**：WS1 保持 DB 侧可观测，避开事件矩阵范围膨胀（规则 5 成本）。UI 面板留到 WS1 之后按需单独立项。

### 任务清单

- [x] **T1.1** 新建 `src/context/memory/recall-log.ts`：open + migrate（v1 建表）+ `appendRecallLog` + `citeRecallLog` + 滚动清理；复用 `src/shared/sqlite.ts`
- [x] **T1.2** `MemoryResolver.ts`：`MemoryRetrieveResult` 增加可选 `hits?: MemoryHit[]`（id/score/snippet/provider）；`composite-memory-resolver.ts` 透传
- [x] **T1.3** `MemoryAttachmentBuilder.build()`：三条路径（注入/空/异常）统一落日志；诊断码与 skip_reason 映射表
- [x] **T1.4** turn 收尾回填：在 turnExit captureTurn 链路后挂 `citeRecallLog`；匹配规则 = 注入条目 id 或标题前缀（前缀碰撞则两条都不标）
- [x] **T1.5** 单元测试：`*.spec.ts`（schema 迁移、append/cite、滚动清理、builder 三路径落日志、resolver 假实现 wiring）；**mock 外部网络/LLM，不走真实 resolver**
- [x] **T1.6** docs/notes 决策记录：`2026-10-XX-memory-recall-log.md`，含 Alternatives considered（写 knowledge.db / 写 edgeclaw 库 / 写 session jsonl 三条被否路径的理由）

### 检查清单（PR 合并前）

- [x] `pnpm check` 全绿（先跑，见规则 9）
- [x] `pnpm test` 通过；新测试均为 `*.spec.ts`（如误建 `*.test.ts` 须 `git add -f` + 先 `pnpm measure:update` 再提交，规则见 AGENTS.md 环境事实）
- [x] strict 模式：无 `any`、无 `@ts-ignore`
- [x] 注入失败/超时路径有日志且带 skip_reason（规则 11，可区分「未核验」与「已核验无问题」）
- [x] `MemoryResolver` 契约变更向后兼容：未实现 `hits` 的 provider 不报错
- [x] 日志库路径可配置（env），默认不在 knowledge.db / edgeclaw rootDir 内
- [x] docs/notes note 已同 PR 提交
- [x] Conventional Commits：`feat(memory): ...`

## 4. WS2：写入草稿闸门（knowledge_note_save）

### 设计

- **数据**：knowledge.db 新增 `knowledge_drafts` 表（`source='project'` 边界不变）。理由：与 documents 层同库同事务，confirm 时可原子「草稿 → documents + chunks + docs_fts」，且 `openKnowledgeDb` 已有版本校验机制（`schema-versions.ts`），新增表走同一迁移通道。
  - 字段：`id` / `session_id` / `title` / `content` / `project` / `status`(`pending|confirmed|rejected`) / `reject_reason` / `document_id`（确认后回填）/ `created_at` / `updated_at`
  - 约束：同会话单 pending 草稿（唯一部分索引），重复提交覆盖
- **工具语义变更**：`knowledge_note_save` 改为只写 pending 草稿，返回「已提交草稿，待确认」。**注意规则 6**：inputSchema/description 任何改动会使 llm-replay fixture 失配 → 必须重录。
- **确认通道**（已确认 D2 = 新工具 + gateway 触发）：新增工具 `knowledge_note_confirm`，UI 确认动作经 gateway 触发该工具；**不新增协议帧**，避开事件矩阵成本。UI 面板未来单独立项。
- **配置开关**：`memory.knowledgeNoteSaveMode: "direct" | "draft"`，默认 `draft`（待确认决策 D1）；`direct` 为逃生口保留旧行为，保证既有自动化不断。
- **拒痕**：拒绝时写 `status='rejected' + reject_reason`，保留 90 天，作为「负记忆」防止 agent 反复提交同一内容。

### 任务清单

- [x] **T2.1** schema：knowledge.db 迁移新增 `knowledge_drafts` 表 + 部分唯一索引；`schema-versions.ts` bump
- [x] **T2.2** `src/knowledge/personal-note/drafts.ts`（新）：`saveDraft`（会话级覆盖）/ `confirmDraft`（事务内写 documents+chunks+fts 并回填）/ `rejectDraft`（留拒痕）/ `listPending`
- [x] **T2.3** 改造 `knowledgeNoteSave.ts`：按开关写草稿或直写；**同步更新 tool description → 触发 llm-replay 重录**
- [x] **T2.4** 确认通道实现（按 D1 决策）；若走 UI：i18n 提取 `ui/src/i18n/locales/{en,zh-CN}/`
- [x] **T2.5** 单元测试：草稿 CRUD、同会话覆盖、confirm 事务原子性（失败回滚不留半写）、拒痕保留、开关双路径
- [x] **T2.6** llm-replay fixture 重录 + `pnpm check:event-matrix`（若改 gateway 帧则必须先 `pnpm gen:event-matrix`）
- [x] **T2.7** docs/notes 决策记录：含 Alternatives considered（确认通道三选一的取舍、默认开关取值、为何不直接废掉 direct 模式）

### 检查清单（PR 合并前）

- [x] `pnpm check` 全绿（含 `check:event-matrix`、`check:doc-claims`）
- [x] `pnpm test` 通过；replay fixture 已重录且 CI 绿
- [x] 新增用户可见文案全部进 i18n locales（若含 UI）
- [x] direct 逃生口可用：`knowledgeNoteSaveMode=direct` 时行为与现状逐字节一致（用现有测试锁定）
- [x] confirm 失败事务回滚，不产生孤儿 documents/chunks 行
- [x] 同会话并发提交不产生双 pending 草稿（唯一索引兜底，有测试）
- [x] docs/notes note 已同 PR 提交

## 5. WS3：条目压制语义（supersede / valid_until）

### 设计

- **前置依赖**：WS2 落地后才有「条目更新/取代」的真实流量，WS3 在此之前无意义。**立项触发条件**：草稿闸门启用后 personal_note 月 churn > 20 条，或出现首例「过期知识被召回」事故。
- **方案预埋**（本阶段只做决策记录，不写代码）：
  - documents 表加 `superseded_by` / `valid_until` 列 → 命中压制（不参与召回）而非删除或降权
  - 更新/删除前写 `document_revisions` 前像表，可恢复
  - 注意：documents 表 schema 由 XiaoNuo 管道与 `schema-versions.ts` 共同约束，加列需与管道 owner 对齐版本契约 —— **这是 WS3 最大风险点**，立项前必须先确认管道是否容忍 Sati 侧加列。

### 任务清单

- [ ] **T3.1** docs/notes 决策记录：压制语义设计 + 与 XiaoNuo 管道的 schema 契约确认结论
- [ ] （立项后）实现任务待 T3.1 结论再拆解

## 6. 跨 PR 总检查清单

- [ ] 每个 PR：分支 + PR 提交（main 受保护），Conventional Commits
- [ ] 每个 PR：`pnpm check` → `pnpm test` 顺序执行并留存输出
- [ ] 核心模块（`src/context/` `src/tool/` `src/knowledge/`）改动均附测试（规则 8）
- [ ] 未引入 dsh 任何代码/依赖；无第三方向量库新增
- [ ] 降级路径可区分：日志库打不开、草稿表迁移失败、confirm 失败均有明确报错而非静默跳过（规则 11）

## 7. 已确认的决策（2026-10-14 用户拍板）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | WS2 默认模式 | **`draft` 默认闸门**；`direct` 为 env 逃生口保留旧行为 |
| D2 | WS2 确认通道 | **新工具 + gateway 触发**（不新增协议帧，避开事件矩阵成本）；UI 面板未来单独立项 |
| D3 | WS1 日志库位置 | **`~/.sati/state/memory-recall-log.db`**（Sati 自有状态目录，与 knowledge.db / edgeclaw 记忆库解耦） |

## 8. 风险与回退

- **WS1 风险**：`MemoryRetrieveResult` 加 `hits` 字段导致 provider 实现遗漏 → 契约设为可选字段 + 透传测试兜底。回退：日志模块可整目录摘除，无侵入点残留。
- **WS2 风险**：llm-replay fixture 失配漏录 → PR checklist 强制重录步骤；开关默认争议 → D1 决策点显式留痕。回退：开关置 `direct` 即恢复现状。
- **WS3 风险**：knowledge.db schema 与 XiaoNuo 管道契约冲突 → 立项门禁（T3.1 前置确认），未确认不动代码。
