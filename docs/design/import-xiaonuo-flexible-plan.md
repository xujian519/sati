# 引入 XiaoNuo legal-bus「灵活计划」层 — 设计文档

- 状态：**已实施**（P1–P4 落地，2026-08：`src/patent/flexible-plan.ts` + `flexible-plan-store.ts`；P3 的 workflow 断点恢复以 `workflow-store.ts` 持久化 + runs 落盘形式交付；checklist/intent-detector/orchestrations 未移植——以现有 checker/slop 确定性规则与 `patent_plan_task` 工具契约替代）
- 日期：2026-08-04
- 范围：仅 A1（flexible-plan 层），A2–A5 不在本期
- 移植源：`/Users/xujian/projects/归档/XiaoNuo/src/legal-bus/`（FlexiblePlan / ChecklistEngine / LegalIntentDetector / LegalStateMachine / CaseStore）

---

## 实施状态速览（2026-08 对照代码）

| 条目 | 状态 | 代码位置 |
|------|------|---------|
| flexible-plan 阶段级状态机（增删改/确认/回退/法条判定） | ✅ 已实施 | `src/patent/flexible-plan.ts` |
| 存储（`<caseId>.json` 原子写） | ✅ 已实施 | `src/patent/flexible-plan-store.ts` |
| `toManifest()` 交 workflow 执行 | ✅ 已实施 | `flexible-plan.ts` → `src/patent/workflow.ts` |
| workflow 断点恢复 / runs 持久化 | ✅ 已实施（runs 落盘） | `src/patent/workflow-store.ts`、`paths.ts`（CASE_WORKFLOW_RUNS_REL） |
| checklist / intent-detector / orchestrations 移植 | ❌ 未实施（确定性规则复用 checker/slop；意图检测走 agent 提示词协议） | — |

## 1. 背景与目标

Sati `src/patent/` 目前有三个互不驱动的组件：

| 组件 | 职责 | 缺口 |
|---|---|---|
| `plantask.ts`（139 行） | 计划级 HITL 状态机（planning→…→finished），`replanTasks` 哈希增量续跑 | **无阶段级状态**；计划只能整表替换，不能运行中增删改单个阶段；无 per-stage 确认/回退 |
| `workflow.ts`（566 行） | 声明式阶段管线执行器（`runWorkflow` 纯函数） | **manifest 不可变**；审批门中断（`InterruptStageError`）后**无恢复机制**（`WorkflowRunStore` 只存最终结果） |
| `reasoning/fact-blackboard.ts`（313 行） | 事实黑板（facts / reasoningChains / ruleConstraints / ConfirmedRuleSet / ArticleJudgment / toJSON） | **standalone，无人消费** |

XiaoNuo legal-bus 的 Layer 3「灵活计划」（`FlexiblePlan` + `ChecklistEngine`）恰好补上"运行中可调整的阶段级生命周期 + 逐项检查清单"这一层。本方案把该层移植进 Sati，并**打通 plantask（计划级状态）→ flexible-plan（阶段级状态）→ workflow（执行）三条链路**，以 FactBlackboard 为共享数据总线。

不搬 XiaoNuo 的 Layer 1（FrameworkEngine 法条框架，Sati 有 checker/evidence 替代）、Layer 4（PatternLearner 模式学习，Phase 2）、ReasoningWalker（依赖其知识图谱，Sati 知识检索路径不同）、LegalBus/LegalStateMachine 整体（Sati 用 plantask + 新 flexible-plan 替代，仅吸收其 Checkpoint/rollback 语义）。

---

## 2. 现状核对（代码级）

### 2.1 Sati 侧可复用资产（零成本）

- `FactBlackboard`（`src/patent/reasoning/fact-blackboard.ts`）：`setArticleJudgment`（L248-252）、`ConfirmedRuleSet.activeConstraints`（L60-69）、`toJSON/fromJSON`（L263-313）——**attachArticleJudgment 与检查清单确认的直接数据底座，本次只接线不改写**。
- `plantask.ts`：`PlanTaskStateMachine`（L36-58）、`hashStep`/`replanTasks`（L80-139）——外层计划状态与增量续跑。
- `workflow.ts`：`WorkflowManifest`/`WorkflowStage`（L29-67）、`validateWorkflowManifest`（L149-197）、`runWorkflow` 中断路径（L287-292）、`WorkflowRunStore` 契约（L129-135）。
- `workflow-store.ts`：`JsonFileWorkflowRunStore` 原子写模式（L49-56）。
- `checker/`（RuleEngine + 11 规则域）、`slop-engine.ts`（`runChecklist` L307-354）、`worker-contract.ts`（`validateWorkerOutput`）——ChecklistEngine 的**确定性规则源**。
- `assets/patent-rules/orchestrations/{invalidation,infringement}.yaml`——已含 `discoveryStages`/`availableArticles`/`executionTemplate`（即 FlexiblePlan 的初始阶段模板），**当前无任何代码加载**，本次首次接通。
- `src/workflow/protocol/types.ts` L153-158 `WorkflowPlanAdjustment`——运行中改计划的既有语义参考（add_step/remove_step/reorder/modify_step）。
- 测试模板：`tests/patent/plantask.spec.ts` / `workflow-retry.spec.ts`。

### 2.2 XiaoNuo 移植源关键实现（已读源码）

- `FlexiblePlan.ts`：`addStage`/`reorderStage`/`removeStage`/`confirmStage`（确认后自动推进到下一未确认阶段）/`rollbackStage`（其后的 confirmed 全部置 rejected，回到目标阶段）/`attachArticleJudgment`/`lockFacts`/`generatePlan`/`save`/`load`/`complete`/`abandon`。
- `ChecklistEngine.ts`：`checkStage`（LLM 逐项检查，失败降级为 warning 提示人工确认）、`loadConstraints`（预定义约束映射：drafting 6 条 / invalidation 6 条 / infringement 2 条，含 `applicableStages` 绑定）、`summary`。
- `LegalIntentDetector.ts`：`@legal` 显式前缀 + 15 组关键词模式 + 专利语境信号门控 + 置信度计算。
- `LegalStateMachine.ts`：白名单转移表 + 检查点（Checkpoint）+ `rollback`（目标检查点之后的检查点标记 rolledBackAt）。
- `CaseStore.ts`：`case.json`（状态快照覆盖写）+ `blackboard.json` + `history.jsonl`（追加写，永不修改）+ `plan.json`。

---

## 3. 设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| FlexiblePlan 落点 | **新建独立层** `src/patent/flexible-plan.ts`，不塞进 plantask / workflow | plantask 是 stateless 纯函数集（工具无会话状态）；runWorkflow 是 manifest 不可变的纯函数。独立层天然承载"阶段级状态 + 运行中增删改 + 检查点" |
| 工具形态 | **stateless**（对齐 `patent_plan_task`）：每次调用传 `state`，返回新 `state` | 与现有 patent 工具契约一致，避免引入会话状态管理 |
| 执行衔接 | flexible-plan 生成 `WorkflowManifest`（`toManifest()`）→ 交 `runWorkflow` 执行 | 保持"一条声明式路径"原则（workflow.ts L4-6），不引入第二执行器 |
| 数据总线 | `FactBlackboard` 承担全部事实/约束/法条判定存储；flexible-plan 只存阶段与状态 | 避免双份数据，`toJSON/fromJSON` 检查点天然可用 |
| ChecklistEngine 规则源 | 预定义约束映射（移植 `loadConstraints`）+ 确定性规则门（checker/slop）预填，LLM 逐项检查为可选增强 | 复用 Sati 已有确定性引擎，LLM 轨可后置 |
| workflow 断点恢复 | `runWorkflow` 中断时把已执行阶段 + PipelineState 存为 checkpoint；新增 `resumeWorkflow` 从 `nextStageIndex` 续跑 | 最小改动：保留 L287-292 中断路径，只加持久化与续跑入口 |
| 意图检测 | 移植 `LegalIntentDetector`，caseType 对齐 orchestrations id（invalidation/infringement/drafting/oa_response…） | 让"用户反馈 → 计划调整意图（确认/修改/拒绝/回退/跳过）"从 prompt 协议变成可测代码 |
| orchestrations 资产 | 新建 `src/patent/orchestrations.ts` 加载 `assets/patent-rules/orchestrations/*.yaml`，作为 `createFlexiblePlan` 的初始阶段模板 | 资产已存在 7 个月无人加载，本次接通 |

---

## 4. 数据模型（新类型，`src/patent/flexible-plan.ts`）

```ts
export type FlexibleStageStatus = "pending" | "confirmed" | "rolled_back";

/** 阶段（对齐 WorkflowStage.strategy/atom/params，补阶段级状态）。 */
export type FlexibleStage = {
  id: string;
  name: string;
  goal: string;
  strategy: "chain" | "react" | "sub_agent";
  atom?: string;                       // 可选：交 runWorkflow 原子执行
  params?: Record<string, unknown>;
  status: FlexibleStageStatus;
  artifacts: string[];
  constraintIds: string[];             // 引用 FactBlackboard 规则约束
  articleJudgments: string[];          // 引用 FactBlackboard 法条判定 id
};

export type FlexiblePlanStatus = "active" | "completed" | "abandoned";

export type FlexiblePlanState = {
  caseId: string;
  caseType: string;                    // 对齐 orchestrations id
  technicalField?: string;
  status: FlexiblePlanStatus;
  stages: FlexibleStage[];
  currentStageId?: string;             // 缺省 = 首个 pending 阶段
  createdAt: string;
  updatedAt: string;
};

/** 操作结果（工具友好：文本 + 结构化 state）。 */
export type FlexiblePlanOpResult =
  | { ok: true; message: string; state: FlexiblePlanState }
  | { ok: false; message: string };
```

方法集（纯函数 + 守卫，对齐 FactBlackboard 风格）：

- `createFlexiblePlan(caseId, caseType, options?: { technicalField?, stages? })` — stages 缺省从 orchestrations `discoveryStages` 生成
- `addStage(state, stage)` / `removeStage(state, stageId)` / `reorderStages(state, stageIds)`
- `confirmStage(state, stageId)` — 置 confirmed，推进 `currentStageId` 到下一 pending
- `rollbackStage(state, stageId)` — 该阶段及其后 confirmed 阶段置 rolled_back，回到该阶段（吸收 LegalStateMachine 检查点语义：rolled_back 保留审计）
- `attachArticleJudgment(state, stageId, articleId, blackboard)` — 写入黑板的 `setArticleJudgment` + 阶段 `articleJudgments` 引用
- `toManifest(state)` — 生成 `WorkflowManifest`（stages 过滤 rolled_back，映射 strategy/atom/params）
- `toJSON(state)` / `fromJSON(text)` — 检查点（镜像 FactBlackboard L263-313）
- `complete(state)` / `abandon(state, reason)`

---

## 5. 文件级改动清单

### 5.1 新增

| 文件 | 内容 | 规模估算 |
|---|---|---|
| `src/patent/flexible-plan.ts` | 上述类型 + 方法集（核心） | ~250 行 |
| `src/patent/flexible-plan-store.ts` | `FlexiblePlanStore` 契约 + `JsonFileFlexiblePlanStore`（复用 workflow-store 原子写模式，路径 `<dir>/<caseId>.json`） | ~90 行 |
| `src/patent/checklist/engine.ts` | `ChecklistItem`/`ChecklistEngine`：`createChecklist(caseType)`（移植 loadConstraints 映射）+ `confirmItem/modifyItem/rejectItem` + `summary`；`runDeterministicChecks` 复用 checker/slop/worker-contract 预填 | ~180 行 |
| `src/patent/checklist/index.ts` | barrel | ~15 行 |
| `src/patent/intent-detector.ts` | 移植 LegalIntentDetector（关键词表裁剪对齐 orchestrations id；`@legal` 前缀保留为显式触发） | ~200 行 |
| `src/patent/orchestrations.ts` | `loadOrchestrationsDir(dir)` + `discoveryStagesToFlexibleStages()`（YAML→FlexibleStage） | ~120 行 |
| `src/tool/builtin/patentFlexiblePlanTool.ts` | `patent_flexible_plan` 工具（action: create/add_stage/remove_stage/reorder_stages/confirm_stage/rollback_stage/attach_judgment/to_manifest/complete/abandon；stateless 传 state） | ~200 行 |

### 5.2 修改

| 文件 | 改动 |
|---|---|
| `src/patent/workflow.ts` | ① 新增 `WorkflowRunCheckpoint` 类型（manifestId/completedStages/state/nextStageIndex/interruptedAt）；② `runWorkflow` 中断分支（L287-292）在返回前经 `options.checkpoint?.save(cp)` 存快照；③ 新增 `resumeWorkflow(manifest, checkpoint, executor, options)` 从 `nextStageIndex` 续跑（复用 L205-386 主循环，抽出共享内部函数 `runStagesFrom`） |
| `src/patent/index.ts` | barrel 导出 flexible-plan / checklist / intent-detector / orchestrations / 新工具相关类型 |
| `src/tool/builtin/createBuiltinRegistry.ts` | 注册 `patent_flexible_plan`（参照 L209 patent_plan_task 注册位） |

### 5.3 不改动

- `src/patent/reasoning/fact-blackboard.ts`（已完备，仅消费）
- `src/patent/plantask.ts`（外层状态继续独立，flexible-plan 不依赖它；两者由 agent 经工具协调）
- `src/patent/workflow-store.ts`（持久化模式复用，不重写）

---

## 6. 测试计划（`tests/patent/` 镜像）

| 测试文件 | 覆盖 |
|---|---|
| `flexible-plan.spec.ts` | 阶段增删改/重排；confirm 推进；rollback 审计语义；toManifest 过滤 rolled_back；toJSON/fromJSON 往返；守卫（重复 id、空 stages、unknown stageId fail-closed） |
| `flexible-plan-store.spec.ts` | save/load/list；runId 安全字符校验；原子写（临时文件清理） |
| `checklist.spec.ts` | createChecklist 三类 caseType 映射；confirm/modify/reject 状态流转；modified 覆盖原约束；summary 统计 |
| `intent-detector.spec.ts` | 15 组关键词命中；`@legal` 显式触发；专利语境门控（"清楚"无专利信号不触发）；置信度 |
| `orchestrations.spec.ts` | 加载 invalidation/infringement.yaml；discoveryStages→FlexibleStage 映射；缺文件 fail-closed |
| `workflow-resume.spec.ts` | 中断后 checkpoint 持久化；resumeWorkflow 跳过已完成阶段续跑；已完成阶段结果不被重算 |

验收命令：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`。

---

## 7. 分阶段实施计划

| Phase | 内容 | 交付 | 验证 |
|---|---|---|---|
| **P1** | `flexible-plan.ts` + `flexible-plan-store.ts` | 核心数据模型与状态机 | 两个 spec 全绿 |
| **P2** | `checklist/` + `intent-detector.ts` | 检查清单与意图检测 | 两个 spec 全绿 |
| **P3** | `workflow.ts` 断点恢复（checkpoint + resumeWorkflow） | 打通"暂停≠失败" | workflow-resume.spec 全绿 + 既有 workflow 测试回归 |
| **P4** | `orchestrations.ts` + `patentFlexiblePlanTool.ts` + barrel + registry | 工具面完整（stateless 契约） | orchestrations/flexible-plan 工具集成测试 + `pnpm test` 全量 |
| **P5** | 全量验证 + 文档收尾 | `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` 全绿 | 提交（conventional commits） |

依赖关系：P3 不依赖 P1/P2（runWorkflow 独立改动）；P4 依赖 P1–P3 全部完成。建议顺序 P1 → P2 → P3 → P4 → P5。

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `resumeWorkflow` 与现有 retry/rewind 逻辑（L304-336）交互复杂 | 复用同一主循环（`runStagesFrom` 抽共享函数）；checkpoint 记录 `rewindCounts`/`signalCache` 状态一并持久化 |
| stateless 工具传全量 state 变大（长计划） | 对齐 patent_plan_task 既有契约；计划 >50 阶段属异常，可后续加"state 存 store、工具传 caseId"变体 |
| checklist LLM 逐项检查引入不确定性 | 默认走确定性预填（checker/slop）；LLM 轨默认关闭（`enableLlmCheck: false`），二期再开 |
| orchestrations YAML 结构无 schema 校验 | 加载时轻量守卫（镜像 `validateWorkflowManifest` 风格），非法即抛错；缺文件 fail-closed |
| 与 `assets/patent-rules/orchestrations/*.yaml` 的构建拷贝链 | 需在 `package.json build` 的 cpSync 清单追加（如目录已含则免，实施时核对） |

---

## 9. 不做（本期明确排除）

- FrameworkEngine（法条框架）/ ReasoningWalker（图谱遍历）/ PatternLearner / MemoryStore——Sati 有等价或后续再做
- XiaoNuo `CaseStore.history.jsonl` 追加日志——Sati 白盒审计走 `events/` 或 `ApprovalStore`，不在本期引入第三种日志格式
- 会话级状态持久化（工具保持 stateless）
- A2–A5 全部方案
