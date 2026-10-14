# Agent Note: 知识条目压制语义（supersede / valid_until）— WS3 提案

Status: proposed

## Problem

知识条目一旦进入 knowledge.db 的 personal_note 层，就没有显式失效机制：过时结论不能被「取代」或「过期」，只能靠同幂等键（`sha1(project|title|content)`）内容变化产生新行、旧行继续被召回稀释。随着草稿闸门（WS2）让沉淀开始 churn，「过期知识被召回」会从理论风险变成事故。

上游参照：dsh-patent-workbench 用 `superseded_by_id` / `valid_until` 两列实现「压制而非删除」语义（`src/db/schema.ts` v18），更新/删除前留前像（v24 revisions 表）。

## Proposal（设计已成型，实现被门禁阻断）

语义设计（若立项）：

1. `documents` 加 `superseded_by TEXT` / `valid_until TEXT` 两列：命中即整体压制（召回/检索 WHERE 排除），不删除、不降权——对齐 dsh「压制而非降权」（降权会让新旧同时在结果里竞争，压制保证最多一条生效）。
2. `document_revisions` 前像表：更新/删除 personal_note 前整行照抄，可恢复。
3. 确认通道（`/api/web/knowledge-drafts`）加 `supersede` 动作：确认新草稿时可指定取代旧条目。

**实现门禁（本次调研结论，2026-10-14 核实）**：XiaoNuo 管道对 knowledge.db 的更新是**文件级整体替换**——`scripts/build-local-data.ts` 检测到已有库自动跳过、`--force` 强制重建，产物经拷贝覆盖 `~/.sati/knowledge/knowledge.db`（Sati 设计文档 §9：「knowledge.db 的更新由 XiaoNuo 管道负责，Sati 只消费」）。因此：

- 给 `documents` 加列会在下一次产物刷新时被**整体抹掉**（schema 回到管道版）；
- 更根本的问题：**personal_note 行与 knowledge_drafts 表本就不该住在 knowledge.db**——它们已在 WS2 落入同一被整体替换的文件。

**立项前置（二选一）**：
- A（推荐）：把 Sati 运行期写入迁出 knowledge.db，落到 Sati 自有库（如 `~/.sati/knowledge/sati-notes.db`），documents 层仅存只读镜像视图或确认时同步插入——knowledge.db 恢复「纯管道产物、Sati 只读」的干净契约，之后 WS3 加列落在 Sati 自有库无任何契约风险；
- B：与 XiaoNuo 管道约定 merge 协议（管道侧保留非 `source='nuo'` 的行/列）——跨仓契约，协调成本高。

**前置 A 已落地（WS2.1，2026-10-14，随 PR #672）**：sati-notes.db 成为 notes/drafts 唯一真源；knowledge.db 只承载可重建检索投影，文件签名（size+mtime）失配时写路径自动全量重投影——管道刷新后笔记自动恢复、草稿零丢失。WS3 剩余门禁仅「月 churn > 20 条或首例事故」的触发条件；加列落点改为 sati-notes.db 的 notes 表（superseded_by/valid_until + revisions），与管道产物零耦合。

**Acceptance criteria（立项后）**：
- 压制语义生效后，被取代条目在 `patent_case_search` / 语义召回 / FTS 三路均不可见（负例测试锁定）；
- 前像可恢复（restore 路径有测试）；
- 知识库刷新（文件级替换）后 Sati 侧沉淀零丢失（前提 A 落地）。

## Alternatives considered

- **直接给 documents 加列（不做前置迁移）** — 落选：下一次管道产物刷新即静默丢失 schema 与全部 Sati 侧写入，违反「降级但不静默」（丢失无任何报错与感知）。
- **降权而非压制** — 落选（对齐 dsh 取舍）：时间/相关度降权会让新旧条目同时出现在结果中竞争，过期知识仍有污染窗口；压制保证「最多一条生效」语义可解释。
- **删除代替压制** — 落选：丢失审计链，且 dsh 明确「失真的证据比没有证据更糟」——删除是不可逆的信息销毁，压制是可逆的。
- **把压制语义放在检索层（注入时过滤，不改库）** — 落选：过滤器随 resolver 分散，FTS/语义/KG 三路都要各自维护黑名单，必然漏一路；库层语义单一事实源。

## Risks

- **WS2 事后风险（已于 WS2.1 根治，2026-10-14 随 PR #672 落地）**：~~knowledge_drafts 表与 personal_note 行当前住在 knowledge.db 内，产物刷新会**静默清空 pending 草稿与已确认笔记**~~ → 真源已迁出至 Sati 自有 sati-notes.db，knowledge.db 仅留可重建投影 + 签名检测自动重投影，刷新不再丢失任何 Sati 侧数据。
- 方案 A 的迁移成本：drafts 表迁移是机械搬库；personal_note 迁移需同步迁移 `PersonalNoteStore`/向量索引的数据源路径与存量数据导出，需一次性的导出-导入脚本。（已由 import_v1 一次性导入承接，无需手工脚本。）
- 月 churn  currently 远低于 20 条/月（立项触发条件未达），WS3 不急；~~但 WS2.1（迁出）不受该条件约束，越早做契约越干净~~ → WS2.1 已落地。
