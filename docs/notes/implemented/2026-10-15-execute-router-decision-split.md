# Agent Note: executeRouterDecision 决策树外置（#646 sweep P2.6）

Status: implemented

## Problem

`src/router/execution/executeRouterDecision.ts` 的 `executeRouterDecision` 是 **449 行**的异步生成器
（`src/` 最大函数，backlog `TD-ROUTER-009` 的原文即「429 行（原 411 行，抽走单 attempt 执行器与
重试谓词后反而增大），两套重试分支副作用编排未拆」）。它把四类互不相干的东西叠在同一个函数体里：

1. **纯规划**：候选分档（native → 媒体降级两档）、三套重试预算归一（`zeroUsageRetry` /
   `transientRetry` 的 enabled / maxAttempts / 退避上下限，含 `Math.max(1, …)` 下限）；
2. **纯判定**：attempt 结局 → 下一步动作的 if 阶梯（回退 / 传输重试 / 零用量重试 / 终态 / 成功），
   其中退避延迟的计算与使用相隔约 40 行；
3. **副作用上报**：三套重试/回退各自 35–60 行的 emit + telemetry + `satiLogger.warn` + `abortableDelay`；
4. **落账**：成功与失败两条路径各 ~30 行的用量补齐 + `usageCache.observe` + `stats.observe`。

后果是「读一遍才能改一处」：改重试判定要穿过 emit 块，改上报要穿过统计块；而判定与副作用交缠
也使「什么情况下该重试」只能靠端到端用例间接观察。

通过判据：计划条目原文「决策树外置，行为逐 token」。

## Decision

**按「判定 / 上报 / 编排」三段分层，全部 `yield` 留在编排体内**：

- 新增 `src/router/execution/attemptPlanning.ts`（**纯**，262 行）：`applyDecisionToRequest` +
  `clampMaxOutputTokensToModelCap`（自本文件搬入，后者新导出给直通分支用）、`planAttemptExecution`
  （候选分档 + 重试预算）、`planAttempt`（attempt 决策与请求）、`subagentBudgetError`、
  `classifyAttemptGate`（返回 `fallback | transientRetry{delayMs} | zeroUsageRetry{delayMs} |
  terminalFailure | success`）。
- 新增 `src/router/execution/attemptReporting.ts`（248 行）：`reportFallbackTransition` /
  `reportTransientRetry` / `reportZeroUsageRetry` / `finalizeAttemptSuccess` / `finalizeAttemptFailure`。
- `executeRouterDecision` 收缩为编排骨架：**449 → 273 行**，`while(true)` 内的 if 阶梯变成
  `switch (gate.kind)` 逐 kind 分派到具名动作。

关键决策点：

1. **所有 `yield` 不外移**。编排体保留直通分支、不支持媒体守卫、子代理预算守卫、终态失败上报四处
   `yield`；`streamAttemptBuffered`（新增的二级生成器）也在本文件。这是为了让事件矩阵的生产者面
   只发生**行号位移**，不跨文件（见 Verification）。
2. **`classifyAttemptGate` 返回带 `delayMs` 的判定，而不是只返回「要不要重试」**。原实现里延迟算完
   后在 emit 与 warn 里被 `Math.round` 三次、在 `abortableDelay` 里用第四次；判定与延迟同源后，
   「上报的延迟」与「实际等待的延迟」不可能再分叉。
3. **`events.emit({ … })` 的对象字面量随上报块一起搬进 `attemptReporting.ts` 并留在调用点**。
   `gen-event-matrix` 的生产者启发式只认「首参是对象字面量」（`scripts/gen-event-matrix.ts:180`），
   若改成「先构造变量再传参」，本文件的 5 个 router 事件会整体从矩阵的生产者面消失。
4. **`subagentBudgetError` 接收 `protocol` 而非 `modelRuntime`**：协议解析仍留在编排体（它同时被
   `streamAttempt` 用），判定函数因此零依赖、可直测。
5. **`applyDecisionToRequest` 迁到 `attemptPlanning.ts`，`RouterRuntime.ts` 的导入改指新模块**。
   若留在原文件，`attemptPlanning → executeRouterDecision` 会形成模块环（`planAttempt*` 要用它）。
   签名由 `Pick<RouterExecutionDeps,"modelRuntime">` 收窄为 `ModelRuntime`（唯一调用方改一行）。
6. **不支持媒体守卫（`attemptPlans.length === 0`）保持原样，未删**。语料 23 例无一命中该分支：
   `candidateAttempts` 至少含决策本身，且 `requiredModalities.length > 0` 时它必落在 native 或
   downgraded 之一 ⇒ **该分支在当前实现下不可达**（本次发现，属既有形态）。删它是行为变更
   （计划 §1.2 非目标），故保留并在此登记，交 `TD-ROUTER-009` 之外另议。

## Alternatives considered

- **只抽 `classifyAttemptGate`（判据字面最小解）**：449 → ~380 行仍踩着 M1 红线，三套重试的
  emit 块与落账块原样留在体内，「读一遍才能改一处」的核心问题不动。否决。
- **把上报块抽成「返回待 emit 事件数组」的纯函数**：能让上报也变纯，但事件构造一旦离开
  `events.emit({…})` 调用点就整批从事件矩阵消失（决策点 3），且 `abortableDelay` 这类 IO 无法
  用返回值表达。否决。
- **把三套重试写成 `yield*` 子生成器**：本文件已是生成器，`yield*` 语义等价可行；但这三处
  **没有** `yield`，用普通（async）函数即可，子生成器只会为「语义等价」付额外一层间接。
  终态失败上报有 `yield`，但它是编排收尾而非「动作」，留在体内更易读。否决。
- **拆成独立模块 + 三个文件（planning / reporting / streaming）**：`streamAttemptBuffered` 依赖
  `streamAttemptWithReport`（派发点报告），把它拆走会让「报告与流同一条语句」这条不变量跨文件，
  收益只是文件更小。否决。
- **顺手删掉不可达的不支持媒体分支**：属行为变更（计划 §1.2 明确不做），且它承载一条
  `sati_router_execute_failed` 语义；改为「保留 + 登记」。否决（登记而非删除）。
- **保留 `applyDecisionToRequest` 在原文件、由 planning 反向 import**：模块环，Node ESM 下虽能
  跑通但初始化顺序敏感（`applyDecisionToRequest` 在模块顶层被引用）。否决。

## Verification

- **行为指纹 A/B 逐字节对拍**：/tmp 语料 `tests/router/__p26-corpus.ts`（未入库，方法记录于此）覆盖
  **23 例**——直通（成功 / 流抛错 / 上限夹取）、首 attempt 成功、fallback 成功、链尾全灭（含缓冲回放）、
  内容锁定、transient retry（retry-after 与抖动两条路径）、zero-usage retry、两者分别用尽、子代理预算、
  不支持媒体、媒体降级、取消、熔断跳过、`requestPatch` 三分支、`subagentTagStripped`、
  `onRetryProgress` 流内进度；每例捕获**派发请求 + dispatch 报告（7 种改写标签全覆盖）+
  yield 事件序列 + router 事件 + telemetry 打点 + stats + usageCache.observe + `satiLogger.warn` 文本**，
  冻结 `Math.random` 序列使退避抖动可复现。基线 commit 与拆分后：**23/23 JSON 逐字节 diff = 0，stderr diff = 0**。
- **负控制 4 处**（每处都让**预期**用例转红 + 语料 diff）：
  1. 内容锁定失效（fallback 不再要求 `!hasYieldedContent`）⇒ 直测 1 条 + 端到端 1 条红（「已产出内容后
     不再 fallback」）+ 语料 diff；
  2. 帧暂存失效（首个内容事件前改为直接 yield）⇒ **5 条**端到端用例红（回退/重试/回放/熔断四条链）
     + 语料 diff；
  3. 重试进度 `maxAttempts` 篡改（+1）⇒ 端到端 1 条红 + 语料 diff；
  4. 零用量退避基数篡改（500 → 100）⇒ 直测 1 条红 + 语料 diff。
- **新增直测**：`tests/router/execution/attempt-planning.spec.ts`（17 例）覆盖新纯函数真值表——
  候选分档顺序与去重、预算缺省/覆盖/下限、`resolvedFrom` 语义、降级档图片块替换、上限夹取与
  未知模型不夹取、`classifyAttemptGate` 九条分支、`subagentBudgetError` 四态。
- **事件矩阵**：`pnpm gen:event-matrix` 后 `--check` 绿；diff **仅 1 行**（`error` 生产者的
  `executeRouterDecision.ts` 四处 :278/:340/:374/:687 → :293/:331/:367/:526），**生产者/消费者计数与文件归属逐条不变**。
- **门禁**：`pnpm check`、`pnpm test`、`pnpm test:pr-tooling`、`pnpm --filter sati-ui test` 结论见 PR 正文
  （含 `renderPatentDocument.spec` 的既有环境型超时披露）。
- **指标**：`pnpm measure:update` → God function 榜移除 `executeRouterDecision | 449`——本仓实测
  **≥300 行 55 → 54、≥400 行 28 → 27**（300–399 档 27 不变，本次未新增该档函数）；`src` 文件
  1088 → 1090、行数 189150 → 189504；三个文件（528 / 262 / 248）均远低于 800 行棘轮，
  `check-architecture-boundaries` fresh、无新增豁免；`docs/code-facts.md` 的 `src/router/` 文件数 33 → 35。

## Impact

- 计划条目：P2.6（P2 批次红线三项 P2.1 / P2.2 / P2.6 至此全部交付）。
- 债务：关闭 backlog `TD-ROUTER-009`（其「建议 ①②③」即本次三段分层的实现）。
- 后续：P2 批次余 P2.7（`sati.ts main` + `projectRuntimeFactory`）、P2.8（`TuiApp`）、
  P2.9（`webMessage` + `ToolRuntime`）、P2.10（`inventiveness`）。
- 遗留登记：不支持媒体守卫分支在当前实现下不可达（见决策点 6），未删、待另议。
