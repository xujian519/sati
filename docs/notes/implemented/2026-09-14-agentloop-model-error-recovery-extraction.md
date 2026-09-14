# Agent Note: AgentLoop 模型错误恢复链抽取（modelErrorRecovery）

Status: implemented

## Problem

`AgentLoop.handleModelError` 是 TD-AGENT-101 的主体：**365 行单函数承载约 10 条互斥恢复路径**（输出上限自愈 / 流中断恢复与耗尽 / 推理内容缺失重试 / 工具结果补齐 / JSON 自纠 / 四类 reactive 决策 / 输出触顶三级恢复 / 兜底错误面），分支并列且共享可变状态 `state` 与 `tokenCaps`。

上一刀（[AgentLoop turn 出口与恢复策略抽取](./2026-09-14-agentloop-turn-exit-extraction.md)，PR #324）把两条共享恢复策略外迁为 `recoveryStrategies.ts`，但本体仍在 AgentLoop 内：

- 每条路径的顺序是一段隐含契约（例如 reactive 探针必须在「补齐工具结果」之后调用，否则探针看到的消息序列与真实重试请求不一致），却只能靠阅读 365 行从上到下推断；
- 路径之间无结构边界，改一条容易碰到另一条；单条路径无法单独驱动测试，只能靠整条 AgentLoop 回路（假 router）触发；
- 文件仍列在 TD-SIZE-001 与 issue #147。

## Decision

把整个 `handleModelError` 本体迁到 `src/agent/loop/modelErrorRecovery.ts`，拆为**每条路径一个具名步骤函数 + 一个调度入口**：

| 文件 | 行数 | 内容 |
|---|---|---|
| `src/agent/loop/modelErrorRecovery.ts`（新） | 613 | `RecoveryOutcome`（`handled` 或 `{kind:"unhandled"}`）、`ModelErrorRecoveryDeps`（继承 `TurnExitDeps` + `jsonSelfCorrect` / `missingToolResultRecoveryContext` / `dispatchLifecycle` / `runAutoCompact`）、9 个步骤函数、`recoverFromModelError` 调度入口、`tryReactiveRecover` 探针（原 AgentLoop 私有方法） |
| `src/agent/loop/AgentLoop.ts` | 2130 → **1740** | 删除 `handleModelError`（365 行）与 `tryReactiveRecover`（24 行）；`run()` 调用点改为 `recoverFromModelError(this.modelErrorRecovery, …)`；构造期建立依赖袋 |

步骤函数即恢复路径，顺序由调度入口显式写出：

```
learnOutputCapFromRejection → recoverFromStreamInterruption（非中断则清零计数）
  → retryMissingReasoningContent → projectMissingToolResults（fall-through）
  → recoverFromJsonSelfCorrect → recoverFromReactiveDecision
  → recoverFromMaxOutputLimit → surfaceModelError（兜底）
```

每步返回 handled（`continue`/`return`）即接管，返回 `unhandled` 才落到下一步；`surfaceModelError` 保证调度入口的返回类型里不含 `unhandled`。

**行为不变的三道验证**：

1. **逐行对拍**：脚本对原 `handleModelError` 块与新模块做归一化后逐行比对（`this.X` ↔ `deps.X`、`assembled.error` ↔ `error`），差异全部是「守卫取反提前返回」「签名拆分为多函数」「依赖袋入参」三类重构性改写，无语句丢失或改写；`tryReactiveRecover` 搬迁体逐字一致（仅缩进与多余类型注解差异）。
2. **既有回路测试**：`tests/agent/**` 392 用例全绿（含 `stream-interruption-recovery` / `output-cap-rejection` / `context-cap` 三条覆盖本次搬迁路径的假 router 集成测试）。
3. **全量**：`pnpm test` 4272 tests / 4268 pass / 0 fail / 4 skipped（改动前 4250 / 4246，差额为新增 22 条直测）。

事件面按 `pnpm gen:event-matrix` 重生成（15 行）：`assistant_message` / `stop_failure` 的生产者由 `AgentLoop.ts` 换为 `modelErrorRecovery.ts`，其余为行号位移。

## Alternatives considered

- **保留 `handleModelError` 骨架、只把 reactive 四决策拆出去** — 落选：reactive 只占约 110 行，剩余 250 行仍是并列分支；且 reactive 探针的位置契约只有放进调度链才看得出来（本轮专门用一条测试锁定「探针在工具结果补齐之后」）。
- **做成 `ModelErrorRecovery` 类（沿用 TokenCapManager/ToolContextFactory 的 host-deps 接口写法）** — 落选：状态全在 `TurnRuntimeState`，本模块无自有状态，类只会多一层 `this`；自由函数 + 依赖袋与上一刀的 `recoveryStrategies.ts` 同构。
- **把 `runAutoCompact` / `createBudgetEvaluator` / `createModelRequest` 一并迁进本模块的依赖面** — 落选：这三个执行器服务 `prepareModelCall` 等阶段方法，迁走会让 AgentLoop 反向依赖本模块；本模块按窄接口 `AutoCompactRunner` 只需 `model-error-recovery` 一路参数。
- **把 `missingToolResultRecoveryContext` 从 AgentLoop 迁出**（它只读 config） — 落选：`executeToolCalls` 也在用，随本刀迁走会把「工具结果补齐」的私有辅助挪进恢复链模块，反向拉长依赖；以 thunk 注入，两处各取所需。
- **让 `handleModelError` 薄包装保留在 AgentLoop** — 落选：调用点只有一处，直接改调 `recoverFromModelError` 后 `ModelErrorRecoveredResult` 类型别名随之删除，AgentLoop 少一个概念。

## Consequences

- `AgentLoop.ts` 2130 → 1740 行；TD-AGENT-101（god function + 策略被复制进姊妹函数）结清：本体已无 300+ 行函数，共享策略与恢复路径都有独立模块位置。
- 恢复链的顺序契约从「阅读顺序」变成「代码顺序 + 注释 + 顺序锁定测试」；重排步骤会改变行为，模块头注释已写明。
- 步骤函数导出即可直测：新增 22 条行为基线（`tests/agent/loop/modelErrorRecovery.spec.ts`），覆盖每条路径的触发条件与产物、`give_up`/探针抛错/未接线三种「不接管」、以及调度顺序与计数清零。
- `recoverFromStreamInterruption` 内的局部 `agentError` 由 `error`（遮蔽 `assembled.error`）改名为 `exhaustedError`，仅为消除同名遮蔽；产物载荷逐字未变。
- 无工具契约改动，llm-replay fixture 请求键不受影响（未重录）。
