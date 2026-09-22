# Agent Note: 子代理请求授权的归属（`permission_request.origin`） + 补齐子代理活动镜像测试

Status: implemented

## Problem

计划项 M5/3.1「子代理事件镜像补全」列了三条缺口。逐条核实后，**只有一条成立**，另两条是误判或结构性不适用——证据如下。

1. **工具 id 命名空间（计划所指「缺 1」）：不适用。** 计划要求把子代理工具 id 重写成 ZCode 那种 `<prefix>_<agentId>_<childId>`，并「同步重写 `dependencies` / `executionOrder` / `parallelGroups` 里的引用」。但 Sati 的 `CanonicalToolCall` 就是 `{ id, name, input, raw? }`（`src/model/protocol/canonical.ts:55-60`）——**被引用的那三个字段在 Sati 根本不存在**；ZCode 需要全局唯一 id，是因为它把子代理工具调用摊进父级同一张调度图里。Sati 相反：镜像事件带 `subagentId`，UI 桥再把每个子代理的详情帧摊进**按 subagentId 分桶**的独立消息表（`ui/src/stores/useSessionStore.ts:194` 的 `subagentDetailMessages`，消息 id 为 `${sessionId}::sub::${subagentId}-tool-${toolCallId}`，`ui/server/sati-bridge.js:620-667`），父会话列表里从不出现子代理工具行。且**加前缀会引入真实回归**：子代理详情面板把实时帧与 sidechain 快照按**原始 id** 去重（`ui/src/components/chat-v2/useSubagentMessages.ts:55-63` 的 `snapshotToolIds`），快照来自 `read_subagent_messages` 的协议 1.0 响应（原始 id）。前缀只加在实时侧 → 同一次工具调用会出现两行。
2. **权限事件缺归属（计划所指「缺 2」）：成立，但形态与计划描述不同。** 子代理的 `permission_requested` / `permission_denied` **AgentEvent** 早已带子代理 `sessionId`（子 ToolRuntime 拿的是父 emitter，是旁路直发），网关把它映射成 `[]`（`src/gateway/client/eventMapping.ts:452-455`）——所以它不是 UI 看到的那条路径。UI 的授权横幅走的是**另一条**：子代理共享父级的 `HookRuntime` 与 `sessionKey`，`dispatchLifecycle("PermissionRequest")` 触发网关权限 hook，hook 把 `permission_request` 发进**父会话**的 turn 流（`src/cli/sessionLifecycle.ts:60-63`），往返用父级 `GatewayPermissionBus` 桶解析。**端到端可达，已由新增测试锁住**——但帧里只有工具名，**用户看不出这是子代理在请求**，并行 fork 时更分不清是哪一个。
3. **`forwardActivity` 零测试（计划所指「缺 3」）：成立。** 子代理 AgentLoop 自身没有 eventEmitter，父界面能看到子代理在做什么全靠这一处投影，此前无任何覆盖。

## Decision

1. **给 `permission_request` 帧加可选 `origin`（协议 MINOR 1.11，无新方法）**：`{ kind: "subagent", subagentId, subagentType? }`（`GatewayEventOrigin`，`src/gateway/protocol/types.ts`）。主代理自身的请求不带该字段；旧客户端忽略即退回旧显示。
2. **归属来源是 fork 身份，不是 sessionId 解析**：`ToolRuntime` 把工具上下文里的 `subagentId` / `subagentType` 写进**生命周期 hook 输入的既有字段** `agentId` / `agentType`（`src/tool/execution/ToolRuntime.ts:511-527`）。这两个字段一直声明在 `SatiHookBaseInput`（`src/extension/hooks/protocol/input.ts:8-9`）且被 `toLegacyHookInput` 映射成 `agent_id` / `agent_type` 输出给命令 hook，**但全仓从来无人填充**——本次把它接上：命令 hook 与网关权限 hook 都能知道「谁在请求」。
3. **工具上下文的 `subagentId` / `subagentType` 只认 fork 会话**：由 `config.isSubagent` 把关，从 fork config 的 `metadata`（`AgentRuntimeConfig` 既有字段）取；主会话 metadata 里同名字段不会被当成归属（`src/agent/loop/toolContext.ts` 的 `resolveOwnerSubagent`）。
4. **UI 在横幅上标注来源**：`PendingPermissionRequest.origin` 经桥帧透传（`src/web/client/eventMapping.ts` → `useChatRealtimeHandlers` 的形状校验 `parseRequestOrigin`），横幅显示「子代理请求：{{agent}}」，`agent` 优先取 `subagentType`、缺类型时回落短 id。**分组键并入 origin**：同工具同输入但归属不同的请求不再合并成一张卡片（否则标注必然张冠李戴，子代理的请求会被算进主代理那条）。
5. **不做 id 命名空间**（见 Problem 1 的回归论证），**不改** `permission_requested` / `permission_denied` **AgentEvent**（子代理 `sessionId` 已带归属，加 `origin` 等于同一事实两个来源）。
6. **补测试**（本刀全部是新增覆盖，无既有断言被改）：
   - `tests/agent/sub/forwardActivity.spec.ts`：驱动真实 `SubAgentSession.run()`（两轮：工具调用 + 最终报告），锁「镜像三类事件 + 一律改写为父级 sessionId/turnId + 带 fork 身份」与「工具 id 原样透传」；并显式记录**双路径合同**——父 emitter 同时收到旁路直发的 `pre/post_tool_execute`（带子 sessionId，`subagentExecutor` 靠 `::sub::` 标记合成 `subagent_status`），所以镜像层不得重复发这两类。
   - `tests/gateway/permission/gateway-permission-hook.spec.ts`：`createGatewayPermissionHook` / `GatewayPermissionBus` 此前在 `tests/` 零引用；7 例覆盖 origin 有无/去空白/畸形输入、无 sink 立即 deny、allow+remember 往返写会话规则、deny 带理由往返。
   - `tests/tool/execution/hook-agent-identity.spec.ts`：hook 输入填/不填 `agentId`/`agentType` 两侧。
   - `tests/agent/loop/toolContext.spec.ts`（追加 3 例）：fork 带出身份、主代理不误标、非字符串 metadata 不注入。
   - `ui/.../PermissionRequestsBanner.test.tsx`：来源行渲染 + 跨归属不合并 + 同归属仍合并。
7. **门禁联动**：协议 1.11 台账条目（仅 `changes`，无新方法）→ `pnpm gen:doc-claims` 回填 `protocol_version` / `protocol_release_count`；事件面（`AgentEvent`）未改，但 `pnpm gen:event-matrix` 仍必须跑——`ToolRuntime` 与 `toolContext` 的 emit 点行号位移会体现在 `file:line` 硬编码的矩阵里。

## Alternatives considered

- **按计划做工具 id 命名空间（`<prefix>_<agentId>_<childId>`）** — 落选。要保护的那个键空间在 Sati 不存在（子代理工具行不进父会话列表）；而前缀只加在实时侧会让详情面板与 `read_subagent_messages` 快照对不上，出现重复行。若要「彻底命名空间化」，得连协议 1.0 方法的响应内容一起改——成本远大于收益，且破坏既有客户端。
- **`origin` 的 `subagentId` 从 `sessionId` 的 `::sub::` 标记反解** — 落选。反解拿不到**子代理类型**（用户最需要的那部分），且会把 `src/agent/loop/misc.ts` 的私有约定引进程网关层；填既有 hook 字段是有来源的归属，顺带让命令 hook 的 `agent_id` / `agent_type` 从死字段变成真值。
- **在 `permission_requested` / `permission_denied` AgentEvent 上也加 `origin`** — 落选。这两类事件的 `sessionId` 已经是子代理身份（旁路直发），再加 `origin` 就是同一事实两个来源；计划原文要的「给权限事件附 origin」由**真正抵达父界面**的那条事件（网关帧）兑现。
- **`forwardActivity` 里镜像权限事件** — 落选（并有 bug 风险）。子 ToolRuntime 已把权限事件直发父 emitter，镜像会**双发**，而 `subagentExecutor` 的状态合成依赖旁路那条；重复发会让状态机收到两份。
- **`origin` 里带上 `subagentType` 之外的更多信息（description / directive）** — 落选。类型足以回答「谁在请求」；再多的字段要穿过 hook 输入协议，收益不成比例。
- **不 bump 协议版本（把 `origin` 当纯内部字段）** — 落选。台账里 1.9（`active_turn_snapshot.projection`）与 1.10（`context_budget.fixedOverheadTokens`）为同类「既有帧加可选字段」立了先例，跳过会让协议台账与帧形状不一致。
- **给子代理开 elicitation 通道（让子代理也能 `ask_user_question`）** — 不在本刀范围。`SubAgentSession.cloneDependencies` 不传 `elicitation`，子代理调用 `ask_user_question` 会得到明确的 `unsupported_tool` 报错而不是挂死（`src/tool/builtin/askUserQuestion.ts:283-289`）；「子代理是否该阻塞在用户提问上」是设计取舍，不是本次可观测性缺口。
- **顺带补 `applyWebGatewayEvent`（`src/web/client/webMessage.ts`）的 `permission_request` 分支透传 `origin`** — 未做。该 reducer 的 `permission_request` 分支当前在 `src/` 与 `ui/` 下**零消费者**（只剩 `tests/web/tool-result-detail.spec.ts` 在用别的分支），改它是给死代码加字段；留待该 reducer 复活时一并处理。
- **用 `device` 侧（UI 侧）从子代理活动帧反查类型，而不是把 `subagentType` 放进帧** — 落选。活动帧根本不携带 `subagentType`（只有拼好的本地化标题，`ui/server/sati-bridge.js:560-578`），UI 只能靠 `subagentLinks` 的值反查；把类型放进帧更直接，且命令 hook 一并受益。

## Consequences

- **子代理请求授权时，父界面能明确显示来源**（`子代理请求：explore` / `Subagent request: explore`）；主代理自己的请求显示不变。
- **`SatiHookBaseInput.agentId` / `agentType` 从死字段变成真值**：项目 hook（命令/prompt/http/agent 四类）的输入里 `agent_id` / `agent_type` 现在在 fork 会话内非空——此前恒缺省。用户 hook 可据此对子代理做差异化策略（本刀未在 UI 暴露 hook 输入，属既有能力）。
- **协议 1.11 与 #512（hook 信任强制期，`hook_trust_list` / `hook_trust_decide`）在版本号上重叠**：两条链相互独立（#512 基于 main，本刀基于 `feat/architecture-boundary-gate` 链），**后合并者需把自己的条目改号为 1.12**。两处都是「台账末条追加一条」，git 会在同区域冲突（fail-loud，不会静默产生两个 1.11），且 `protocolLedgerIssues` 的 `version-duplicate` 是第二道网。
- **新增 4 个测试文件、12 个用例**；`docs/technical-debt/metrics.md` 的 tests 文件数（583→586）与 ui/src 文件数（571→572）须同 PR 提交（否则 `check:techdebt-metrics` 红）。
- 不改任何工具 `inputSchema`/`outputSchema` → llm-replay fixtures 不受影响（模型可见面零变化：`origin` 只出现在网关帧）。
