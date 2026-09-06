# Agent Note: TD-TYPE-002 第一批——用守卫与类型化 context 收敛双层断言

Status: implemented

## Problem

issue #163（台账 TD-TYPE-002）列出的类型债中，gateway 两大热点（`GatewayWsConnection.ts` 43 处 `as never`、`RemoteGateway.ts` ~30 处 `as XResult`）已在先前提交收敛。剩余散点里，双层断言（`as unknown as X` / `as never`）让入参、DB 行与账本行在编译期彻底失去形状校验：字段错名/类型错位只能运行时暴露。本批收敛剩余散点中可安全恢复校验的部分：

- `patent/evidence/receipt.ts`：账本 JSONL 行 `as unknown as TeamEvidenceDeclaration/Receipt` 后仅手工抽查 1–2 个字段，其余必需字段缺失照常入账。
- `patent/provenance/provenance-store.ts`：`listAgents` 是唯一不走行类型单层断言的 list 方法。
- `cli/createLocalGateway.ts` teamToolCall：特权直调通道 `tool.execute(input as never, {...} as never)`——context 是缺 `cwd/turnId/permissionContext` 的空壳。
- `cli/proxy.ts`：undici 回退 fetch 用 `as never` 双端绕过，而 `network/fetch.ts` 已有更精确的 `Parameters<typeof undiciFetch>` 模式。
- 无约束泛型处（`mcp/runtime/sanitize.ts` ×3、`gateway/util/AsyncQueue.ts` ×2、`workflow/runtime/WorkflowEngine.ts`、`network/fetch.ts`）`as unknown as` 的 `unknown` 跳板多余，且跳板会绕过 TS 对断言合法性的宽容检查。
- `tool/askModeConstraints.ts` / `tool/userInteractionConstraints.ts`：`SatiToolDefinition` 默认 `Input = unknown`，`as never` 纯属多余。

## Decision

1. **账本行守卫化**（receipt.ts）：`isTeamEvidenceDeclaration` / `isReceipt` 类型守卫覆盖各自类型的全部必需标量字段（可选字段不查），加载期跳过不满足的行。守卫顺序 declaration → receipt 与原 `kind === "declaration"` 分支语义等价（declaration 行不含完整 receipt 字段集，不会误落入 receipt 分支）。
2. **teamToolCall 构造完整 `SatiToolRuntimeContext`**：`sessionId`（同旧）、`turnId: "team-panel-<uuid>"`、`cwd: fallbackProjectRoot`、默认 mode 的空规则 `PermissionContext`（`canPrompt: false`）。team_* 工具实际只消费 `sessionId/cwd/turnId/currentToolCallId`，行为不变；通道"不经 ToolRuntime 权限链"的设计不变（context 仅需满足形状）。
3. **undici 缝隙统一为参数化类型转换**：proxy.ts 复用 `Parameters<typeof undiciFetch>[0/1]` 模式；`network/fetch.ts` 末尾降为单层 `as Promise<Response>`（undici Response 与全局 Response 结构重叠，TS 宽容检查可通过）。
4. **双层降单层**：无约束泛型 `T` 的 constraint 是 `unknown`，任何类型到 `T` 的单层断言均合法，`unknown` 跳板一律删除。
5. **保留不动**（有意为之，勿机械清零）：`globalThis as unknown as {...}` 环境探测 ×2（webMessage/resolveWebSocketImpl）、turndown CJS/ESM interop、MCP SDK 私有字段 fallback（已有注释）、WeixinChannel 第三方 SDK 类型缝隙、`agent/loop/toolContext.ts` 的解耦转换（注释声明架构决策）、测试文件内部分 mock。

## Alternatives considered

- **改 `appendRunEvent` 接口接受 `AgentEvent`** — 落选：`RunEventSink` 的 `Record<string, unknown>` 是 web 服务层与 agent 事件类型的解耦接缝，改签名引入反向依赖；`{ ...event }` 浅拷贝字面量天然可赋 `Record<string, unknown>`，零断言且避免把事件对象的可变引用交给 store。
- **守卫字段集合保持与旧检查一致（只查 memberId/claimId/toolCallId）** — 落选：类型声明其余必需字段仍靠断言信任，等于半途而废；收严后才真正"防 undefined 入账"（原注释声明的设计意图），且磁盘坏行本就该跳过。
- **把 `SatiToolDefinition` 回调签名从泛型改为全 `unknown`** — 落选：影响 46+ 工具实现，本批收益不需要动协议层。

## Consequences

- 行为面两处轻微收严：账本加载跳过缺必需字段的结构坏行（原仅跳过坏 JSON 与缺抽查字段的行）；teamToolCall 直调时工具可读到合法 cwd/turnId。两者均为原注释/类型声明的意图修正，测试 `tests/patent/evidence/team-ledger.spec.ts` 新增结构坏行用例锁定。
- knowledge/** 的 DB 行 `as X`（29 处）与剩余单层断言留待 TD-TYPE-002 后续批次。
