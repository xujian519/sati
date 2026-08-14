# AgentLoop 拆解专项实施文档

- 创建日期：2026-08-14
- 状态：**轮次 1–4 完成**——`AgentLoop.ts` run() 骨架化（~80 行），阶段二依赖的主循环拆解已落地
- 前置：阶段一/阶段二（`docs/deepseek-harness-phase1-plan.md` / `phase2-plan.md`）

---

## 1. 拆解目标

`src/agent/loop/AgentLoop.ts`（3550 行）是系统主循环，无直接测试，承担全部控制流。拆解原则：

- **行为不变**：每步抽取后 typecheck + lint + 相关测试 + 全量测试验证；
- **先纯函数后状态**：无状态的模块级函数最先抽取（可独立测试），有状态/闭包的主循环最后；
- **为后续阶段二剩余工作铺路**：投影化、注入落库、事件化扩展点需要主循环可维护。

---

## 2. 结构测绘（拆解前）

| 区段 | 行数 | 内容 |
|---|---|---|
| `run()` 主循环 | 178–1837（~1660） | while 循环：中止检查 / pre-routing 压缩 / 模型请求 / 路由 / post-routing 压缩 / 流式执行 / 8+ 种错误恢复 / 工具泵 / 循环判定 |
| 私有方法 | 1838–2583（~745） | token caps 管理（6 方法）、createModelRequest、createToolContext、buildSubagentForkApi、executeToolsWithEventPump、子代理心跳、createTurnResult 等 |
| 模块级纯函数 | 2583–3550（~966） | 消息变换、工具失败分析、模型错误分类、状态构建、杂项 |

---

## 3. 本轮实施：模块级纯函数抽取（966 行 → 4 个新模块）

### 3.1 新模块

| 模块 | 行数 | 内容 |
|---|---|---|
| `src/agent/loop/misc.ts` | ~230 | buildTurnEnvironment、mergeUserRules、filterAskModeTools、findLifecycleBlock、findToolLifecycleBlock、isRecord、cloneReadFileStateMap/WriteSnapshotMap、subagentIdFromSessionId、readRequestedMode、isPermissionMode、mergeUsage、bindSupplementalMessagesToToolCalls、composeAbortSignal |
| `src/agent/loop/messages.ts` | ~200 | PLAN_MODE_REMINDER_MESSAGE、normalizeMessagesForModelRequest、stripTrailingErrorPair、stripImagesFromMessages、truncateHeadKeepRatio、markCompactReplacementMessages、addEmptyReasoningContentMarkers、appendPlanModeReminder、removeTransientPromptsById、appendTextToFirstContent、hasToolCallBlock、buildPartialTextToolCallRecoveryPrompt |
| `src/agent/loop/toolFailure.ts` | ~120 | detectRepeatedToolFailure、buildToolFailureKeys、buildInvalidFingerprint、annotateRepeatedToolFailures、collectPermissionDenials |
| `src/agent/loop/modelErrors.ts` | ~420 | AgentStatusMessage 类型、classifyModelError、isPromptTooLong、modelErrorTarget、clampOutputToModelCap、tokensFromUsage、createModelRequestFailedStatus、formatModelRequestFailureMessage、modelFailureAction、create*Status 全系（11 个）、createAgentTurn{Error,Status}Detail、shouldSurfaceAbortStatus、stringifyAbortReason |

### 3.2 处理要点

- `type AgentStatusMessage`（AgentLoop 内部类型）随状态构建器迁移到 modelErrors.ts 并导出，AgentLoop 从新模块导入；
- `PLAN_MODE_REMINDER_MESSAGE` 常量随 appendPlanModeReminder 迁移；
- AgentLoop 顶部多余 import（isAskModeAllowedTool 等 28 处未使用）由 `eslint --fix` 自动清理；
- 两个既有测试的 import 路径更新：`tests/agent/turn-environment.spec.ts`（buildTurnEnvironment → misc.js）、`tests/model/model-error-guidance.spec.ts`（formatModelRequestFailureMessage/modelFailureAction → modelErrors.js）。

### 3.3 行为基线测试（新增 23 用例）

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `tests/agent/loop/messages.spec.ts` | 11 | 消息规范化（合并/跳过/不合并）、残缺对剥离（含原语义验证）、图片剥离、截断、compactReplacement 标记、reasoning 补块、plan 提醒、transient 移除 |
| `tests/agent/loop/toolFailure.spec.ts` | 4 | 重复失败指纹、invalid 指纹排序、重复标注、权限拒绝收集 |
| `tests/agent/loop/misc.spec.ts` | 8 | usage 合并、子代理 id 提取、权限模式判定、user 规则替换、AbortSignal 组合（超时/父信号/空） |

> 基线测试过程中发现并**锁定**了两处原语义（非 bug，迁移后行为与迁移前逐字节一致）：
> - `stripTrailingErrorPair` 会移除末尾整个「tool_result + 前置 assistant」对（含无 tool_result 时仅移除末尾 assistant）；
> - `mergeUserRules` 用传入的 userRules **整体替换** target 中的 user 规则（非追加）。

---

## 4. 验证结果（轮次 1）

- `AgentLoop.ts`：3550 → **2585 行**（-27%）
- `pnpm typecheck`（Node 22）✅ 0 错误
- `pnpm lint` ✅ 0 error / 0 warning
- 新增 23 行为基线测试全绿；agent/model 相关既有测试全绿
- 全量后端测试（Node 22）：2533 pass（+23）/ 3 skipped / 1 fail（proxy 环境测试，与本轮无关）

---

## 5. 迁移中的风险控制

1. **函数可追溯性**：迁移采用「复制 + 删除 + import」，未改动任何函数体（除必要类型 import）；git diff 可逐函数核对。
2. **模块内依赖**：isRecord 等共享工具放 misc.ts，toolFailure.ts 从 misc import；AgentLoop 只 import run() 实际使用的函数（未使用 import 由 eslint 清理 + typecheck 兜底验证未误删）。
3. **测试夹具修正**：新测试初版有 3 处对原语义的误判（stripTrailingErrorPair、mergeUserRules），修正为与原行为一致后全绿——这正是行为基线测试的价值（锁定而非改写语义）。

---

## 6. 轮次 2：TokenCapManager 抽取（已完成）

### 6.1 改动

| 文件 | 内容 |
|---|---|
| `src/agent/loop/tokenCapManager.ts`（新） | `TokenCapManager` 类：封装 `transientTokenCaps` 状态 + 9 个方法（tokenCapKey、getModelTokenLimits、currentMaxContextTokens、currentMaxOutputTokens、getReservedOutputTokens、setTransientTokenCap、clearAttemptOutputTokenCap、clearTurnScopedTokenCaps、applyTokenCapsToRequest）；依赖收窄为 `TokenCapConfig` + `TokenCapDependencies` |
| `AgentLoop.ts` | 删除 `transientTokenCaps` 字段与 9 个私有方法（~190 行）；构造中实例化 `this.tokenCaps`；38 处调用点批量替换为 `this.tokenCaps.*` |
| `tests/agent/loop/tokenCapManager.spec.ts`（新） | 7 用例：context 优先级链、output 最小值、cap 合并、attempt 清除、turn/session 级清理、reserved 默认、request 注入 |

### 6.2 验证

- `AgentLoop.ts`：2585 → **2493 行**（-30% 累计），私有方法 23 个
- typecheck / lint ✅；新增 30 行为基线测试全绿（轮次 1: 23 + 轮次 2: 7）
- 注意：sed 行号删除出现两处残留大括号（边界误判），已用精确 search_replace 修复——后续轮次优先 search_replace

---

## 7. 轮次 3：ToolContextFactory / SubagentExecutor 抽取（已完成）

### 7.1 改动

| 文件 | 内容 |
|---|---|
| `src/agent/loop/toolContext.ts`（新，251 行） | `ToolContextFactory` 类：`createToolContext`（组装 SatiToolRuntimeContext）+ `buildSubagentForkApi`（agent 工具的子代理 fork 回调面）；依赖经 `ToolContextFactoryHost` 注入（config/dependencies/readFileState/writeSnapshots/allowedReadFiles/now/dispatchLifecycle） |
| `src/agent/loop/subagentExecutor.ts`（新，180 行） | `SubagentExecutor` 类：`executeToolsWithEventPump`（工具并发执行 + 500ms 事件泵）+ 子代理状态跟踪（pre/post_tool_execute → subagent_status）+ 2s 心跳 + `drainEventBuffer`；`TOOL_EVENT_PUMP_INTERVAL_MS`/`SUBAGENT_STATUS_HEARTBEAT_MS`/`ActiveSubagentStatus` 随迁 |
| `src/agent/loop/misc.ts` | 新增 `createLifecycleDispatcher` + `LifecycleDispatcher` 类型：把原 `dispatchLifecycle` 私有方法抽为纯依赖函数（AgentLoop 与 ToolContextFactory 共享同一实现） |
| `src/agent/protocol/input.ts` | `AgentLoopInput` 类型从 AgentLoop.ts 迁入（避免新模块与 AgentLoop 的循环依赖）；AgentLoop.ts re-export 保持对外签名不变 |
| `AgentLoop.ts` | 删除 7 个私有方法（createToolContext、buildSubagentForkApi、dispatchLifecycle、executeToolsWithEventPump、drainToolEventBufferForSubagentStatus、updateSubagentStatusFromEvent、emitSubagentHeartbeats）+ `ActiveSubagentStatus` 类型 + 2 常量；构造中实例化 3 个字段；调用点改为 `this.toolContextFactory.*` / `this.subagentExecutor.*` |
| `tests/agent/loop/toolContext.spec.ts`（新） | 12 用例：基础组装、runMode/canPrompt、model.stream 适配器、planDirectory/planTodo 注入、allowedReadFiles 快照、subagent fork API、未知类型抛错、createLifecycleDispatcher 空/转发 |
| `tests/agent/loop/subagentExecutor.spec.ts`（新） | 5 用例：快路径结果+事件转发、错误传播、挂起期间状态事件、心跳、drainEventBuffer |

### 7.2 处理要点

- `createToolContext(input, messages)` 的 `messages` 参数与 `buildSubagentForkApi(input, _messages)` 的 `_messages` 均为未使用参数，抽取时一并去除；
- 字段初始化顺序：`dispatchLifecycle`/`toolContextFactory`/`subagentExecutor` 在构造函数体中初始化（与 `tokenCaps` 一致），避免字段初始化器阶段引用未就绪的 `readFileState` 等构造期字段；
- 用 Python 锚点脚本删除方法块（锚定 `private createToolContext` → `private createTurnResult`），避免 sed 行号偏移残留大括号。

### 7.3 验证

- `AgentLoop.ts`：2493 → **2089 行**（-41% 累计），私有方法 9 个 + run()
- typecheck / eslint / biome 全绿；新增 17 行为基线测试全绿（累计 41）
- 全量测试（Node 22）：**2556 pass** / 3 skipped / 1 fail（proxy 环境测试，与本轮无关）
- 注意：测试 mock 的 `drainEvents` 必须为消费式缓冲（真实实现每次调用后清空），否则快路径末尾的收尾 drain 会重复转发同一事件

---

## 8. 轮次 4：run() while 循环阶段化（已完成）

### 8.1 目标与设计

把 run() 主循环（1671 行）的 30+ 闭包变量收拢为显式 `TurnRuntimeState`，while 体按阶段切为 9 个 async generator 私有方法，run() 骨架化为阶段编排。

### 8.2 改动

| 文件 | 内容 |
|---|---|
| `src/agent/loop/turnRuntimeState.ts`（新） | `TurnRuntimeState`：收拢跨迭代可变状态（messages/turnCount/usage/lastModelUsage/permissionDenials/structuredOutput/finalMessage/startedAt/doomLoopFatalReason/5 个单发守卫/3 个恢复计数/电路断路器 4 变量/transient prompts/sticky 路由/largeFileRepair）；`pushTransientSyntheticPrompt`/`expireConsumedTransientPrompts` 方法化；`MAX_OUTPUT_RECOVERY_LIMIT` 等 4 常量随迁 |
| `AgentLoop.ts` | `run()` 1671 行 → **~80 行**（setup + while 骨架）；删除实例字段 `doomLoopFatalReason`（移入 state，顺带消除并发 run 的实例级状态共享风险）；5 个闭包函数方法化（emitStatus/createAbortStatus/captureTurn/missingToolResultRecoveryContext/continueWithSyntheticPrompt）；while 体切为 9 个阶段方法（每段逐字搬迁 + `continue`→哨兵返回 + 段尾 `proceed`/`continue` 返回） |
| `tests/agent/loop/turnRuntimeState.spec.ts`（新） | 6 用例：构造复制/初始化、sticky 路由、transient prompt（uuid 优先/回退计数）、expire、常量锁定、doomLoopFatalReason 读写 |

### 8.3 阶段方法清单

| 方法 | 段范围（原行号） | 职责 |
|---|---|---|
| `runTurnGuards` | 183–218 | 循环开头 abort / doomLoop 检查 |
| `prepareModelCall` | 219–367 | pre-routing 压缩 → createModelRequest → 路由 → post-routing 压缩 → token caps → context_budget |
| `streamModelResponse` | 368–475 | 模型流式执行 + 异常处理（abort partial / stop failure） |
| `assembleAndRecover` | 476–792 | 组装、partial text tool-call 恢复、repaired-truncation 恢复（LargeFileRepair/Phase A/B/C）、空响应恢复、push + durable |
| `handleModelError` | 793–1089 | assembled.error 分支（reasoning markers / JSON 自纠错 / reactive recover / max_output_reached / 分类错误面） |
| `handleNoToolCalls` | 1090–1347 | 无工具调用路径（空文本恢复 / length 续写 / unparsed / Stop hooks / 成功结束） |
| `executeToolCalls` | 1348–1530 | 工具执行泵 + pairing + doomLoop + 权限/模式变更 + applyToolResults + durable + toolResultRepair + lifecycleBlock |
| `handleCircuitBreaker` | 1531–1621 | invalid_tool_input 指纹熔断（grace prompt / 终止 / 计数器重置） |
| `finishTurn` | 1622–1668 | stopOnStructuredOutput / maxTurns / turnCount++ / next_turn |

### 8.4 阶段间数据流

- `prepareModelCall` → `{ request, decision, routedMaxOutputTokens }`（continue 分支携带）
- `streamModelResponse` → `assembler`（组装状态）
- `assembleAndRecover` → `proceed { assembled, assistantMessage, toolCalls }`（进入 error/无工具判断）或 `continue`（恢复后下一轮）
- `executeToolCalls` → `proceed { pairedResults }` 或 `continue`（toolResultRepair 后下一轮）
- 终止路径统一 `return { result, messages }`（消息快照在 return 点捕获，与原始语义一致）

### 8.5 验证结果

- `run()`：1671 行 → **~80 行**（骨架 56 行 + setup）；`AgentLoop.ts`：2089 → 2203 行（9 个方法签名/哨兵/类型别名 ≈ 内容 + 结构开销，行数非本轮目标——目标是 run() 可读性与阶段可独立演进）
- `pnpm typecheck` ✅ 0 错误；`pnpm lint` ✅ 0 error / 0 warning；`biome check` ✅
- 新增 6 行为基线测试全绿（累计 47）；agent/loop 96 测试全绿
- 全量测试（Node 22）：**2570 pass**（+6）/ 3 skipped / 1 fail（proxy 环境测试，与本轮无关）

### 8.6 风险控制记录

1. **切块脚本行号漂移**：首版按硬编码行号切块，备份恢复后行号失效导致文件混杂；改为**内容锚点定位**（唯一行匹配 + while 后第一个 abort 检查），脚本可重复执行；
2. **负向后视断言误伤**：变量替换的 `(?<![\w.])` 排除点前缀，数组展开 `[...permissionDenials` 中的点被误排除——tsc 兜底发现后补修；
3. **对象简写失效**：`state.usage,` 是非法简写，脚本批量修复为 `usage: state.usage,`（92 处）；
4. **continue 语义区分**：段 4/7 内既有"恢复后下一轮"的裸 continue（哨兵 `continue`），又有"fall-through 进入后续判断"（哨兵 `proceed`）——类型上分离，避免骨架误判；
5. **段 5 的 ctx**：原 while 开头定义的 `ctx` 被切段后丢失，方法内补 `const ctx = this.dependencies.context;`（依赖不变，语义等价）；
6. **段 5/6 保留外层 if 包裹**：骨架已判 error/toolCalls，方法内保留原 `if` 冗余判断（内层恒真），避免括号重配对——最小行为风险。

---

## 9. 后续轮次（未实施）

轮次 4 完成后 `run()` 骨架化（~80 行），阶段二剩余工作（投影化、注入落库、事件化扩展点、单一压缩执行器）依赖的主循环拆解已完成，可安全落地。`al-extract-state`（压缩触发/工具泵/上下文状态抽取）可作为可选深化轮次。
