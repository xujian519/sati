# Agent Note: 回路结构化触发 + 双路径共用判定 + RevisionRecord

Status: implemented

## Problem

一致性回路只吃 `whenOutputMatches` 正则：触发与否取决于模型在输出里是否恰好写了「不一致 / 需要修订」这类词，模型换个措辞就可能漏触发。manifest 路径（`workflow.ts`）与图路径（`graph/adapter.ts`）各写一份判定与回退清理，已经发生过漂移（#345：同一审批门在两条链路下取到 `""` vs `"APPROVED"`）。回退之后没有任何留痕：审计上答不出「哪个缺口触发了回退、改前改后是什么、为什么改」。

## Decision

**触发判据**（`src/patent/workflow/signal.ts`）：

- `retry.whenOutputGaps?: boolean` 新增，与 `whenOutputMatches?` 至少声明一个；同时声明时结构化优先。
- `needsRedo(stage, output, signal?)` 是两条路径唯一的触发判定。结构化判据解析严格 JSON：
  - `gaps[]` 非空 → 回退；`gaps` 与 `consistent` 并存时以 `gaps` 为准（缺口清单优先于总结论）；
  - 无 `gaps` 字段时 `consistent:false` → 回退；
  - 结构化不可用且声明了正则 → 回退正则（`matchSignal` 的否定词窗口 / `consistent` 快判据语义不变）；
  - 只声明 `whenOutputGaps` 且输出不可解析 → 返回 `undefined`，调用方写 `retry_signal_unparseable` 降级标记，不得当作「判定通过」。
- 口径修正：现有 retry 阶段没有通用的 `gaps[]` 生产者（`slop_clean` 的主输出是文本报告），因此本项只在显式声明 `whenOutputGaps` 且输出契约确实是严格 JSON 的阶段启用结构化。本 PR 唯一启用点是 `consistency`（disclosure / drafting 共用 `PFE_CONSISTENCY_PROMPT`）；`slop_clean` 保留正则，理由写在其 manifest 注释中。

**留痕**（`src/patent/workflow/revision.ts`）：

- `RevisionRecord = { gapId, before, after, rationale, at, status, truncated? }`，`WorkflowRunResult.revisions?` 与 `GraphRunResult.revisions?` 暴露。
- 两条路径共用 `recordRewind` / `closeRevision`：回退时追加一条 `status: "interrupted"`、`after: ""` 的记录并挂起触发阶段；该阶段重跑完成时（无论是否再次触发）回填 `after` 并置 `closed`；超限时以 `[WORKFLOW_RETRY_EXHAUSTED] ...` 闭合；重跑前中断则保持 `interrupted`。
- `before` / `after` 取**触发回退阶段**（retry 所在阶段）的输出，截断上限 2000 字符并置 `truncated: true`。这样「超限输出属于该阶段」与「用重跑后的新判据证明缺口闭合」两个语义在同一条记录里自洽。
- `gapId` 命名空间：结构化用 `gaps[].id`（多个以 `+` 连接）；旧路径用 `rule:<ruleId>` / `element:<elementId>→<targetId>` / `pattern:<命中文本>` / `consistent:<stageId>`，不与结构化 id 混用。
- manifest 路径的封点与图路径一致（图路径在条件边 router 闭合、state 键 `_revisions` / `_revision_pending` 随检查点持久化）；`clearStageOutputs` 不触碰这两个键。

**结果装配**：

- manifest 路径的 `saveCheckpoint` 携带 `revisions`，resume 后可读；旧检查点 / 旧 run JSON 缺字段按空数组兼容。
- 图引擎抽出统一的 `buildRunResult`，中断、failFast、maxSteps 三类提前返回都带回 `revisions`。

## Alternatives considered

- **只改 manifest 路径，图路径保持正则** — 正是 #345 的漂移模式；等价用例会把「两路径判定分叉」转红，故两条路径都改调 `needsRedo`。
- **`before` / `after` 取被回退目标阶段（`rewindTo`）的输出** — 能展示内容差异，但超限输出属于触发阶段，无法解释「超限时用 `[WORKFLOW_RETRY_EXHAUSTED]` 填 after」；且无法直接回答「缺口是否闭合」。
- **每次回退按 `gaps[]` 逐条写记录** — #730 的验收口径是「每回退一条 `RevisionRecord`」；多条会把同一次判定与重跑拆成重复记录，故 gapId 用 `+` 连接多个 id。
- **结构化不可用时默认按「不需要回退」处理** — 会把「无法判定」呈现成「判定通过」；改为 `undefined` + `degradations` / `__degradation` 标记。
- **把 `whenOutputGaps` 默认设为 true** — 现有阶段多为自由文本输出，默认开启会让每个 LLM 阶段都进入「不可解析」分支；显式声明避免大面积降级噪音。

## Consequences

- `consistency` 的 JSON 契约变为 `{ consistent, gaps: [{ id, kind, detail }], issues }`；旧 fixture 若仍返回 `{consistent, issues}`，结构化不可用后回退正则，行为保持兼容。
- `retry.whenOutputMatches` 变为可选；`validateWorkflowManifest` 对「两个判据都没声明」与「`whenOutputGaps` 非布尔」fail-fast。
- `WorkflowRunResult.revisions` / `degradations` 与 `GraphRunResult.revisions` 是可选新字段，旧产物可读。
- 命名冲突：`src/patent/docket` 已有 `RevisionRecord`（案卷修订轮次）。workflow 侧定义同名类型，patent barrel 以 `WorkflowRevisionRecord` 别名导出，避免 `src/patent/index.ts` 重复导出。
- 已知边界：结构化触发目前只覆盖 `consistency`；`slop_clean` 要结构化需先改原子输出契约（另开工作包）。
