# Agent Note: 会话 Agent 配置构造抽离（P4a 第八刀）

Status: implemented

## Problem

第七刀之后 `ProjectRuntimeRegistry.ts` 还剩 1183 行，类里最后一块成规模的**配置装配**是 `createAgentConfig`（125 行）：把「项目配置 + 会话覆盖 + 环境变量」合成一份 AgentSession 的 config——会话级 provider/model 路由覆盖（M4 团队成员唤醒）、多模态能力解析、上下文/输出上限（含 subagent 模型的上限）、方法论注入闭包、以及交给 `PermissionRuntime` 的 `PermissionContext`。

读它的签名（`runtime, context`）完全看不出真实依赖面：它还读**四处注册表状态**——`_sessionOverrides`（会话覆盖表）、`getLiveRuleSet()`（会话活规则集）、`policyDenyRules`（per-project policy deny 表）、`methodologyRegistry`。

## Decision

抽成 `src/cli/agentSessionConfig.ts` 的 `buildAgentSessionConfig(deps): CreateAgentSessionOptions["config"]`，输入面 = 会话标识（`sessionKey` / `modelRoute`）+ 运行时投影（`projectRoot` / `snapshot` / `model`）+ 4 个值 + 4 个取数函数。

**四处取数保持 accessor 是有意的**（不是风格偏好）：

| 取数 | 为什么不能按值传 |
|---|---|
| `getLiveRuleSet()` | 无显式会话覆盖时**会 mint 并缓存**一份 per-session 活规则数组（`ProjectRuntimeRegistry.fallbackRuleSets`）；提前在调用点求值会把这份**有状态的副作用**挪到参数求值期。返回的 `allow` 与 gateway 权限 hook 是**同一数组引用**（`remember=true` 写回它，同 turn 内下一个工具调用即生效） |
| `getPolicyDenyRules()` | 读 per-project 表（由 `patentOutputGateFactory.ts` 登记），原表达式带 `?? []` 兜底——把兜底留在取数函数里 |
| `getSessionOverride()` | 会话覆盖表可被 `updateSubsystems` **整体替换** |
| `permissionMode` / `env` / `additionalWorkingDirectories` / `methodologyRegistry` | 是构造后不再替换的 `readonly` 值，按值传入 |

类内只留 **16 行薄适配** `createAgentConfig`（把注册表内部状态包成 accessor），两个调用点（`createSession` / `recreateSession`）零改动。

**改写方式**：沿用 AST 脚本——切片 120 行，8 类外层引用重命名共 13 处（`this._sessionOverrides?.get(context.sessionKey)` / `this.getLiveRuleSet(context.sessionKey)` / `this.policyDenyRules.get(runtime.projectRoot) ?? []` / `this.options.permissionMode` / `this.options.additionalWorkingDirectories` / `this.options.env`×5 / `this.methodologyRegistry` / `context.modelRoute`），反向重命名后与原文空白归一逐字相等；再剪掉 5 个搬空后不再使用的 import 名（`parsePositiveInt` / `resolveModelInfo` / `injectMethodology` / `mergePolicyDenyRules` / `createDefaultPermissionContext`）。

结果：`ProjectRuntimeRegistry.ts` **1183 → 1073 行**，新模块 175 行。

## Alternatives considered

- **一次性连 `resolve`（249 行）一起搬** — 落选：`resolve` 持有 runtimes 缓存、plugin 刷新、MCP 懒启动与 per-session MCP 等有状态装配，风险面比这块大得多；保持"一段一刀、每刀独立可验"。
- **四处注册表读取按值传参** — 落选：`getLiveRuleSet()` 的 mint 副作用与"活数组共享"不变式会被挪到调用点的参数求值期，语义上不再等价；会话覆盖表还有被整体替换的可能。accessor 让求值点与原文逐字对齐，代价只是三个 `() =>`。
- **类内不留 `createAgentConfig`，两个调用点直接调 `buildAgentSessionConfig`** — 落选：调用点就要自己拼 10 个字段并知晓 `_sessionOverrides` / `policyDenyRules` / `fallbackRuleSets` 这些私有状态；薄适配方法把"注册表内部状态 → 输入面"的映射留在类里，调用点与 diff 都最小。
- **模块导出工厂（返回 `(runtime, context) => config`）** — 落选：调用方仍需每次传 runtime/context，工厂只多一层闭包；本模块一次调用一次用，参数直传更直白。
- **顺手把 config 里的 env 读取换成 `shared/env` 的 `readBoolEnv` / `readIntEnv`** — 落选：那是**语义级**替换（P1 的 env 收敛未把这一处列入），混进纯搬运的刀里会让"行为不变"的证据链变脏；如需收敛另开一刀。

## Consequences

- 类文件 1183 → 1073 行；"会话 config 怎么来"成为独立模块，输入面即签名可读，类内只剩"注册表状态 → 输入面"的映射。
- 行为不变的三重证据：① 8 类重命名清单可复核（共 13 处），反向重命名后与原文**空白归一逐字相等**；② 新模块 `this` 表达式扫描为 0；③ `pnpm check` + `pnpm test` 全绿。与第七刀不同，这次输入面**一次列全**——`pnpm typecheck` 首轮即绿（第七刀是首轮漏 `sessionTools` 后才补的）。
- 事件矩阵随 `file:line` 漂移重生成（2 处：`agent_status` 与 `submitTurn` 消费点的行号）。
- 同批修正一处文档笔误：架构计划 P4a 状态块仍写"前六刀已落地"（第七刀时漏改），本次改为"前八刀"。
- P4a 剩余：`prepareSessionRuntime` 的权限 hook/lifecycle 段（唯一持有 `liveRuleSet.allow` 活引用回写的部分）与 `resolve`（249 行）。
