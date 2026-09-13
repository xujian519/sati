# Agent Note: 项目运行时构造抽离（P4a 第九刀）

Status: implemented

## Problem

第八刀之后 `ProjectRuntimeRegistry.ts` 剩 1073 行，其中最大的一块是 `resolve`（243 行）加两个只服务于它的私有成员：`buildRouterEventBus`（80 行）与 `emitBackgroundTaskCompletion`（19 行），再算上 `ProjectRuntime` 类型（43 行）。

`resolve` 是"首次触达某项目时把一切装起来"的流程——读 PilotConfig 快照、建模型/路由/工具表/记忆与知识库解析器/后台任务/per-project 存储，再把结果塞进 `runtimes` 缓存。它与类的关系只有四类：读构造选项、读写 `runtimes` 缓存、读写 `routerEventBus` 公开字段、按 sessionId 查 `sessionWriters`；其余全是纯粹的构造代码。把这段留在类里，让这个类看起来像"什么都干"，掩盖了它真正持有的状态（会话级规则集、MCP 会话运行时、审批落库等）。

## Decision

抽成 `src/cli/projectRuntimeFactory.ts` 的 `createProjectRuntimeResolver(deps): { resolve(projectKey?) }`，并把 `ProjectRuntime` 类型**迁成该模块的导出**（构造者即契约所有者），注册表改为 type-only 导入。

输入面 = 8 个值 + 4 个取数 + 1 个写回 + 2 个活 Map：

| 输入 | 为什么是这个形态 |
|---|---|
| `getExtraTools` / `getTeamTools` / `getKanbanBoardManager` | 分别由 `updateSubsystems` / `setTeamTools` / `setKanbanBoardManager` 在**首次 resolve 之后**注入或整体替换 |
| `getGateway` | `setGateway` 晚绑定；重试进度广播与后台任务完成事件都在**事件发生时**才读它 |
| `setRouterEventBus(bus) => bus` | `routerEventBus` 是注册表公开字段（`createLocalGateway` dispose 经它同步 flush 缓冲），构造期必须写回注册表；回调**返回同一个 bus**，保证 `createRouterRuntime({ events })` 原表达式的值不变 |
| `runtimes` / `sessionWriters` | 注册表的活 Map（原地增删、引用不变），按值传入即可 |
| `fallbackProjectRoot` / `pilotHome` / `builtinSkillsRoot` / `env` / `now` / `telemetry` / `modelFactory` / `onProjectActivated` | 构造后不再替换的选项值 |

**改写方式**：三段切片（`resolve` 主体 241 行 / `buildRouterEventBus` 主体 78 行 / `emitBackgroundTaskCompletion` 主体 17 行）+ 16 类外层引用重命名共 30 处，每段反向重命名后与原文空白归一逐字相等。

**一处必要的整形**（与第六刀 `teamDb` 同类）：`emitBackgroundTaskCompletion` 里 `if (!event.sessionId || !this.gateway) return;` 之后 `this.gateway.emitForSession(...)`——原代码读的是属性，TS 的收窄跨后续属性读有效；改成取数函数后每次调用都可能返回 `undefined`，故在守卫前提成局部量 `const gateway = deps.getGateway();`（同一同步块内只读一次，与原来两次属性读等价）。

结果：`ProjectRuntimeRegistry.ts` **1073 → 677 行**，新模块 489 行。

## Alternatives considered

- **只搬 `resolve`，把 `buildRouterEventBus` / `emitBackgroundTaskCompletion` 留在类里当回调传入** — 落选：那两个成员只被 `resolve` 使用（`buildRouterEventBus` 只在构造 router 时调一次、`emitBackgroundTaskCompletion` 只作 `BackgroundTaskRuntime.onCompletion`），留在类里等于让"运行时构造"这件事横跨两个文件；一起搬走后注册表只剩"取数/写回"三个箭头，可读性反而更好。
- **`ProjectRuntime` 类型留在注册表，工厂返回结构化投影类型** — 落选：注册表会**原地改**这个对象的可选字段（`unavailableTools`、`mcpRuntime`、`mcpReady`、`perSessionServerSpecs`、`memoryMaintenanceInFlight`…），两边都需要完整类型；复制一份必然漂移。让构造者持有类型定义、消费方 type-only 导入是唯一不会分叉的做法。
- **`setRouterEventBus` 改成返回 void，另在注册表 `resolve` 包装里赋值** — 落选：赋值发生在工厂内部（`createRouterRuntime` 参数求值期），包装层拿不到同一个 bus 实例的时机；让写回回调返回入参，原表达式 `events: (this.routerEventBus = this.buildRouterEventBus())` 可以 1:1 映射成 `events: deps.setRouterEventBus(buildRouterEventBus())`，反向等价证明因此能覆盖这一段。
- **`getExtraTools` 等按值传** — 落选：`updateSubsystems` 会让 `_extraTools` 指向新数组；按值传会让"首次 resolve 之前"的旧快照固化成契约。取数函数与原来的属性读逐字对应。
- **顺手把 `buildRouterEventBus` 的 250ms 缓冲 flush 换成正则/共享 flush 工具** — 落选：那是行为级改动（缓冲窗口与落盘时机），混进纯搬运会让"行为不变"的证据链变脏。

## Consequences

- 类文件 1073 → 677 行；"项目运行时怎么来"成为独立模块，注册表的剩余职责收敛为"会话级状态 + 装配编排"。
- 行为不变的三重证据：① 三段切片各自通过反向重命名等价证明（16 类、30 处），② 新模块 `this` 表达式扫描为 0，③ `pnpm check` + `pnpm test` 全绿。唯一整形（emit 里的 gateway 局部量）已在上面显式列出，与第六刀同类处理。
- 事件矩阵随 `file:line` 漂移重生成（2 处：`agent_status` 生产者移到 `projectRuntimeFactory.ts:150`，`submitTurn` 消费点行号变化）。
- P4a 剩余：`prepareSessionRuntime` 的权限 hook/lifecycle 段（唯一持有 `liveRuleSet.allow` 活引用回写的部分）。
