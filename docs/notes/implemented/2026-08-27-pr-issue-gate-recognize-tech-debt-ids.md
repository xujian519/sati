# Agent Note: PR traceability gate recognizes tech-debt IDs

Status: implemented

## Problem

`pr-traceability` 门禁（`.github/workflows/ci.yml` + `.github/scripts/check-pr-issue.mjs`）
只识别 GitHub 式 `#编号` 引用与「无关联 issue」豁免。但项目把大量债项登记为
`TD-*` 编号（`docs/technical-debt/backlog.md`，如 `TD-PATENT-N06`、`TD-ADAPTERS-N01`），
并以此作为 PR 的可回溯来源。当 PR 仅为偿还某个盘点的债项时，作者写上 `TD-*` 即已在
账本中建立来源，可门禁不认识它，导致误判失败。

- 实证：PR #200（`fix(patent): surface nuo patent metadata JSON parse warnings`）的
  body 写了「消除技术债务 **TD-PATENT-N06**」，无 `#编号`、无豁免，CI 报
  `✗ 本 PR 未关联任何 issue，无法回溯到需求来源`。
- 同期通过的门禁 PR（#184/#186/#188 等）同时带 `TD-CATCH-001`/`TD-CONSOLE-001`，只因
  另有 `#162` 引用才通过；说明 `TD-*` 是项目真实惯例，只是门禁未识别。

顺带发现：`LINK_KEYWORD` 的 `关联` 分支从不匹配模板原生写法「关联 Issue: #123」
（关键词与编号之间隔了单词 `Issue:`），仅靠宽松的 `BARE_NUMBER` 兜底才通过，属潜在脆弱点。

## Decision

1. `check-pr-issue.mjs` 新增识别技术债编号：`/\bTD-[A-Z][A-Z0-9-]*\d\b/i`，作为与
   `#编号` 等价的可回溯来源。
2. 修正 `LINK_KEYWORD`，允许关键词与编号间出现可选的 `Issue:` 字样，使模板原生
   「关联 Issue: #123」在去掉 `BARE_NUMBER` 兜底后仍能命中。
3. 抽出纯函数 `evaluatePrTraceability(title, body)` 并新增 `.github/scripts/check-pr-issue.test.mjs`
   单测；`ci.yml` 的 `quality` job 增加「Self-test PR traceability gate」步骤。
4. 更新 PR 模板与 `CONTRIBUTING.md` 的 PR 小节，写明三类可回溯来源写法。

## Alternatives considered

- **只靠模板自觉，不加门禁** — 落选；与仓库「铁律必须有门禁」的既有主张相悖，模板字段可被随意删除。
- **强制每个 PR 必须关联真实 GitHub issue，`TD-*` 不算** — 落选；摩擦更大，会让更多（且
  本就具有账本可回溯性的）PR 失败，不贴合 `TD-*` 工作流。
- **门禁识别 `TD-*` 债编号** — 采纳；与项目既有惯例对齐、直接消除这类偶发失败，同时保留「能回溯到需求来源」的本意。
- **门禁降级为警告或仅本地校验** — 落选；削弱门禁强制力，本地 hook 可被绕过。

## Consequences

- 仅偿还 `TD-*` 债项的 PR 不再被误判失败。
- 新增一个约 1s 的自测步骤（`node --test`，无需依赖），门禁自身逻辑随 push/PR 回归。
- 不改任何工具 `inputSchema`/`outputSchema` 与 `AgentEvent`/gateway frames，LLM replay
  fixtures 与事件矩阵不受影响。
