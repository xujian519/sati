# Agent Note: AgentLoop 响应装配与异常处置外迁（responseAssembly）

Status: implemented

## Problem

TD-AGENT-103 记的是 `AgentLoop.assembleAndRecover`（201 行）：**一次模型响应的装配与错误恢复判定混在一处**——前半段是直行的装配（合并 usage、文本回退工具名修复、设 finalMessage、过期 transient 提示、doomLoop 记录），后半段是三条互斥的异常响应状态机（半截文本工具调用 / 修补后截断 / 空响应）各自带恢复提示、状态事件与终止仪式，最深嵌套 4 层。

后果：读"响应为什么没落库"要在 200 行里逐层排除；三条状态机无法单独驱动测试，只能靠假 router 走完整回路触发；该文件仍列在 TD-SIZE-001 与 issue #147（前三刀已外迁 turn 出口、共享恢复策略、模型错误恢复链，本方法成了 AgentLoop 里最后一块 200+ 行的阶段方法）。

## Decision

整个 `assembleAndRecover` 迁到 `src/agent/loop/responseAssembly.ts`，内部按"装配 + 有序处置"分层：

| 文件 | 行数 | 内容 |
|---|---|---|
| `src/agent/loop/responseAssembly.ts`（新） | 394 | `assembleAndRecover`（装配 + 调度 + 正常落库）、三条处置步骤函数（`handlePartialTextToolCall` / `handleRepairedTruncation` / `handleEmptyResponse`）、`repairTextExtractedToolNames`（随迁）、`ResponseAssemblyDeps`、`AssembledResponse`、`SyntheticPromptContinuer` |
| `src/agent/loop/AgentLoop.ts` | 1733 → **1492** | 删除 `assembleAndRecover`（201 行）与 `repairTextExtractedToolNames`（28 行）及 `AssembleAndRecoverResult` 别名；`run()` 直接调模块入口 |

调度顺序（**顺序即语义**，模块头注释已写明）：

```
装配（usage/工具名修复/finalMessage/transient 过期/doomLoop 记录）
  → 错误响应提前 proceed（交恢复链）
  → handlePartialTextToolCall → handleRepairedTruncation → handleEmptyResponse
  → 正常落库（push + assistant_message + onDurableMessage）→ proceed
```

装配产物收在 `AssembledResponse { assembled, assistantMessage, toolCalls }` 里传给各步骤，既替代了原方法的多个局部变量，也让"proceed"这一结论与它的载荷同型（`{ kind: "proceed" } & AssembledResponse`）。

**阶段结论词汇统一**：`StageOutcome`（`TurnStep*` 或 `{kind:"unhandled"}`）与 `unhandled()` 上移到 `turnExit.ts`，`modelErrorRecovery.ts` 的 `RecoveryOutcome`/局部 `unhandled` 改为复用——两条链（恢复链、装配链）现在共用同一套"接管/不接管"词汇，不再各写一份同形类型。

**行为不变的三道验证**：

1. **逐行对拍**：脚本对原 `assembleAndRecover` + `repairTextExtractedToolNames` 与新模块做归一化后逐行比对（`this.createTurnResult` ↔ `createTurnResult`、`this.turnExit` ↔ `deps`、`assistantMessage`/`toolCalls` ↔ `response.*` 等），差异全部是"守卫取反提前返回 / 局部变量收进 `AssembledResponse` / 签名拆分"三类重构性改写，无语句丢失或改写。
2. **既有回路测试**：`tests/agent/**` 414 用例全绿（含端到端驱动本方法全部三条状态机的假 router 用例：`stream-interruption-recovery` / `output-cap-rejection` / `context-cap` / `claim-guard`）。
3. **全量**：`pnpm test` 4294 tests / 4290 pass / 0 fail / 4 skipped（改动前 4272 / 4268，差额为新增 22 条直测）。

事件面按 `pnpm gen:event-matrix` 重生成：`assistant_message` 生产者由 `AgentLoop.ts` 换为 `responseAssembly.ts`，其余为行号位移。

## Alternatives considered

- **只拆三条处置状态机、装配留在 AgentLoop** — 落选：装配段本身是 25 行直行代码，留在原处只能把方法从 201 行削到 ~120 行，"装配与恢复判定混居"的债（TD-AGENT-103）仍在；外迁后 AgentLoop 只剩阶段编排。
- **只整体外迁、内部不分步骤**（把 201 行原样搬进新文件） — 落选：形式上负债清掉了，认知上没变——三条状态机仍靠阅读顺序区分；分层后每条可单独驱动测试（22 条直测里 15 条是单步骤）。
- **把 `continueWithSyntheticPrompt`（含 LargeFileRepair 续跑）一并迁入** — 落选：它被 `handleNoToolCalls`、`executeToolCalls`（两处）与本模块共用，且要写回 `config.maxOutputTokens`（AgentLoop 的 config 所有权）；以窄接口 `SyntheticPromptContinuer` 注入，四处调用点各自保留实现。
- **给 `StageOutcome` 另起名（如 `AssemblyOutcome`）留在本模块** — 落选：与恢复链的 `RecoveryOutcome` 完全同形，两份同形类型会让"下一步骤该返回什么"出现两个说法；上移到 `turnExit.ts` 与 `TurnStepContinue`/`TurnStepReturn` 同处，两条链共用。
- **让装配产物继续用三个局部变量传参** — 落选：三个步骤函数各要 4–6 个参数（`assembled`/`assistantMessage`/`toolCalls` 里的 2–3 个 + 路由决策等），收进 `AssembledResponse` 后签名稳定且与 `proceed` 结论同型。

## Consequences

- `AgentLoop.ts` 1733 → 1492 行；TD-AGENT-103 结清——AgentLoop 里已无 200+ 行的阶段方法（最大 `prepareModelCall` 116 行）。
- 三条异常响应状态机获得独立测试面：新增 22 条行为基线（`tests/agent/loop/responseAssembly.spec.ts`），含"修补截断的脏消息绝不落库""空响应走恢复链而非落库空消息""文本回退工具名在装配期修复"等此前只能靠整条回路间接覆盖的断言。
- `repairTextExtractedToolNames` 由私有方法变为导出纯函数（依赖经 deps 传入），文本回退工具名修复首次可直测。
- 无工具契约改动，llm-replay fixture 请求键不受影响（未重录）。
