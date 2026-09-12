# Agent Note: createLocalGateway 模块级 helper 外置（P4a 第一刀）

Status: implemented

## Problem

`src/cli/createLocalGateway.ts` 长期是全仓最大文件（2730 行），内部混着两类完全不同的东西：

- 一个 **1456 行的 `ProjectRuntimeRegistry` 类**（per-project runtime 装配 + session 生命周期 + 审批/规则/团队/看板接线）；
- **20 余个模块级 helper**（浏览器启动参数与代理解析、router 配置默认值构造、session 依赖合并、extension watch 处理、审批库构造、role 同步……），它们与类实例无关，却与类挤在同一文件里，使"读装配逻辑"必须先翻过近 700 行工具函数。

`docs/architecture-fix-plan.md` 的 P4a 要求把它拆成 4 个 builder（`createLocalGateway ≤600` 行）。这是一次 L 级重构，直接动类会同时触碰事件面、权限接线与 team/kanban 装配，爆炸半径过大。

## Decision

先做**零行为变更的第一刀**：把零外部引用的模块级 helper 按子系统外置到 `src/cli/` 下的三个新模块，`ProjectRuntimeRegistry` 与组合根函数本体不动。

| 新模块 | 内容 |
|---|---|
| `src/cli/browserLaunchArgs.ts` | `buildBrowserUseArgs` / `appendCliArg` / `resolveBrowserProxyServer` / `resolveBrowserProxyBypass` / `cleanEnvValue` + `BrowserProxySource` 类型 + 两个浏览器超时常量 |
| `src/cli/routerDefaults.ts` | `ensureRouterConfig` / `buildDefaultTokenSaver` / `buildDefaultAutoOrchestrate` |
| `src/cli/gatewaySupport.ts` | `handleMemberTurnCompleted` / `resolveBuiltinSkillsRoot` / `mergeSessionDependencies` / `describeExtensionScope` / `createAutoElicitationChannel` / `syncRoleDefinitions` / `createApprovalStoreSafely` + `sqliteApprovalStoreLogger` |

结果：`createLocalGateway.ts` **2730 → 2481 行**（−249），新模块合计 376 行（含文件头与 import）。

两处刻意保留：

- **`handleExtensionWatchEvent` 留在原文件**——它引用 `ProjectRuntimeRegistry` 类型，外置会形成 `gatewaySupport → createLocalGateway → gatewaySupport` 的循环依赖。
- **`buildBrowserUseArgs` 保留原路径再导出**（`export { buildBrowserUseArgs } from "./browserLaunchArgs.js"`）——`tests/gateway/browser-use-args.spec.ts` 从原文件导入它；保留再导出使该测试零改动。

## Alternatives considered

- **一次把类也按 4 个 builder 拆开** — 落选：那是 P4a 的目标形态，但一次做完会同时改动事件发射点、权限接线（`prepareSessionRuntime`/`createAgentConfig`）、team/kanban 装配与 session 生命周期，无法在单次变更里保证"行为不变"这一红线。第一刀先把零风险的 helper 清出去，让后续按 builder 拆类时面对的文件小一个量级。
- **把 `handleExtensionWatchEvent` 一并外置** — 落选：它引用 `ProjectRuntimeRegistry`，外置需要把类也提出来（等价于直接做 P4a 主体），或引入前向类型声明式的间接层，收益不值这个复杂度。
- **更新测试 import 指向新模块、删掉再导出** — 落选：再导出一行成本更低，且避免"同一符号两条导入路径"演变成第三种约定；测试改动本身不产生任何价值。
- **在 `src/cli/` 建 barrel 统一转出** — 落选：`src/cli/` 不是 barrel 结构的模块（入口是 `sati.ts`），引入 barrel 会让组合根的依赖方向变得不明显。
- **顺带把 `prepareSessionRuntime`（536 行）内部分段** — 落选：它是类方法、直接读写实例状态（`_sessionOverrides` / `_teamDb` / MCP runtime 表等），在类未拆之前拆方法只会把状态访问散得更开。

## Consequences

- 组合根文件缩小约 250 行；浏览器参数、router 默认值、网关辅助三族获得独立模块边界，后续按 builder 拆类时每刀面对的面更小。
- **事件矩阵已重生成**（`pnpm gen:event-matrix`）：跨文件移动代码后 `docs/event-producer-consumer.md` 的 `file:line` 会漂移，本 PR 一并提交该更新（AGENTS 铁律 5 与「关键环境事实」第 2 条）。
- 行为不变由三重证据支撑：全部搬移块与 `HEAD` 版**逐字一致**（16 个函数中 15 个逐字节相同，1 个仅因 biome 对超长签名换行而不同、语义一致）；`pnpm check` 全绿；`pnpm test` 4197 用例 0 失败。
- 未做（P4a 剩余步骤，已登记到 `docs/architecture-fix-plan.md` 的 P4a 行）：按子系统把 `ProjectRuntimeRegistry` 与组合根拆成 gateway / agent / tool / always-on 四个 builder，目标 `≤600` 行；`prepareSessionRuntime`（536 行）与 `createAgentConfig`（126 行）是下一刀的主要对象。
