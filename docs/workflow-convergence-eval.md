# 工作流收敛评估（P6a / #150）

- 评估日期：2026-09-11
- 触发：`.brooks-lint.yaml` 对 `src/workflow/**` 的 R4 suppress 于 2026-11-18 到期；`docs/architecture-fix-plan.md` 的 P6a 卡
- 关联 issue：[#150](https://github.com/xujian519/sati/issues/150)
- 关联决策记录：`docs/notes/implemented/2026-08-23-defer-multi-engine-unification.md`（defer 决策）、`docs/notes/implemented/2026-09-11-workflow-convergence-delete-dag-engine.md`（本次结论）

## 一、结论

**收敛方向取 P6c 选项 (a)：以专利域自有执行链（`runWorkflow` + `patent/graph`）为长期模型，删除 `src/workflow/**` 整套；借用者 `src/patent/workflow-dag.ts` 中无消费者的图能力（`manifestToFlowGraph` / `validateWorkflowManifestDag`）随删，其中**有真实消费者的 Mermaid 可视化**（`workflowManifestToMermaid`）迁入 `src/patent/workflow/mermaid.ts` 保留（逐字迁移，输出不变）。**

核心理由：`src/workflow/` 的执行引擎在 `src` / `ui` / `apps` / `scripts` **零生产调用方**（仅 `tests/` 覆盖）；借用者中 `FlowGraph` 相关的两个导出亦无生产消费者，且其核心校验能力（环 / 孤儿检测）对 manifest 顺序链恒为空判定。

## 二、"四套并行执行模型"的事实核对

| # | 名义 | 实际形态 | 生产消费者 | 处置 |
|---|---|---|---|---|
| 1 | `src/workflow/` DAG 引擎 | 独立执行引擎（`WorkflowEngine` + `DagExecutor` + `SafeEvaluator` + `InputResolver` + checkpoint 双实现 + persistence + worker resolver + subagent factory） | **无**（唯 `FlowGraph` 被借用；借用方的两个图导出亦无消费者，其 Mermaid 消费者已迁域内保留） | **删除** |
| 2 | `src/patent/workflow.ts` | 专利域单一执行器（顺序链 + atom 分发 + 审批门中断 + `retry.rewindTo` 有界回退 + 断点续跑） | `patent_workflow` / `patent_workflow_run` 工具、`flexible-plan.toManifest()`、申请撰写 SOP | 保留（域内执行路径） |
| 3 | `flexible-plan` | 阶段级**计划层**（增删改/确认/回退），执行委托 `toManifest()` → `runWorkflow` | `flexible_plan` 工具 | 保留（是计划层，非执行引擎，无重叠） |
| 4 | `src/patent/graph/` SuperStep | 图执行引擎（并行超步 + Reducer + 条件边 + `NodePolicy` + `DegradationMark` + 超步检查点） | `patent_workflow_run(graph=...)` | 保留（图模型为长期方向） |

**结论**：所谓"四套互相冲突"实为「1 套零消费死重 + 1 个计划层 + 2 条同域执行路径（`runWorkflow` ↔ graph，已有等价性测试兜底）」。真正的收敛动作只有一项：删除第 1 套。

## 三、能力覆盖矩阵

| 能力 | `src/workflow`（已删） | `src/patent/workflow.ts` | `src/patent/graph` | 删除后是否有覆盖 |
|---|---|---|---|---|
| checkpoint | 计划级 `WorkflowPlanStore`（InMemory / JsonFile）+ 决策类型 | `JsonFileManifestCheckpointStore`，阶段粒度落盘 `<caseDir>/workflow-runs/` | 超步粒度检查点 + resume | ✅ 域内覆盖 |
| 审批门 / HITL | `HumanCheckpointHandler`（返回 pending，无 UI 接线） | `InterruptStageError` 暂停 + `approvalGrants` 放行 + `approveStageIds` | 审批门走同一 `InterruptStageError` 契约 | ✅ 域内覆盖（已接审批总线 / UI 卡片） |
| 降级 | 无显式降级标记 | 空输出 → `degraded`（completed=false） | `DegradationMark` | ✅ 域内覆盖 |
| resume | 计划内存态 + store 重放 | `resumeFrom` + `manifestId` fail-loud 校验 + 已放行审批门并入 | `resumeCheckpointId` | ✅ 域内覆盖 |
| 重试 | 步骤级 retry 策略 | `maxRetries` + `rewindTo` 有界回退（`rewindCounts`） | `NodePolicy` 重试 / 超时 | ✅ 域内覆盖 |
| 条件分支 | `SafeEvaluator` 条件表达式 | manifest 用 `retry.rewindTo` + atom 分发（不做表达式求值） | 条件边 | ✅ 图引擎覆盖更强形态 |
| 运行中改计划 | `WorkflowPlanAdjustment`（add / remove / reorder / modify step，无调用入口） | `flexible-plan` 阶段级增删改 / 确认 / 回退（有 `flexible_plan` 工具） | — | ✅ 计划层覆盖且有工具入口 |
| 并行度控制 | `maxParallel` 信号量 worker 池 | 串行（阶段顺序链） | 并行超步 | ✅ 图引擎覆盖 |
| 可观测 | 模块私有 `WorkflowEvent`（不入事件矩阵） | 经 gateway 审批 / 工作流事件 | 同左 | ✅ 无损失 |
| 测试 | `tests/workflow/`（`WorkflowEngine.test.ts` 560 行等）+ checkpoint handler spec | `tests/patent/workflow*.spec.ts`（workflow / retry / resume / store） | `tests/patent/graph/` + 等价性测试 | ✅ 保留侧测试更贴生产 |

## 四、DAG 引擎"两个消费者"的真实需求

defer note 与 `.brooks-lint.yaml` 均称 `src/workflow` 有两个消费者。逐条核对：

| 名义消费者 | 实际引用 | 真实需求 | 处置 |
|---|---|---|---|
| `src/patent/graph/adapter.ts` | `import { signalMatches } from "../workflow/signal.js"` —— 指向 **`src/patent/workflow/signal.ts`**（专利域内），而 `src/workflow/` 下并无 `signal.ts` | 无（本就未消费 `src/workflow`） | 记录：suppress 理由该条为路径歧义误记 |
| `src/patent/workflow-dag.ts` | `FlowGraph` + `FlowNodeType`：建顺序链图、`validate()`（环 / 孤儿）、`topologicalLevels()`、Mermaid 输出 | 静态校验 + 可视化。但 manifest `stages` 是**严格顺序链**，`validate()` 恒返回空数组；Mermaid 由该文件自实现（`workflowManifestToMermaid`，仅"格式对齐" `FlowGraph.formatMermaid`） | `manifestToFlowGraph` / `validateWorkflowManifestDag` **无生产消费者** → 删除；**`workflowManifestToMermaid` 有真实消费者**（`src/tool/builtin/patentWorkflowTool.ts` 随 run 产物写 `<runId>.mmd`）→ 迁入 `src/patent/workflow/mermaid.ts` 保留 |

> **过程记录（本次评估的自我纠错）**：首版消费方灰查用错了符号名（查 `formatWorkflowMermaid`，实际导出为
> `workflowManifestToMermaid`），因此一度把 `workflow-dag.ts` 判为"三个导出皆无消费者"。复核时改为按
> `src/patent/workflow-dag.ts` 的实际导出名重查，发现 `src/tool/builtin/patentWorkflowTool.ts` 真实消费该函数
> （写 run 产物 `<runId>.mmd`），遂改为迁移保留而非删除。教训：**消费方核查必须用被测文件的真实导出名，
> 且应在删除执行后再全仓灰查一次**（见 §八 复现方式的两条命令）。

## 五、为什么不选 (b)（保留 DAG 为主引擎）

- **成本方向相反**：(b) 要求把生产链路（`runWorkflow` 已被 3 个工具 / 计划层消费、graph 引擎有三性领域子图与评估框架）改造为薄适配层，属"改活代码去适配死代码"。
- **命名撞名**在 (a) 下自然消失：`src/workflow` 删除后，`workflow` 只剩 `src/patent/workflow`。
- **图模型是长期方向**：`patent/graph` 承载三性领域子图、评估框架（Evaluator / LLM Judge / Verdict Envelope），是产品侧持续投入面。

## 六、风险与回退

| 风险 | 处置 |
|---|---|
| 未来需要"运行中改计划"的通用能力 | `flexible-plan` 已提供阶段级增删改且有工具入口；若需步骤级 adjustment，可从 git 历史完整取回（删除前实现永久留存于历史提交） |
| Mermaid 可视化需求 | `workflowManifestToMermaid` 随删移除；如需重建约 30 行（顺序边 + `rewindTo` 虚线），或复用 `patent/graph` 侧图输出 |
| 未发现的动态引用（CLI / 插件 / 生成器） | 删除前已 grep `src` / `ui` / `apps` / `scripts` 全仓符号引用 = 0；`pnpm check` + `pnpm test` 为最终判据 |

## 七、P6b（共享执行协议）范围修正

架构计划 P6b 原定"四引擎适配 `src/patent/execution-protocol.ts`"。删除 DAG 引擎后，统一对象降为 2 条同域执行路径（`runWorkflow` ↔ graph），二者已有等价性测试与同源契约（审批门 `InterruptStageError`、degraded 语义、阶段 / 超步检查点均已对齐，已知差异见 `src/patent/graph/README.md` 的差异小节）。

**结论**：P6b 独立成卡的价值显著下降；改为「按 `patent/graph/README.md` 已知差异逐条收敛」，在后续改动这两条路径时顺带处理，不单独立项、不新建 `execution-protocol.ts`（避免为单一消费者引入间接层）。

## 八、复现方式

```bash
# 消费方核查（删除前 = 仅 2 条借用；删除后应为 0）
grep -rn "src/workflow\|WorkflowEngine\|DagExecutor\|FlowGraph\|SafeEvaluator\|SubagentWorkflowAgentFactory" \
  src ui apps scripts --include=*.ts --include=*.tsx --include=*.js --include=*.mjs
# 借用者消费者核查（须用真实导出名；`workflowManifestToMermaid` 有真实消费者，另两个没有）
grep -rn "manifestToFlowGraph\|validateWorkflowManifestDag\|workflowManifestToMermaid" src tests --include=*.ts
# 迁移后确认能力仍在（应命中 patentWorkflowTool 与新 home）
grep -rn "workflowManifestToMermaid" src tests --include=*.ts
```
