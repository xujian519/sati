# Agent Note: 专利输出门禁构造抽离（P4a 第六刀）

Status: implemented

## Problem

第五刀把 `prepareSessionRuntime` 的会话工具面拆出去后，`ProjectRuntimeRegistry.ts` 仍有 1563 行。方法里第二块成规模的是**专利输出门禁**（167 行）：每会话一个 `PatentOutputGate`（命中审批词/规则的消息挂起等人工审批，审批经 gateway 暴露给 Web/TUI），外加两条默认关闭的通道——决策溯源旁路（P6）与宪法规则工具拦截（policy-bridge 编译 deny 规则）。

它与上一刀那批的差别在于：这段**回写实例状态**（`this.policyDenyRules`），并**依赖三个可变的实例绑定**——`this.gateway` 由 `setGateway` 晚绑定、`this._teamDb` 由 `setTeamDb` 晚绑定、`this._sessionOverrides` 可被 `updateSubsystems` 整体替换。

## Decision

抽成 `src/cli/patentOutputGateFactory.ts` 的 `buildPatentOutputGate(deps): PatentOutputGateBuild`（返回 `{ gate, policyDenyRules }`）。

**四处 accessor 是有意设计**，为的是保持原闭包的延迟求值语义：

| accessor | 为什么不能按值传 |
|---|---|
| `getGateway()` | `setGateway` 在工厂装配期晚绑定；原闭包在**审批发生时**才读 `this.gateway` |
| `getTeamDb()` | 同上（`setTeamDb`），且成员会话挂起审批要落 teams.db |
| `getSessionOverrides()` | `updateSubsystems` 可整体替换会话覆盖表；决策反馈回流在**异步回调里**才读它解出 cases 根 |
| `projectRoot` | 按值传入（来自本次调用的 runtime，调用期间不变） |

`this.policyDenyRules.set(runtime.projectRoot, policyDenyRules)` 这一行**留在类里**——它写的是注册表的 per-project 表，属于注册表状态而非门禁构造；工厂改为把 `policyDenyRules` 作为返回值交出，调用方在同一位置登记。

一处必要的代码整形：`if (memberKey !== null && this._teamDb) { this._teamDb.upsertPendingApproval(...) }`。改成 getter 后，守卫里读一次、体内再读一次会让 TS 的收窄失效（`deps.getTeamDb()` 每次调用都可能是 `undefined`），所以在守卫前把 getter 结果提成局部量 `const teamDb = deps.getTeamDb();`——同步块内只读一次，与原来的两次属性读等价。

结果：`ProjectRuntimeRegistry.ts` **1563 → 1384 行**，新模块 226 行（含两个 logger 常量——它们只被这段使用，一并搬走）。

**改写方式**：沿用 AST 脚本——13 处替换（`this.gateway`×3 / `this._teamDb`×3 / `this.options.env`×2 / `this.options.enableProvenance` / `this.options.now` / `this._sessionOverrides` / `context.sessionKey` / 裸 `projectRoot`×1），剔除 policy-bridge 登记行，再追加返回值。

## Alternatives considered

- **把 `this.policyDenyRules` 表也交给工厂（传 map 进去）** — 落选：那张表是注册表的 per-project 状态（`createAgentConfig` 读它注入 deny 规则），工厂只负责"编译出规则"；让工厂写注册表状态会把两个生命周期绑死，也让返回值失去意义。
- **gateway / teamDb 按值传（`gateway: this.gateway`）** — 落选：虽然当前装配顺序下 `setGateway`/`setTeamDb` 都先于首次会话创建，但这是**运行时顺序约定**而非类型保证；原闭包是延迟读，按值传会把"约定"悄悄变成"契约"，将来若出现"先建会话后设 teamDb"的路径就会静默退化为无审批落库。
- **把 `resolveApproval`、`onPending` 等回调抽成导出的纯函数、由类组装** — 落选：它们共同闭包 `sessionKey` / `patentOutputGateLogger` / `ruleGate` 等一串局部量，全参数化会产生 7–8 个参数的函数，可读性反不如整块搬走。
- **一次性把 `prepareSessionRuntime` 余下两段（权限 hook/lifecycle、baseDependencies）也搬走** — 落选：那两段持有 `liveRuleSet.allow` 这类**活引用回写**（权限 hook 的 remember 决策要写回同一数组）与十余个 runtime 投影，风险面比这一段大得多；保持"一段一刀、每刀独立可验"的节奏。

## Consequences

- 类文件 1563 → 1384 行；门禁构造（HITL 审批闭环 + 溯源旁路 + policy-bridge）成为独立模块，输入面即 4 个 accessor + 4 个值，读签名可判依赖。
- 行为不变的三重证据：① 13 处替换清单可复核，残余根标识符（`this` / `runtime` / `context`）扫描为零；② 除"policy 登记行改返回值、`teamDb` 提成局部量"两处显式整形外，区域文本逐字未动；③ `pnpm check` + `pnpm test` 全绿。
- 事件矩阵随 `file:line` 漂移重生成（5 处）并随 PR 提交。
- P4a 剩余：`prepareSessionRuntime` 的权限 hook/lifecycle 段与 `baseDependencies` 装配段、`resolve`（249 行）、`createAgentConfig`（127 行）。
