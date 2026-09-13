# Agent Note: 会话权限 hook / lifecycle 装配抽离（P4a 第十刀，收尾）

Status: implemented

## Problem

第九刀之后 `ProjectRuntimeRegistry.ts` 剩 677 行，`prepareSessionRuntime` 里还剩最后一块"跨模块接线"：把 gateway 的交互式权限 hook 挂到插件 hooks 之上，再包成 `LifecycleRuntime` 交给会话（37 行）。

它行数最少，却是 P4a 里唯一**持有活引用回写**的一段：hook 在 `remember=true` 时写回本会话的 `permissionRules.allow`，而这个数组必须与 `createAgentConfig` 交给 `PermissionContext.rules.allow` 的是**同一个引用**——否则同 turn 内下一次工具调用看不到刚授权的规则（远程客户端尤其明显，它没法从进程外访问 `sessionOverrides`）。正因为这条不变式，前十刀一直把它留到最后单独处理。

## Decision

抽成 `src/cli/sessionLifecycle.ts` 的 `buildSessionLifecycle(input): LifecycleRuntime`。

输入面 4 个：`sessionKey`、`hooks`（插件贡献点快照按值传入）、`gateway`（**装配期读一次**，与原文 `const gw = this.gateway` 逐字对应）、`getLiveRuleSet`（**取数函数**）。

关键点：模块**不自己造规则数组**，而是通过 accessor 向注册表要——注册表只在无显式会话覆盖时才 mint 并缓存 per-session 活数组（`fallbackRuleSets`）。活引用的语义因此留在唯一所有者（注册表）手里，本模块只负责接线。

**改写方式**：原注释块 + 代码共 37 行逐字搬移，4 类外层引用重命名共 8 处（`this.getLiveRuleSet(context.sessionKey)`×1 / `this.gateway`×1 / `context.sessionKey`×2 / `contributions.hooks`×4），反向重命名后与原文空白归一逐字相等；剪掉 4 个搬空后不再使用的 import 名（`HookRuntime` / `LifecycleRuntime` / `createGatewayPermissionHook` / `GATEWAY_PERMISSION_CALLBACK_NAME`）。

结果：`ProjectRuntimeRegistry.ts` **677 → 642 行**，新模块 71 行。**P4a 十刀至此收尾**。

## Alternatives considered

- **不抽这一段（37 行，十刀里收益最小）** — 认真权衡过：按行数它是最后一名的刀。落选理由：它是 `prepareSessionRuntime` 里唯一还直接 `new HookRuntime(...)` / `register(...)` 的地方，留着意味着"会话权限链接线"仍散在 500 行方法内部；且按关注点它属于"会话 lifecycle 装配"，与第九刀之后类的职责（会话级状态 + 编排）不同类。
- **`liveRuleSet` 按值传（`liveRuleSet: this.getLiveRuleSet(sessionKey)`）** — 落选：按值传会把"谁 mint、何时 mint"从注册表泄漏到调用点；将来若有人把 hook 与 `createAgentConfig` 两处的取数合并成一个会话级变量，"同一引用"就退化成靠巧合成立。accessor 让不变式留在原处。
- **连 `extension`（`PluginRuntimeExtensionResolver`，5 行）一起搬** — 落选：那是另一个关注点（插件/MCP 指令解析），为凑行数把两件事塞进一个模块不划算。
- **把 `snapshotContributions()` 的求值也搬进模块** — 落选：原代码在 `provisionSessionTools` **之前**取快照，搬进模块会让读取时机后移。当前 `provisionSessionTools` 并不改插件贡献点，但那是实现细节而非契约；保留调用点位置、只把 `hooks` 段按值传进去更稳。
- **让本模块同时负责 `extension` 的 `runtimeMcpInstructions` 接线** — 落选：`extension` 是 `sessionDependencyAssembly` 的输入（第七刀已定下边界），lifecycle 与它无依赖关系。

## Consequences

- 类文件 677 → 642 行；**P4a 十刀全部落地**——`prepareSessionRuntime` 现在只剩编排与取数，四个阶段（工具面 / lifecycle / 依赖装配 / 输出门禁）各自成模块，组合根 `createLocalGateway.ts` 448 行。
- 行为不变的三重证据：① 4 类重命名（8 处）反向重命名等价证明；② 新模块 `this` 表达式扫描为 0；③ `pnpm check` + `pnpm test` 全绿。
- 活引用不变式写进了模块 doc 与 `getLiveRuleSet` 字段注释——十刀里唯一"注释比代码重要"的模块，后人改它会先看到约束。
- 事件矩阵随 `file:line` 漂移重生成（1 处）。
- `docs/architecture-fix-plan.md` 的 P4a 行落 ✅；后续可选项：P4b（`AgentLoop.run()` 阶段骨架）、P3（三大渠道契约测试）、P4c（渠道类拆分）。
