# Agent Note: 会话工具面 provisionSessionTools 抽离（P4a 第五刀）

Status: implemented

## Problem

第四刀之后组合根已收口（`createLocalGateway.ts` 448 行），但 `ProjectRuntimeRegistry.ts` 仍是 1663 行的单类文件；其中 `prepareSessionRuntime` 一个方法 537 行，把四件不同的事串在一起：会话工具面、权限 hook 与 lifecycle、baseDependencies 装配、专利输出门禁。

第一段「会话工具面」（113 行）最值得先拆，理由是它同时命中一条已登记的债：**browser-use 专属逻辑混在通用会话装配里**（TD-GOD-002 (c)——截图目录 `mkdirSync`、逐 spec 参数改写、代理透传）。想读懂"会话怎么装配"的人必须先读完这段 MCP 特例。

## Decision

抽成 `src/cli/sessionToolSurface.ts` 的 `provisionSessionTools(input): Promise<SessionToolSurface>`，返回 `{ tools, unavailableTools }`。

它把四层筛选按原顺序收进一个函数（顺序即语义）：

1. **每会话 MCP runtime**——`perSession: true` 的 server 为每个会话起独立进程：改写参数（截图目录 cwd、代理透传）、启动、把工具注册进会话注册表；实例数上限内驱逐旧实例，启动失败降级为共享项目级实例并告警。
2. **unattended 会话 `excludeTools`**——按会话覆盖剔除需交互的工具。
3. **`always_on_*` 剥离**——非 Always-On 会话不暴露需要 `AlwaysOnRunContext` 的工具。
4. **可用性过滤 + 成员角色裁剪**——`filterAvailableTools` 按环境探测；成员会话再按角色定义裁剪，并保留 `domain === "team"` 的作业面。

两处必要改写：

- `runtime.unavailableTools = availability.unavailable` 的**写回改为返回值**，由调用方赋值（函数不再持有 `runtime`；`SessionToolSurfaceInput` 只收它真正用到的 `projectTools` / `projectRoot` / `proxy` / `perSessionServerSpecs` 等投影字段，因此不必导出 `ProjectRuntime` 私有类型）。
- `this.evictSessionMcp` 以回调形式传入（它同时stop/删除该会话的 MCP runtime 与表项），避免把整个 registry 传进去。

结果：`ProjectRuntimeRegistry.ts` **1663 → 1563 行**，新模块 167 行。

**改写方式**：延续前两刀的 AST 脚本——扫描区域内 11 种 property-access 链（`this.sessionMcpRuntimes` / `this.options.env` / `runtime.tools` / `runtime.snapshot.config.proxy` / `runtime.snapshot.config.gateway?.maxPerSessionMcpInstances` / `context.sessionKey` …），规划 span 后从后往前替换；`runtime.unavailableTools = …` 一行单独剔除并转化为返回值。

## Alternatives considered

- **按状态边界拆（把 `prepareSessionRuntime` 拆成 4 个私有方法）** — 落选：拆成私有方法只是把 537 行切成 4 段、仍然挂在同一个类上，`this` 的读写面不变；文件级拆分才让"工具面"拥有可单测的输入面。
- **整段 `prepareSessionRuntime` 一次性搬到 builder 模块** — 落选：它还要用 `this.gateway` / `this._teamDb` / `this._sessionOverrides` / `this.policyDenyRules` / `this.getLiveRuleSet()` 等一堆实例状态，一次搬完等于把类的一半搬走却留下半套 deps 接口（且权限 hook 的回调要回写 `liveRuleSet.allow`，语义上需要活引用）。分阶段搬：工具面（无回写、纯函数化）→ 输出门禁 → agent config。
- **把 `unavailableTools` 写回也留在新模块里（传 runtime 进去）** — 落选：那会让新模块依赖 `ProjectRuntime` 私有类型，把一个纯函数变成"半个 runtime 修改器"；返回值更克制，调用方一行赋值。
- **顺带把 `evictSessionMcp` 的实现也搬进来** — 落选：它操作的是 registry 自己的 `sessionMcpRuntimes` 表与被驱逐会话的 MCP 进程，属于注册表生命周期，不是"会话工具面"的一部分；以回调注入即可。
- **同时把下一段（专利输出门禁 167 行）一起搬** — 落选：它持有 `this.gateway`/`this._teamDb`/`this.policyDenyRules` 三处实例状态回写，与"纯函数化"的这批不同类，留作下一刀单独处理。

## Consequences

- 类文件 1663 → 1563 行；browser-use 特例从"通用会话装配"里移出，落在明确命名且带四层语义说明的模块里。
- 行为不变的三重证据：① AST 规范化对比——把 `input.x` 与 `this.x`/`runtime.x`/`context.x` 归一到同一记号后，基线与搬移后的阶段文本打印结果完全相同（2704 字符对 2704 字符，仅在剔除 `unavailableTools` 写回、追加返回值两处有意差异）；② 残余捕获扫描为零（区域内不再出现 `this` / `runtime` / `context` 根标识符）；③ `pnpm check` + `pnpm test` 全绿。
- 事件矩阵随 `file:line` 漂移重生成（5 处）并随 PR 提交。
- P4a 剩余：`prepareSessionRuntime` 的其余三段（权限 hook/lifecycle、baseDependencies、专利输出门禁 167 行）、`resolve`（249 行）、`createAgentConfig`（127 行）。
