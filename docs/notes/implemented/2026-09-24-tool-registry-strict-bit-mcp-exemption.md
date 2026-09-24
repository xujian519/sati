# Agent Note: 工具注册表严格位跨派生表传递 + MCP 工具按 `kind` 豁免（#532）

Status: implemented

## Problem

`docs/open-issues-remediation-plan.md` §3.6 ① 的 `#532`（TD-TOOL-002）。

阶段四 T9 给 `ToolRegistry` 加了 `requireOutputSchema` 严格位：开启后，注册未声明
`outputSchema` 的工具会 fail-loud 抛错。`createBuiltinRegistry.ts:286` 用
`new ToolRegistry({ requireOutputSchema: true })` 建了**严格表**作为项目级注册表。

但**三处派生注册表都用无参 `new ToolRegistry()` 重建**，严格位归零：

- `ToolRegistry.clone()`（原 `:130`）——`sessionToolSurface.ts:85/:108/:123` 三处 clone。
- `filterAvailableTools.ts:19`——会话装配末尾对工具集做可用性过滤后重建。
- `SubAgentSession.buildScopedRegistry()`（`:172`）——子代理按角色裁剪工具时重建 scoped 表。

`options` 是 `private readonly`，外部拿不到，所以这三处即便想透传也无接口可用。

**两个面，issue 只点明了第一个：**

1. **防护面（issue 原文）**：派生表上注册无 schema 工具不再 fail-loud——「失去的是一道
   防护而非现存缺陷」，故被定 P3。
2. **现存功能缺陷面（issue 漏记，实测确证）**：项目级**共享 MCP 工具今天就被静默吞掉**。
   `ProjectRuntimeRegistry.ts:438` 经 `registerToolsIfAbsent` 把
   `createMcpToolDefinitionsFromRuntime` 产出的 MCP 工具定义注册进严格表；MCP 定义**本就
   不产出 `outputSchema`**（`PluginToToolBridge.ts:58-67`、`mcp/client/operations.ts:46`
   是 `content: unknown`，`structuredContent` 被丢弃、`toToolSpec` 不透传服务器 schema），
   严格表 `register()` **抛错** → `:447` 的 `catch` 降级为 warn → 该 MCP 工具**静默消失**
   （同批的 `:445` 辅助工具一并被跳过）。per-session MCP 同理：`sessionToolSurface.ts:88`
   的 `register(def)` 在 `:79-90` 的 try/catch 内，抛错表现为**整批 per-session MCP 工具
   静默全丢**（不是抛错）。

backlog 复核（`backlog.md:2223`）曾据「天真透传 options 会让 per-session MCP 注册立即
抛错」把本项由 **P2 降 P3**——这个降级依据本身把「修复会引入新破坏」当成了不可逾越的
约束，从而掩盖了「**现状已经在丢工具**」这一更严重的事实。

## Decision

### ① MCP 工具按 `kind === "mcp"` 豁免严格位（先定口径，再谈透传）

MCP 工具的**结果形状不可静态声明**：自研校验子集对 `{}` 恒通过，给它补一个宽松
`outputSchema` 只能是**恒真**——那是把「无契约」伪装成「有契约」，比诚实的「无 schema」
更糟。故 `register()` 的严格位检查追加 `&& tool.kind !== "mcp"`（`SatiToolKind` 已含
`mcp`，1 行且诚实）：

```ts
if (this.options.requireOutputSchema === true && tool.outputSchema === undefined && tool.kind !== "mcp") {
  throw new Error(`Tool ${tool.name} is missing its canonical outputSchema (phase 4 T9: ...)`);
}
```

**豁免必须先行**：只有先让 MCP 定义能注册进严格表，②的「透传严格位」才不会反过来打断
per-session / 共享 MCP 注册（这正是 backlog 降级依据所担心的破坏，被豁免消解）。透传
服务器侧 schema 留作后续独立刀。

### ② 新增 `registryOptions` getter，三处派生表透传 `this.options`

`options` 是 `private readonly`，故加一个**只读** getter 暴露给派生路径：

```ts
get registryOptions(): ToolRegistryOptions { return this.options; }
```

三处同批改（**必须同批**，否则 `sessionToolSurface.ts:135` 的 filter 会把 clone 的修复
抵消——clone 保住了严格位，紧接着 filter 又用无参表重建，严格位再次归零）：

- `clone()`：`const copy = new ToolRegistry(this.options);`
- `filterAvailableTools.ts:19`：`new ToolRegistry(registry.registryOptions)`
- `SubAgentSession.buildScopedRegistry()`：`new ToolRegistry(parentRegistry.registryOptions)`

### ③ 定级修正：实质 P2

「丢失的只是防护」的定级**不成立**——共享 MCP 工具今天就已被 `:438`→`:447` 静默吞掉，
是**现存功能缺陷**而非未来隐患。backlog 的 P3 降级依据（透传会打断 MCP 注册）已被 ① 的
kind 豁免消解。⇒ 按 **P2** 修复结案，`backlog.md` 两处 TD-TOOL-002 条目同步更正。

## Alternatives considered

- **给 MCP 工具补一个宽松 `outputSchema`（而非 kind 豁免）** — **否决**。自研校验子集对
  `{}` 恒通过，宽松 schema 是**恒真**的，等于把「无契约」伪装成「有契约」，比现状更误导；
  且它要逐处 MCP 定义生成点改动，面更大。kind 豁免诚实、1 行、集中在 `register()` 单点。
- **只修 clone（issue 字面范围），不动 filter / SubAgentSession** — **否决**。
  `sessionToolSurface.ts` 的装配链是 clone(:85) → register MCP(:88) → filter(:135)；只修
  clone 会被随后的 filter 无参重建抵消，严格位仍归零。三处必须同批，否则修复名存实亡。
- **透传 `this.options` 但不加 MCP 豁免** — **否决**（即 backlog 降级依据担心的破坏）。
  会让 per-session / 共享 MCP 注册立即抛错：共享路径被 `:447` catch 吞成 warn（工具消失），
  per-session 路径被 `:90` catch 吞成整批全丢。豁免与透传是一对，缺一不可。
- **把 `options` 改成 public 字段而非 getter** — 落选。getter 保持只读语义（调用方只能
  转发进 `new ToolRegistry(...)`，不能就地篡改），与 `private readonly` 的封装意图一致。
- **维持 P3 定级** — 落选。见 Decision ③：现存功能缺陷面使其实质为 P2，维持 P3 会让账本
  与事实矛盾。

## Consequences

- **正向**：① 项目级共享 MCP 工具不再被 `:438`→`:447` 静默吞掉；per-session MCP 工具不再
  被 `:88`→`:90` 整批吞掉。② clone / filter / 子代理 scoped 三处派生表恢复 fail-loud 严格位，
  会话作用域注册无 schema 的**非 MCP** 工具会抛错（防护面复原）。
- **行为边界（刻意）**：MCP 工具仍**不**被要求 `outputSchema`——这是诚实豁免，不是漏洞；
  非 MCP 工具的严格位一寸未松。
- **护栏（新增测试，`tests/tool/output-schema-validation.spec.ts`，node --test）**：
  - clone 保严格位：`cloned.registryOptions.requireOutputSchema === true`，clone 上注册非
    MCP 无 schema 工具 ⇒ 抛错；原工具仍在册。
  - filterAvailableTools 保严格位：过滤后表 `requireOutputSchema === true`，注册非 MCP 无
    schema 工具 ⇒ 抛错。
  - MCP 豁免：经与 `ProjectRuntimeRegistry:438` 相同的 `registerToolsIfAbsent` 入口注册一批
    MCP 定义 ⇒ `doesNotThrow`，`list().length` 与输入逐一相等、每个 `has()` 为真（共享 MCP
    工具不再被吞的直接断言）。
  - **三条负控制（已实测逐一变红）**：clone 退回无参构造 ⇒ clone 用例红；去掉 `kind` 豁免 ⇒
    MCP 用例红（且同表注册非 MCP 无 schema 仍抛错，证明是按 kind 精确豁免而非整体关闭严格位）；
    filter 退回无参构造 ⇒ filter 用例红。
  - 回归面：`dist/tests/tool/registry/*` + output-schema 两 spec + `SubAgentSession.spec` +
    `subagentExecutor.spec` + `agent-subagent-type.spec` 共 54 例全绿。
- **门禁联动**：`outputSchema` **不进** `toolSchemaDigest`（`requestInvariant.ts:75-77` 只含
  `name + inputSchema`）⇒ **不触发 llm-replay 重录**。三个改动文件均不在
  `architecture-baseline.json` 的 file-size 豁免清单 ⇒ 不触棘轮。`SubAgentSession.ts` 在
  `:196/:204/:212` 有事件 emit，但本次改动限于 `buildScopedRegistry()`（`:172-189`）未移动
  emit 行 ⇒ 事件矩阵 `file:line` 不受影响（已核 `pnpm check` 的 `check:event-matrix`）。
  行数变动跑 `pnpm measure:update`。

## 相关

- 议题：`#532`（TD-TOOL-002）。同批 PR 另含 `#538`（信任门整树哈希 memo + `blocked` 死角），
  两条决策独立、各自成提交（plan §5）。
- 代码：`src/tool/registry/ToolRegistry.ts`（getter + register 豁免 + clone 透传）·
  `src/tool/registry/filterAvailableTools.ts:19`（透传）·
  `src/agent/sub/SubAgentSession.ts`（`buildScopedRegistry` 透传）。
- 证据点：`createBuiltinRegistry.ts:286`（严格表）· `ProjectRuntimeRegistry.ts:438/:447`
  （共享 MCP 吞工具路径）· `sessionToolSurface.ts:85/:88/:135`（clone→register→filter 链）·
  `PluginToToolBridge.ts:58-67` / `mcp/client/operations.ts:46`（MCP 无静态 outputSchema）。
- 方案：`docs/open-issues-remediation-plan.md` §3.6 ① · §6.1（MCP 豁免口径分叉）。
