# Agent Note: 工作流收敛——删除零消费的 DAG 引擎

Status: implemented

## Problem

`src/workflow/`（XiaoNuo 移植的 DAG 执行引擎）与专利域自有执行链长期并存：术语上被描述为"四套并行执行模型"，并有 R4 suppress（`expires 2026-11-18`）与一条 defer 决策记录（`2026-08-23-defer-multi-engine-unification.md`）把删除动作挂到"先完成能力覆盖对比 + 两个消费者真实需求"这一前提上。

评估（`docs/workflow-convergence-eval.md`）发现前提中的事实需要修正：引擎在 `src` / `ui` / `apps` / `scripts` **零生产调用方**；被点名的第一个消费者（`patent/graph/adapter`）实际引用的是 `src/patent/workflow/signal.ts`（专利域内，`src/workflow/` 下并无该文件）；第二个消费者（`patent/workflow-dag.ts`）里 `FlowGraph` 相关的两个导出没有生产消费者，且其校验能力（`FlowGraph.validate()` 检测环 / 孤儿）对 manifest 的**严格顺序链**恒为空判定——但同一文件的 `workflowManifestToMermaid` **确有生产消费者**（`patent_workflow` 工具写 run 产物 `<runId>.mmd`），因此该函数单独迁入专利域保留。也就是说：所谓"三套引擎需要统一"，实际是「一套零消费死重 + 一个计划层（flexible-plan）+ 两条同域执行路径（`runWorkflow` ↔ `patent/graph`，已有等价性测试）」并存。

## Decision

执行 `docs/architecture-fix-plan.md` 的 P6c 选项 (a)：删除 `src/workflow/**`（11 文件 1760 行）与 `src/patent/workflow-dag.ts`（其中 `workflowManifestToMermaid` 逐字迁入 `src/patent/workflow/mermaid.ts`，输出不变以保 `patent_workflow` 的 `.mmd` 产物），同步删除 `tests/workflow/**` 与 `tests/patent/workflow-dag.spec.ts`；`src/patent/index.ts` 更新转出面；`.brooks-lint.yaml` 的 R4 suppress 条目移除（评估完成、重复模式消失）；三处对已删模块的失效注释引用（`workflow-store.ts` / `workflow/types.ts` / `flexible-plan-store.ts`）一并清理。

长期模型定为专利域自有执行链：执行器 `src/patent/workflow.ts`（`runWorkflow`，顺序链 + 审批门 + 有界回退 + 断点续跑）、图引擎 `src/patent/graph/`（SuperStep，三性领域子图 + 评估框架）、计划层 `flexible-plan`（`toManifest()` 交给 `runWorkflow`）。

P6b（原定 `src/patent/execution-protocol.ts` 统一四引擎协议）不再单独立项：删除 DAG 引擎后统一对象只剩两条已有等价性测试的同源路径，改为按 `patent/graph/README.md` 已知差异逐条收敛，避免为单一消费者引入间接层。

## Alternatives considered

- **选项 (b)：保留 DAG 为主引擎、把 `patent/workflow` 改为薄适配层** — 落选：成本方向相反，要求改造活的生产链路（`runWorkflow` 已被 `patent_workflow` / `patent_workflow_run` / `flexible-plan` 消费）去适配零消费的死引擎；且图引擎承载三性领域子图与评估框架，是产品侧持续投入面。
- **只删"纯死码 DagExecutor"（backlog TD-WORKFLOW-N01 的最低建议）** — 落选：范围不足。同目录的 `WorkflowEngine` / `SafeEvaluator` / `InputResolver` / checkpoint / persistence / worker resolver / subagent factory 与 `DagExecutor` 消费面完全相同（皆零），只删其中之一会把"剩余部分是否还有人用"的问题留给下一轮。
- **接线 `src/workflow` 沉淀为唯一引擎** — 落选：需要把已在生产、已有等价性测试与领域子图的专利域链路迁到一套陌生引擎上，收益仅是"消除撞名"，风险与成本远超收益。
- **继续 defer（不动，等 suppress 到期）** — 落选：defer 的前提（消费者需求未知）已在本次评估中查清；继续挂起只会让 suppress 到期后留下一条无法解释的豁免。

## Consequences

- `workflow` 撞名消失：`src/` 内只剩 `src/patent/workflow`（域内执行）与 `src/patent/graph`（图引擎）。
- 少维护 1760 行零消费实现与其 837 行测试；未来的架构审计不再需要为"四套引擎"付认知成本。
- 代价：若日后确需"运行中步骤级改计划"，需从 git 历史取回或基于 `flexible-plan` 扩展（阶段级增删改已可用且有工具入口，故当前无阻塞）。
- `.brooks-lint.yaml` 的 R4 豁免随评估结案移除；本决策不改动 `patent/graph` 与 `runWorkflow` 的任何行为（`pnpm check` + `pnpm test` 为判据，未改任何工具 `inputSchema` 与事件声明）。
