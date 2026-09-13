# Agent Note: 会话依赖装配段抽离（P4a 第七刀）

Status: implemented

## Problem

第六刀把专利输出门禁拆出去后，`ProjectRuntimeRegistry.ts` 仍有 1384 行，`prepareSessionRuntime` 里还剩两块成规模的装配代码：

- `baseDependencies`（42 行）——会话创建期就绪的运行时依赖：router、本会话工具表、lifecycle、时间源、事件缓冲、token 账本、模型能力查询三件套。
- `extendDependencies(storage)` 闭包（147 行）——拿到本会话 storage 后才能补的运行时：上下文运行时（含压缩/微压缩/snip 引擎与溢出恢复）、文件历史、子代理转录钩子、elicitation 通道、plan 文件与 todo 管理器。

两者共同依赖 `prepareSessionRuntime` 的 7 个局部量（`runtime` / `lifecycle` / `extension` / `projectRoot` / `memoryResolver` / `now` / `eventBuf`）与本次会话上下文，是"装配"而非"决策"，混在类里让这个 500 行方法的依赖面无法从签名读出。

## Decision

抽成 `src/cli/sessionDependencyAssembly.ts` 的 `buildSessionDependencies(deps): { baseDependencies, extendDependencies }`。

输入面 = 9 个字段：`sessionKey` / `projectKey` / `runtime`（5 字段投影）/ `sessionTools` / `lifecycle` / `extension` / `now` / `pilotHome` / `autoElicitation` / `getGateway`。

三处刻意的设计：

| 决定 | 理由 |
|---|---|
| `lifecycle` / `extension` 由调用方装配后**按值传入** | 权限 hook 就注册在同一个 `HookRuntime` 上（见 `prepareSessionRuntime`），本模块不得重建或替换它；否则会话级 `allow + remember` 的活引用回写会断 |
| `getGateway` 是**取数函数而非值** | gateway 由 `setGateway` 晚绑定；原闭包在 `extendDependencies(storage)` 真正被调用（建会话时）才读 `this.gateway` |
| `eventBuf` 的创建移进本模块 | 事件缓冲（`createAgentEventBuffer()`）只被这两段使用：`baseDependencies` 取 `emitter`/`drain`，`extendDependencies` 里两处发 `elicitation_requested`。留在类里会多传一个只用于透传的句柄 |

`sessionTitleGenerator`（3 行）**留在类里**：它不进依赖对象，是 `createSession`/`recreateSession` 的独立选项，跟"依赖装配"不是同一关注点。

**改写方式**：沿用 AST 脚本——切片 42 + 147 行，只做 6 类外层引用重命名（`context.sessionKey`×6 / `context.projectKey`×1 / `this.options.now`×3 / `this.options.pilotHome`×1 / `this.options.autoElicitation`×1 / `this.gateway`×1），反向重命名后与原文空白归一逐字相等（等价证明），再剪掉 19 个搬空后不再使用的 import 名。

结果：`ProjectRuntimeRegistry.ts` **1384 → 1182 行**，新模块 275 行。

## Alternatives considered

- **连权限 hook/lifecycle 段一起搬进同一个模块（即整段 `prepareSessionRuntime`）** — 落选：那一段持有 `liveRuleSet.allow` 的**活引用回写**（hook 里 remember=true 要写回同一数组，`createAgentConfig` 再把同一引用交给 `PermissionContext`），且 `hookRuntime` 还挂在 `contributions.hooks` 与 `this.gateway` 上；搬它需要把"活数组"作为显式入参在类内传递，风险面比这段大得多。保持"一段一刀、每刀独立可验"的节奏。
- **`extendDependencies` 里所有自由变量都改成 `deps.x` 全参数化** — 落选：会把这个 147 行闭包里的 30 余处 `runtime.` / `now` / `projectRoot` / `memoryResolver` / `eventBuf` 引用全部改写，等价证明退化成"逐处人工核对"；改为在模块内建同名的 5 个局部量（与原声明逐字同源），切片本体可以逐字不动。
- **把 `baseDependencies` / `extendDependencies` 拆成两个导出函数** — 落选：它们共享 `eventBuf` 与同一批投影，拆开后调用方要自己造缓冲与局部量，装配顺序的知识会漏回组合根；合成一个 builder 恰好把"两阶段装配"的内聚留下。
- **`getGateway` 按值传（`gateway: this.gateway`）** — 落选：与第六刀同一理由——当前装配顺序下能跑，但那是运行时顺序约定而非类型保证；按值传会把约定悄悄变成契约。
- **删除类内 `const projectRoot = runtime.projectRoot`，改由 builder 导出** — 落选：`projectRoot` 后面还要传给 `buildPatentOutputGate`，从 builder 反取一个本来就有的值会让调用点更长、更绕。

## Consequences

- 类文件 1384 → 1182 行；"会话依赖装配"成为独立模块，读签名即可判断它需要什么、不碰什么（不持有生命周期、不读注册表状态、不写任何实例字段）。
- 行为不变的三重证据：① 6 类重命名清单可复核（共 13 处），反向重命名后与原文**空白归一逐字相等**；② 新模块 `this` 表达式扫描为 0；③ `pnpm check` + `pnpm test` 全绿。
- 一处编译期暴露的输入面遗漏：脚本首轮漏了 `sessionTools`（`baseDependencies.tools.registry`），`pnpm typecheck` 立刻报 `TS2304 Cannot find name 'sessionTools'`（同时 eslint 报类内 `sessionTools` 不再被使用）——补成显式入参后消失。这正是"先跑门禁再下结论"的价值：靠人眼核对 189 行切片很容易漏掉一个自由变量。
- 事件矩阵随 `file:line` 漂移重生成（3 处：`agent_status` / `elicitation_requested` 的 `:1169` → `sessionDependencyAssembly.ts:222` / `submitTurn` 消费点行号）。
- P4a 剩余：`prepareSessionRuntime` 的权限 hook/lifecycle 段、`resolve`（249 行）、`createAgentConfig`（127 行）。
