# Agent Note: 工具运行时输入复核与有界并发调度

Status: implemented

## Problem

工具执行的输入在生产链路上会被改写两次：`PreToolUse` hook 与权限 `PermissionRequest` hook 都可以返回 `updatedInput`。Sati 之前只在两处做了部分校验：

- `PreToolUse` 改写后只重跑 `validateToolInput`（schema）；plan/ask 模式与提示能力不再检查。
- 权限改写后的输入完全不复核，直接交给 `tool.execute`；工具级 `validateInput` 与 `todo` 门也停留在改写前的输入上。

结果是「校验过的输入」与「真正执行的输入」脱钩：hook 可以把一个 plan 模式下合法的只读调用改成写调用，或把 `canPrompt: false` 的会话推向需要交互的工具。

并发侧，`ConcurrentToolScheduler` 用无上限 `Promise.all` 执行所有并发安全调用。单轮模型可能一次排出几十个只读调用，把文件句柄、网络连接与工具内部资源同时打满；同时调度器按准备阶段的输入分类，未考虑权限/钩子改写后输入可能已变成独占。

## Decision

- `ToolRuntime` 抽出 `checkInput()`：abort / plan mode / ask mode / schema / prompt capability 五项统一成一道门。
- 三个调用点复用同一道门：preflight、`PreToolUse` 改写后、权限判定后。
- 权限改写后额外重跑 `tool.validateInput` 与 `planTodo` 门，因为它们依赖最终输入语义。
- `ToolRuntime.execute` 增加 `options.requireConcurrencySafe`：执行前复核 `isConcurrencySafe(executeInput)`，输入从安全变为独占时拒绝并提示单独重试。
- `ConcurrentToolScheduler` 改为有界 worker 池（默认 4），结果按原始调用顺序回填；独占调用作为屏障，先排空在跑的调用再串行执行；构造期拒绝非正整数上限。
- 并发批次向 runtime 传 `requireConcurrencySafe: true`；上限为 1 时不传，因为没有并行。

## Alternatives considered

- **只在权限 hook 内部校验。** 落选。hook 是插件/宿主可替换的扩展点，校验属于执行边界；把不变式放进可替换层，换一个 hook 实现就会失效。
- **只复用 `validateToolInput`，不抽统一门。** 落选。plan/ask 与提示能力同样是执行前置条件，只补 schema 会留下同类缺口。
- **在 `ToolRuntime.execute` 入口统一校验一次最终输入。** 落选。入口拿不到改写后的输入；必须跟在每个改写点之后。
- **只改调度器上限，不改 runtime。** 落选。并发分类基于准备阶段输入，权限改写可能让它失效；只限流不能修正错误分类。
- **调度器遇到独占输入时直接串行重跑整个批次。** 落选。重复执行已经成功的只读调用有副作用风险；单次调用拒绝并提示单独重试更可控。
- **默认上限取 CPU 核数。** 落选。工具耗时主要是 I/O 与外部服务，核数不是合适的代理；4 是保守起点，可通过构造参数调整。

## Consequences

- 权限 hook 改写出非法输入从「静默执行」变为结构化 `invalid_tool_input` / `plan_mode_violation` / `ask_mode_violation` / `unsupported_tool` / `tool_aborted`。
- 单批并发上限默认 4。批量只读调用的总耗时可能上升；结果顺序不变。
- 合法改写有专门用例（`合法的权限改写仍可执行`），避免把正常 hook 改写误杀。
- 负控制已执行：去掉权限改写后的复核 → 5 条新用例转红；把上限改为无界 → 上限用例与构造期校验转红；恢复后 13 条全绿。
- 未改任何工具 `inputSchema`，不需要重录 llm-replay fixture。
