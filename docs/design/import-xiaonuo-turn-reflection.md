# 引入 XiaoNuo 回合反思 — 推理质量闭环设计

- 状态：草案（待评审）
- 日期：2026-08-06
- 范围：推理质量闭环。**分两步**：第一步=`patent_workflow_run` 阶段级输出评估（低风险、零 LLM 增量、不改主循环）；第二步=运行时回合反思（中期，AgentLoop 拆解后）
- 移植源：`/Users/xujian/projects/XiaoNuo Agent/packages/agent-core/src/reasoning/turn-orchestrator.ts`（668 行）+ `strategy-router.ts`（328 行）

---

## 1. 背景与目标

Sati 现状：

| 组件 | 能力 | 缺口 |
|------|------|------|
| `src/agent/loop/AgentLoop.ts`（**3569 行，无直接测试**） | 主循环：路由→压缩→流式→工具→判定继续 | **无回合级质量评估**（grep judge/score/reflection 零命中）；策略选择只靠 router 分档 |
| `src/router/tokenSaver/`（280 行） | judge 模型按 tier 分档（便宜模型做简单任务） | 只决定"用什么模型"，**不决定"怎么推理"** |
| `src/methodology/`（12 文件） | 8 种思维方法关键词匹配注入 system prompt | **预注入、一次性**，无回合间动态调整 |
| `src/patent/quality-gate.ts` / `slop-engine.ts` / `checker/` | 确定性质量门（slop 43 分、checker 68 条、patent_eval 0.7 线） | 是**交付前检查**，不是**回合内反馈** |
| `src/patent/reasoning/syllogism.ts` + `fact-blackboard.ts` | 专利域三段论 + 事实黑板 | 无运行时闭环消费 |

XiaoNuo TurnOrchestrator 补的是"**每回合自评估 → 低质续行 → 策略切换**"闭环：LLM-as-Judge（结构化 JSON：score/issues/complete/suggestedStrategy）+ 启发式回退（专利规则加减分：需检索未调用工具扣 0.18）+ 逃生舱（连续 3 次 <0.4 分突破域策略锁死）+ 收益递减检测（两轮提分 <0.05 提前终止）+ 预算硬约束（token ≤30%、延迟 ≤8s、轮数 ≤3）。

**核心约束**：AgentLoop 是 3569 行上帝文件且无直接测试（技术债报告 P1-3）。因此本方案**第一步完全不触碰主循环**，只增强 `patent_workflow_run` 阶段执行；第二步才在拆解后的主循环上引入完整闭环。

---

## 2. 现状核对（代码级）

### 2.1 Sati 侧可复用资产（零成本）

- `src/patent/quality-gate.ts`（539 行）：`CitationGate`（R1 存在性 + R2 语境相关性）+ 风险词/审批词门。
- `src/patent/slop-engine.ts`：`runChecklist`（8 项快检）+ 43 分五维评分（通过线 35）。
- `src/patent/checker/engine.ts`：`defaultPatentRules()` 68 条确定性规则（blocked/needs_revision/pass 聚合判级）。
- `src/patent/worker-contract.ts`：Worker 契约（requiredFields 缺失 → degraded 标记）。
- `src/patent/atoms/handlers/`：阶段 handler 注册表（`registerBuiltinAtoms` 幂等），阶段执行有 `PipelineState` 上下文。
- `src/tool/builtin/patentWorkflowRunTool.ts`：`patent_workflow_run` 原子执行器（注入 LLM + nuo-patent provider）。
- `scripts/patent-eval.mjs`：离线业务评测（真实 LLM + 规则门收口）——第二步参数校准的基准设施。
- 测试模板：`tests/patent/workflow.spec.ts`、`tests/patent/worker-contract.spec.ts`。

### 2.2 XiaoNuo 移植源关键机制（已读源码）

- 评分流程：LLM 结构化 JSON（`{"score":0.0-1.0,"reasoning":"...","issues":[...],"complete":true,"suggestedStrategy":"..."}`）→ 失败回退启发式评分（`turn-orchestrator.ts:163-246`：基准分 0.78，未调用检索工具 -0.18、结论无置信度 -0.15、有步骤完成 +0.08…）。
- 逃生舱（`:60`）：连续低分计数 ≥3 次且 <0.4 → 突破域策略锁死。
- 收益递减（`:233-239`）：连续两轮提分 <0.05 且 ≥0.6 → 提前终止。
- 预算（`ReasoningBudgetTracker`）：LLM 开销 ≤ 主对话 30%、额外延迟 ≤8s、额外轮数 ≤3，超限降级启发式。
- 策略切换：写入 `reasoningHints`（增量提示），不直接改 systemPrompt。

---

## 3. 设计决策

### 第一步（低风险，先行）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 落点 | `patent_workflow_run` 阶段完成后跑**确定性评估**，不碰 AgentLoop | 阶段边界天然是"回合"；主循环改动风险（R7-1）完全规避 |
| 评估器 | 复用 Sati 既有评分：slop 43 分 + checker 68 条 + worker-contract requiredFields；**不移植** XiaoNuo 专利加减分规则 | 评分标准只有一套（Sati 侧），避免双质量观（R7-4） |
| 反馈 | 评估结果写阶段 meta（`degraded`/`needs_revision`/`pass`），触发 `retry` 或进入下阶段 | 与现有 `degraded` 标记语义一致（worker-contract） |
| LLM 增量 | **零**（第一步纯确定性） | 成本风险（R7-2）为零 |
| 开关 | env `SATI_STAGE_REFLECTION=1` 灰度 | 双轨演进 |

### 第二步（中期，AgentLoop 拆解后）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 前置 | AgentLoop 拆解：先把循环体抽成可测接口（如 `TurnOrchestrationCycle`），补集成保护网测试 | 上帝文件上直接挂反思 = 不可回归（R7-1） |
| Judge 模型 | **最便宜的 judge 模型**（对齐 router tokenSaver 做法）；启发式评分优先（确定性、零成本） | 成本风险（R7-2） |
| 边界 | 反思只改 `reasoningHints`（怎么推理），**不改 router 的 tier/模型决策**（用什么模型） | 防双判定环路（R7-3） |
| 预算 | 对齐 XiaoNuo：token ≤30%、延迟 ≤8s、轮数 ≤3，**专利场景先收紧到 2 轮** | 宁严勿宽（R7-2） |
| 参数校准 | 先在 `scripts/patent-eval.mjs` 离线集校准逃生舱/收益递减阈值，再灰度 | R7-5 |
| 与 methodology 关系 | methodology=场景预注入（保留）；反思=回合间动态调整（增量提示） | 双 prompt 注入不冲突（R7-6） |

---

## 4. 数据模型（第一步，`src/patent/reflection/stage-evaluator.ts`）

```ts
export type StageReflectionVerdict = "pass" | "needs_revision" | "degraded";

export interface StageReflection {
  stageId: string;
  verdict: StageReflectionVerdict;
  score: number;                    // 0-1 归一（slop 43 分 → 0-1、checker 判级映射）
  checks: {
    slop: { score: number; passed: boolean };
    checker: { verdict: "blocked" | "needs_revision" | "pass"; failures: string[] };
    contract: { missingFields: string[] };
  };
  action: "continue" | "retry" | "mark_degraded";
  reason: string;
}

export interface StageEvaluatorOptions {
  enable?: boolean;                 // SATI_STAGE_REFLECTION=1
  slopThreshold?: number;           // 默认 35/43
  checkerMode?: "block-on-must" | "block-on-all";  // 对齐 checker 聚合语义
  maxRetries?: number;              // 默认 1（对齐 workflow retry 语义）
}

export async function evaluateStage(
  stage: WorkflowStage,
  output: unknown,
  options: StageEvaluatorOptions,
): Promise<StageReflection>;
```

聚合规则（确定性）：
- checker `blocked` → `action: mark_degraded`（不阻断流程，写 degraded 标记——对齐 worker-contract）
- checker `needs_revision` 或 slop < 阈值 → `action: retry`（触发阶段 retry，最多 maxRetries 次）
- 其余 → `action: continue`

---

## 5. 文件级改动清单

> ⚠️ 本期仅记录方案，**未实施任何代码改动**。

### 5.1 第一步（低风险）

| 文件 | 内容 | 规模估算 |
|---|---|---|
| **新增** `src/patent/reflection/stage-evaluator.ts` | §4 评估器（纯函数，复用 slop/checker/worker-contract） | ~150 行 |
| **新增** `src/patent/reflection/index.ts` | barrel | ~10 行 |
| **修改** `src/patent/atoms/handlers/builtin/`（阶段 handler 基类或 pipeline 装配点） | `SATI_STAGE_REFLECTION=1` 时阶段完成后调 `evaluateStage`，按 action 处理 | ~40 行 |
| **修改** `src/tool/builtin/patentWorkflowRunTool.ts` | env 开关读取 + 评估结果写入 run 结果（`reflections: StageReflection[]`） | ~20 行 |
| **修改** `src/patent/index.ts` | barrel 导出 | ~5 行 |

### 5.2 第二步（中期，前置条件：AgentLoop 拆解完成）

| 文件 | 内容 |
|---|---|
| **新增** `src/agent/reflection/turn-orchestrator.ts` | XiaoNuo `runTurnOrchestration` 移植：LLM-judge + 启发式回退 + 逃生舱 + 收益递减 + budget |
| **新增** `src/agent/reflection/reasoning-hints.ts` | 策略切换提示写入（增量，不重建 system prompt） |
| **修改** `src/agent/loop/`（拆解后的循环接口） | macro-turn 边界挂 `runTurnOrchestration` |
| **修改** `src/router/tokenSaver/` | **不改**（边界：反思不改 tier 决策） |

---

## 6. 风险与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| **上帝文件改动风险**（AgentLoop 3569 行无直接测试） | 高 | 第一步完全不碰主循环（只增强 patent_workflow_run）；第二步以 AgentLoop 拆解 + 保护网测试为**硬前置**，未拆解不引入 |
| **成本放大**（LLM-judge 每回合一次；Sati 用户 BYOK 成本敏感） | 高 | 第一步零 LLM；第二步 judge 用最便宜模型 + 预算宁严勿宽（专利场景 2 轮上限）+ 启发式优先 |
| **与 router 双判定冲突**（tokenSaver 已每轮 LLM 分档） | 高 | 边界硬约束：反思只改 `reasoningHints`（怎么推理），不改 tier/模型（用什么模型）；两维正交 |
| 启发式评分双标准 | 中 | 不移植 XiaoNuo 专利加减分规则；复用 Sati slop/checker/patent_eval 唯一评分体系 |
| 逃生舱/收益递减参数未校准 | 中 | 离线 `patent-eval.mjs` 集校准后再上线；灰度开关 |
| 与 methodology 注册表冲突 | 中 | methodology=场景预注入、反思=回合间动态调整；反思写增量提示而非重建 prompt |
| 反思判定写入证据图污染语义 | 中 | 反思记录走 telemetry/审计；**不进证据图**（见 `import-xiaonuo-provenance.md` C3） |

---

## 7. 测试计划

| 测试文件 | 覆盖 |
|---|---|
| `tests/patent/reflection/stage-evaluator.spec.ts` | 纯函数：slop 43 分归一；checker 判级映射；聚合规则（blocked→degraded / needs_revision→retry / pass→continue）；maxRetries 上限；开关关闭时直通 |
| `tests/patent/reflection/workflow-reflection.spec.ts` | 集成：阶段输出低质 → retry；checker blocked → degraded 标记入 run 结果；reflections 数组序列化 |
| （第二步）`tests/agent/reflection/turn-orchestrator.spec.ts` | LLM-judge JSON 解析（含失败回退启发式）；逃生舱触发；收益递减提前终止；budget 超限降级 |

验收命令：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`。

---

## 8. 分阶段实施计划

| Phase | 内容 | 交付 | 验证 |
|---|---|---|---|
| **第一步-P1** | `stage-evaluator.ts`（纯函数） | 评估器核心 | stage-evaluator spec 全绿 |
| **第一步-P2** | handler 接线 + env 开关 + run 结果扩展 | 阶段级评估上线（默认关闭） | workflow-reflection spec + 既有 workflow 测试回归 |
| **第二步-P0（前置）** | AgentLoop 拆解：循环体抽 `TurnOrchestrationCycle` 可测接口 + 保护网测试 | 可回归的循环边界 | 既有 873 测试全绿 + 新增循环集成测试 |
| **第二步-P1** | turn-orchestrator 移植（LLM-judge + 启发式 + 逃生舱 + 收益递减 + budget） | 回合反思内核 | turn-orchestrator spec 全绿 |
| **第二步-P2** | macro-turn 边界挂接 + `reasoningHints` + 离线参数校准 | 运行时闭环（灰度） | 离线 eval 校准 + 全量回归 |

依赖关系：第一步不依赖第二步；第二步 P0（拆解）是 P1/P2 硬前置。

---

## 9. 不做（本期明确排除）

- **第一步不触碰** `AgentLoop.ts`（任何主循环改动都属于第二步，且以拆解为前置）
- **不移植** XiaoNuo 专利启发式加减分规则（评分体系唯一：Sati slop/checker/patent_eval）
- **不改** `router/tokenSaver/` 的 tier/模型决策（反思与路由两维正交）
- **不把**反思判定写入证据图 / 检索 provenance（C3）
- **不引入** NuoMind v2 Blueprint/PulseKernel 引擎（Sati 明确不搬，methodology 注册表已承担方法论注入）
