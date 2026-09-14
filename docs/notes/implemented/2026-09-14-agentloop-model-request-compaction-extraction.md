# Agent Note: AgentLoop 请求装配与压缩执行器外迁（modelRequest / compactionExecutor）

Status: implemented

## Problem

AgentLoop 的 `prepareModelCall` 依赖两个"子系统级"执行器，此前都长在类里：

- **请求装配**（`createModelRequest` 147 行 + `createBudgetEvaluator` 57 行 + `readWorkspaceLedgerBlock` 15 行）：把消息、工具面、系统提示、注入审计与缓存布局组装成 `CanonicalModelRequest`，并造出"候选请求 → token 预算快照"的评估器；其中「模型可见 = 已记录」（动态注入段落既进 prompt 又落 `injected_context` 审计，同 turn 去重）与「预算预演不落库不推进缓存代数」两条纪律只写在注释里，无处直测。
- **压缩执行器**（`runAutoCompact` 68 行 + `persistCompactSnapshot` 34 行）：统一 `tryAutoCompact` 的参数组装、结果安顿（替换 messages + 落压缩边界 + 可选事件）与失败降级（日志 + 可选截头兜底），被 pre-routing / post-routing / 模型错误恢复三处共用。

两者与主循环阶段编排不同寿命：装配要看 config 的大部分面，压缩只在 context runtime 上打转；混在 1485 行的文件里既拉高类体积，也让"注入了什么、落库了什么"难以单测。TD-SIZE-001 的 issue #147 已连续四刀外迁类内子系统，这是最后一簇。

## Decision

拆成两个模块，前者按 `ToolContextFactory` 的"子系统收 config + dependencies"写法，后者只需一个依赖：

| 文件 | 行数 | 内容 |
|---|---|---|
| `src/agent/loop/modelRequest.ts`（新） | 287 | `ModelRequestDeps { config, dependencies, dispatchLifecycle }`、`createModelRequest`、`createBudgetEvaluator` + `TokenBudgetEvaluator`、内部 `readWorkspaceLedgerBlock`、`ModelRequestOptions`；`promptCacheGeneration`（进程级缓存代数）随迁 |
| `src/agent/loop/compactionExecutor.ts`（新） | 143 | `runAutoCompact(contextRuntime, state, input, options)`、`persistCompactSnapshot`、`AutoCompactOptions`/`AutoCompactOutcome`/`AutoCompactRunner`、`logAutoCompactFailure` + 两个 logger |
| `src/agent/loop/AgentLoop.ts` | 1485 → **1133** | 删除五个方法与模块级辅助（`autoCompactLogger`/`logAutoCompactFailure`/`promptCacheGeneration`）；`run()` 阶段内改调模块函数 |

要点：

- **依赖面差异化**：装配读 config 的十余个字段 + dependencies 的八处切片，逐字段收窄只会得到一袋易腐的转发字段，故整包收（与 `ToolContextFactory`/`SubagentExecutor` 同构）；压缩只需 `contextRuntime`，就以普通首参传入，不做依赖袋。
- **`AutoCompactRunner` 类型归属变更**：上一刀为恢复链在 `modelErrorRecovery.ts` 里声明过一个窄接口（只含 `model-error-recovery` 一路参数）。压缩执行器独立成模块后，该类型改由 `compactionExecutor.ts` 声明并导出，恢复链导入使用——接口名即"压缩执行器的调用面"，窄化表述留在调用点注释（本链只走一路 stage）。
- **`runAutoCompact` 的 ctx 由调用点注入**：`runAutoCompact(this.dependencies.context, ...)`（三处：pre-routing / post-routing / 恢复链 thunk），与原先在方法内读 `this.dependencies.context` 等价（该字段从不重赋值）。
- **无包装方法**：不保留 `this.createModelRequest` 之类的 3 行转发（上一刀 `createTurnResult` 保留包装是因为 12 处调用点绑定 `now`；这里只有 2–3 处且参数直观）。

**行为不变的三道验证**：

1. **逐行对拍**：脚本对原五段实现与新两模块做归一化后逐行比对（`this.config` ↔ `deps.config`、`this.dependencies` ↔ `deps.dependencies`、`this.runAutoCompact(` ↔ `runAutoCompact(contextRuntime, ` 等），差异全部是"签名拆分 / 内联类型提升为具名导出类型 / biome 对 `.dispatchLifecycle(...).catch(...)` 链的换行"三类，无语句丢失或改写。
2. **既有回路测试**：`tests/agent/**` 432 用例全绿（其中 `context-cap` 与 `claim-guard` 会真实驱动 pre-routing/post-routing 压缩与预算评估器）。
3. **全量**：`pnpm test` 4312 tests / 4308 pass / 0 fail / 4 skipped（改动前 4294 / 4290，差额为新增 18 条直测）。

事件面按 `pnpm gen:event-matrix` 重生成：`instructions_loaded` 生产者由 `AgentLoop.ts` 换为 `modelRequest.ts`，`turn_continued` 变为三文件共同生产（新增 `compactionExecutor.ts`），其余为行号位移。

## Alternatives considered

- **合成一个 `modelPipeline.ts`（装配 + 压缩同模块）** — 落选：两者无相互依赖（预算评估器由调用点交给压缩执行器），依赖面也完全不同（一个要 config，一个只要 context runtime）；合起来只会得到一个 430 行的混合体，而 AgentLoop 侧仍要对两件事分别构造依赖。
- **装配也逐字段收窄依赖袋**（只收用到的 config 字段） — 落选：`createModelRequest` 触及 config 的 provider/model/cwd/permissionMode/permissionContext/runMode/systemPrompt/maxContextMessages/maxOutputTokens/temperature/thinking/metadata/toolChoice/methodologyInjection/metacognitiveControl(+Prompt)/workspaceLedger，以及 dependencies 的 context/tools/planTodoManager/eventEmitter/getProviderProtocol/workspaceLedger；逐字段收窄是纯转写噪声，且每次 config 增项都要改两处，比整包收更容易腐坏。
- **保留 `this.createModelRequest` 薄包装以零改动调用点** — 落选：只有 2 处调用点，直接传 deps 更少概念；`runAutoCompact` 同理（3 处，且其中一处是恢复链的 thunk，本来就要重写）。
- **把 `readWorkspaceLedgerBlock` 留在 AgentLoop** — 落选：唯一调用点是 `createModelRequest`，留下会让装配模块反向依赖 AgentLoop（回调注入），收益为负。
- **顺手把 `prepareModelCall`（116 行）也拆了** — 落选：它是主循环阶段编排（压缩 → 装配 → 路由 → 再压缩 → token caps → 事件），拆它属"改流程"而非"搬家"，与本刀"外迁子系统"的目标不同；留待按需再判。

## Consequences

- `AgentLoop.ts` 1485 → 1133 行；TD-SIZE-001 中它已从 2433 行降到 1133 行（八刀累计 −53%），剩余部分主要是阶段编排与工具执行泵。
- 「模型可见 = 已记录」与「预算预演不落库」首次可直测：新增 18 条行为基线（`tests/agent/loop/modelRequest.spec.ts` 8 条、`tests/agent/loop/compactionExecutor.spec.ts` 10 条），覆盖注入去重、plan 模式提醒、评估器短路/取大/物化补丁、压缩替换与 transient 回贴、失败降级截头、压缩边界快照的 shadowedRanges 编码。
- `AutoCompactOptions` / `AutoCompactRunner` 现在有唯一归属（`compactionExecutor.ts`），恢复链与阶段方法共用同一份声明，不再各自复述。
- 无工具契约改动，llm-replay fixture 请求键不受影响（未重录）。
