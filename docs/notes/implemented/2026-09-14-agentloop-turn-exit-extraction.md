# Agent Note: AgentLoop turn 出口与恢复策略抽取（turnExit / recoveryStrategies）

Status: implemented

## Problem

`src/agent/loop/AgentLoop.ts`（2433 行）在轮次 1–4 拆解后仍持有两组与主循环阶段方法不同寿命的代码：

- **turn 出口与中止捕获**（`emitStatus`、`createAbortStatus`、`captureTurn`、`terminateTurn`、`captureAbortedPartial`、`abortTurn`）：~25 处终止出口共用，改事件顺序或捕获语义要在 1600 行之后找；
- **共享恢复策略**（`continueWithTransientPrompt`、`emitEmptyOutputTokenBump`、`recoverFromMaxOutputBump`、`recoverFromEmptyResponse`）：台账 TD-AGENT-101 的 2026-08-27 复核指出这对策略原被复制在 `assembleAndRecover`／`handleModelError`／`handleNoToolCalls` 三处，抽取后仍是 AgentLoop 私有方法——共享关系只写在注释里，没有结构保证。

后果：文件仍列在 TD-SIZE-001（大文件）与 issue #147（AgentLoop/createLocalGateway 巨型文件）；阶段方法读起来要先跨过 300 行出口仪式。

## Decision

AgentLoop.ts 只保留**主循环阶段方法与其依赖**，把上述两组迁到两个新模块（逐字搬迁）：

| 文件 | 行数 | 内容 |
|---|---|---|
| `src/agent/loop/turnExit.ts` | 170 | `TurnExitDeps`（`tokenCaps` + `contextRuntime` + `now`）、`TurnStepContinue`/`TurnStepReturn`、`TurnResultOptions`、`buildTurnResult`、`makeTurnResultBuilder`、`emitStatus`、`createAbortStatus`、`captureTurn`、`terminateTurn`、`captureAbortedPartial`、`abortTurn` |
| `src/agent/loop/recoveryStrategies.ts` | 225 | `continueWithTransientPrompt`（无依赖）、`emitEmptyOutputTokenBump`、`recoverFromMaxOutputBump`、`recoverFromEmptyResponse`、`EMPTY_LENGTH_OUTPUT_RETRY_FLOOR` |

`AgentLoop.ts` 2433 → **2130 行**；构造期建立唯一依赖袋 `this.turnExit: TurnExitDeps = { tokenCaps, contextRuntime: dependencies.context, now }`，调用点由 `this.X(...)` 改为 `X(this.turnExit, ...)`。`createTurnResult` 保留为 3 行私有包装（绑定 `now`），使 12 处调用点零改动。

**行为不变的两道验证**：

1. **逐字迁移对拍**：脚本把新模块里的方法体做逆向改写（回调名还原为 `this.X(`、`deps.tokenCaps` → `this.tokenCaps`、去掉插入的 `deps`/builder 行）后与改动前的方法体比较（忽略空白），11 个搬迁块全部一致——即除签名与依赖入参外没有一行语义改动。
2. **既有测试**：`tests/agent/loop/*` 167 → 188（新增 `turnExit.spec.ts` 11 例、`recoveryStrategies.spec.ts` 10 例行为基线），`llm-replay-real.spec.ts`（真实录制 replay 驱动完整回路）不变通过。

事件面按 `pnpm gen:event-matrix` 重生成：18 行变更，全部是行号位移 + 三个事件的生产者换文件（`assistant_message`/`turn_completed`/`turn_failed` → `turnExit.ts`，`empty_output_recovery` → `recoveryStrategies.ts`，`turn_continued` 与 `token_cap_adjusted` 变为两文件共同生产）。

## Alternatives considered

- **整体抽成一个 `TurnExitController` 类（沿用 TokenCapManager/SubagentExecutor 的写法）** — 落选：两组代码的依赖面不同（turn 出口只要 `contextRuntime`/`now`，恢复策略还要 `tokenCaps`），合成一个 300 行类只是把认知负载换了个容器；拆成两模块后 `recoveryStrategies` 单向依赖 `turnExit`，且 `continueWithTransientPrompt` 保持零依赖纯函数。
- **留在 AgentLoop 内按「恢复策略方法」继续私有化**（台账 TD-AGENT-101 原建议） — 落选：这一步早已完成（方法已存在且共享），但共享关系只由注释维系；再拆 `handleModelError` 本体（365 行）时仍要回到 2400 行文件里定位策略。
- **把 `emitStatus`/`createAbortStatus` 留在 AgentLoop、其余外迁** — 落选：`emitStatus` 被 `abortTurn`、`recoverFromEmptyResponse` 与三个阶段方法共同调用，留下会让两个新模块反过来依赖 AgentLoop（循环导入或回调注入），收益为负。
- **同时抽 `createModelRequest`（146 行）+ `createBudgetEvaluator`（46 行）到 `modelRequest.ts`** — 落选：请求装配与压缩执行器（`runAutoCompact`/`persistCompactSnapshot`）在调用序上耦合更紧（预算评估器回调要回读请求），单 PR 一起动会让 diff 与验证面翻倍；留作下一刀。

## Consequences

- AgentLoop.ts 2433 → 2130 行（迁出 306 行方法与注释，净减 303 行，差额为依赖袋字段、结果构造包装与 import）；TD-SIZE-001 中该文件按体积仍属大文件，但阶段方法不再与出口仪式混居。
- `handleModelError` 本体仍 365 行（TD-AGENT-101 未结清），其调用的共享策略现在有了结构位置——后续拆本体时可直接对着 `recoveryStrategies.ts` 的四个入口。
- `TurnStepContinue`/`TurnStepReturn` 与 `TurnResultOptions` 随迁到 `turnExit.ts` 并由 AgentLoop 导入：阶段方法的返回契约现在只有一个定义处。
- 新增 21 条行为基线测试（上游拆解轮次的惯例：每个外迁模块配直测）。
- 无工具契约改动，llm-replay fixture 请求键不受影响（未重录）。
