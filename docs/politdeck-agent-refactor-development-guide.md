# PolitDeck Agent 重构代码开发文档

本文用于指导将 `third-party/claude-code-main` 中围绕 agent loop 的会话、turn、模型循环、工具回填和运行状态能力重构为 PolitDeck 自有 `agent` 模块。目标不是复制旧项目的 `QueryEngine.ts` 和 `query.ts`，而是把已验证的行为协议收敛为可测试、可组合、可被 CLI / SDK / UI 共用的 Agent Runtime。

本文件遵循 `.cursor/skills/refactor-with-parity` 的要求：不能声称“与旧实现行为一致”，除非存在同一套共享场景同时运行 legacy 和 PolitDeck 实现，并比较归一化输出。

## 1. 背景与目标

`docs/rewrite-plan/02-rewrite-project-report.md` 已经定义 PolitDeck 目标架构以 `agent` 为中心：

```text
adapters
  -> agent
    -> model
    -> context
    -> tool
    -> permission
    -> session
    -> extension
```

当前仓库已经有第一版 `model`、`tool`、`permission` 实现：

- `src/model/` 提供 canonical message、tool call、tool result、stream event、provider request/response 归一化。
- `src/tool/` 提供 tool definition、registry、runtime、sequential scheduler、result 到 canonical `tool_result` 的转换。
- `src/permission/` 提供 permission mode、rule、decision runtime。

当前仓库还没有 `src/agent/`。本次文档定义下一阶段 agent 模块如何把现有模块编排起来，并为后续实现和 parity 测试提供稳定边界。

第一阶段目标：

- 建立 PolitDeck 自有 `AgentSession`、`TurnRunner`、`AgentLoop` 和 agent event protocol。
- 用 canonical model/tool 类型驱动模型流、工具调用、工具结果回填和继续条件。
- 保留 legacy 多 turn、流式输出、工具循环、权限决策、max turns、abort、usage 汇总、transcript 写入时机等核心行为。
- 将 legacy 中耦合在 `query.ts` 的 context compaction、hooks、plugins、skills、remote、subagent、worktree 等能力拆成明确接口、骨架或延期项。
- 让 CLI / SDK / UI 只消费 agent 事件，不直接依赖 model provider、tool runtime、session storage 或 UI 状态。

非目标：

- 第一阶段不实现完整 UI 渲染层。
- 第一阶段不实现完整 hooks plugin system。
- 第一阶段不实现完整 subagent / swarm / worktree 生命周期。
- 第一阶段不迁移旧项目 telemetry、feature flag、CCR、bridge、remote session 的全部分支。
- 第一阶段不把 legacy Anthropic SDK message shape 暴露为 PolitDeck agent 公共协议。

## 2. 命名和边界规则

新代码、事件、错误码和配置只使用 `PolitDeck` / `politdeck` 命名。旧项目品牌名只允许出现在文档和 legacy probe 路径中。

建议事件名：

```text
politdeck_agent_session_started
politdeck_agent_turn_started
politdeck_agent_model_request_started
politdeck_agent_model_event
politdeck_agent_tool_calls_detected
politdeck_agent_tool_results_ready
politdeck_agent_turn_continued
politdeck_agent_turn_completed
politdeck_agent_turn_failed
politdeck_agent_session_aborted
politdeck_agent_transcript_recorded
```

建议错误码：

```text
agent_aborted
agent_max_turns_reached
agent_model_error
agent_prompt_too_long
agent_context_recovery_failed
agent_tool_result_pairing_failed
agent_transcript_error
agent_invalid_state
agent_unsupported_feature
```

模块边界：

- `agent` 可以依赖 `model`、`tool`、`permission`、`context`、`session` 的抽象接口。
- `agent` 不直接读取 `~/.politdeck`、不直接操作 React/Ink、MCP transport、telemetry SDK 或 shell。
- `agent` 不直接构造 provider-specific request body；必须通过 `model` canonical runtime。
- `agent` 不直接执行工具；必须通过 `ToolScheduler` / `ToolRuntime`。
- `agent` 不直接展示 permission UI；只接收 `permission` 和 adapter 提供的决策结果。

## 3. Source Of Truth

重构时必须持续对照以下来源：

| 类型 | 路径 | 用途 |
| --- | --- | --- |
| 总方案 | `docs/rewrite-plan/02-rewrite-project-report.md` | PolitDeck 目标架构和模块依赖方向 |
| 现状分析 | `docs/current-agent-loop-analysis/01-agent-loop-core.md` | legacy agent loop 内核职责和继续/终止条件 |
| 现状分析 | `docs/current-agent-loop-analysis/03-context-session-runtime.md` | 输入处理、上下文、transcript、resume、中断 |
| 现状分析 | `docs/current-agent-loop-analysis/04-runtime-modes.md` | permission mode、plan、subagent、worktree、remote 等模式影响 |
| 当前实现 | `src/model/` | canonical model protocol 和 stream event |
| 当前实现 | `src/tool/` | tool call 执行、permission、result 映射 |
| 当前实现 | `src/permission/` | permission mode 和 rule 决策 |
| 当前实现 | `src/model/providers/anthropic/stream.ts` / `src/model/providers/openai/stream.ts` | streaming tool call event 形状和当前缺口 |
| 当前实现 | `src/model/request/validateModelRequest.ts` | model capability、tool use、multimodal validation |
| 当前实现 | `src/tool/registry/ToolRegistry.ts` | tool schema 输出、alias lookup 和排序 |
| 当前实现 | `src/tool/protocol/types.ts` | `PolitDeckToolRuntimeContext` 必填字段 |
| 当前实现 | `src/tool/audit/ToolAuditRecorder.ts` | agent 需要透传的 permission/tool audit recorder |
| legacy 实现 | `third-party/claude-code-main/src/QueryEngine.ts` | 会话级封装、输入处理、transcript、SDK 输出映射 |
| legacy 实现 | `third-party/claude-code-main/src/query.ts` | 核心模型-工具循环、恢复、max turns、abort、tool result 回填 |
| legacy 实现 | `third-party/claude-code-main/src/utils/processUserInput/processUserInput.ts` | turn 进入模型前的输入扩展 |
| legacy 实现 | `third-party/claude-code-main/src/utils/messages.ts` | message、tool_result、progress、tombstone、lookup 语义 |
| legacy 实现 | `third-party/claude-code-main/src/utils/sessionStorage.ts` | transcript 写入和 resume 关键规则 |
| legacy 实现 | `third-party/claude-code-main/src/utils/forkedAgent.ts` | 子 agent / forked loop 的隔离语义 |
| 现有测试 | `tests/model/`、`tests/tool/`、`tests/permission/` | node:test 风格、fixture、dual parity 模式 |

## 4. Legacy 行为清单

下表按行为能力分类，而不是按 legacy 文件逐行迁移。`compare` 表示第一阶段要建立 shared scenario 并比较 legacy 与 PolitDeck 归一化结果；`deferred` 表示识别旧行为但第一阶段不实现；`intentional_difference` 表示新行为有意不同；`not_applicable` 表示旧项目内部或产品专属行为不迁移。

| Legacy feature | Legacy entrypoint | PolitDeck feature | Status | Notes |
| --- | --- | --- | --- | --- |
| 会话级 agent 封装 | `QueryEngine` | `AgentSession` | `compare` | 一个 session 包含多次 submit，每次 submit 是一个 turn |
| turn 提交入口 | `QueryEngine.submitMessage()` | `AgentSession.submit()` | `compare` | 接收用户输入，产出异步 agent event 流 |
| 可恢复消息状态 | `mutableMessages` | `AgentSessionState.messages` | `compare` | turn 间保留历史；compact boundary 之后可裁剪 |
| usage 累计 | `totalUsage` | `AgentSessionState.usage` | `compare` | 从 stream usage / response usage 归一化累加 |
| permission denial 汇总 | `permissionDenials` | `AgentTurnResult.permissionDenials` | `compare` | 工具非 allow 决策需进入 turn result |
| abort controller | `abortController` | `AgentAbortController` | `compare` | 模型流、工具执行、permission 均可被取消 |
| 输入预处理 | `processUserInput()` | `TurnInputProcessor` | `deferred` | 第一阶段只保留普通文本/blocks；slash/local command/attachment 后续拆到 `context`/adapter |
| 用户消息先写 transcript | `recordTranscript(messages)` before `query()` | `TranscriptWriter.recordAcceptedInput()` | `compare` | 用户消息一旦 accepted，进入模型前就要可 resume |
| system init 输出 | `buildSystemInitMessage()` | `agent_session_initialized` event | `compare` | 内容字段用 PolitDeck 命名和 canonical summary |
| 不进入模型的本地结果 | `shouldQuery: false` | `TurnInputProcessorResult.shouldCallModel` | `deferred` | slash/local command 第一阶段不做完整迁移 |
| agent loop async generator | `query()` | `AgentLoop.run()` | `compare` | 产出 request、model、tool、control、result 事件 |
| loop mutable state | `State` in `query.ts` | `AgentLoopState` | `compare` | messages、turnCount、recovery、pending summary 等分离 |
| request start event | `stream_request_start` | `agent_model_request_started` | `compare` | 每次模型请求都产出 |
| 模型流消费 | `deps.callModel()` | `ModelRuntime.streamModel()` | `compare` | 使用 `CanonicalModelEvent` |
| tool use 识别 | assistant content `tool_use` blocks | `CanonicalToolCallBlock` collection | `compare` | 不依赖 provider stop reason |
| 继续条件 | `toolUseBlocks.length > 0` | `AgentLoopDecision.continueForToolResults` | `compare` | `stop_reason === tool_use` 不作为唯一依据 |
| 工具调度 | `runTools()` / `StreamingToolExecutor` | `ToolScheduler.executeAll()` | `compare` | 第一阶段使用 sequential scheduler；streaming tool deferred |
| tool_result 回填 | user message with `tool_result` | canonical user message with `tool_result` blocks | `compare` | 每个 tool call id 必须配对一个 result |
| missing tool_result 修复 | `yieldMissingToolResultBlocks()` | `ensureToolResultPairing()` | `compare` | 模型/中断错误后不能留下 orphan tool call |
| max turns | `maxTurns` + `max_turns_reached` attachment | `agent_max_turns_reached` result | `compare` | 计数规则需要 scenario 固化 |
| prompt too long preempt | blocking token limit | `ContextRuntime.checkBlockingLimit()` | `deferred` | 第一阶段定义接口；具体 token policy 后续实现 |
| proactive compaction | autocompact/microcompact/snip/collapse | `ContextRuntime.prepareForModel()` | `deferred` | agent 只调用接口，不内联策略 |
| reactive compact | prompt-too-long recovery | `ContextRuntime.recoverFromModelError()` | `deferred` | 第一阶段可返回 unsupported/deferred |
| max output tokens recovery | retry with override / meta prompt | `AgentRecoveryPolicy` | `deferred` | 需要 model/runtime 支持后实现 |
| fallback model | `fallbackModel` | `ModelSelectionPolicy.fallback` | `deferred` | 第一阶段可记录为 unsupported recovery |
| streaming fallback tombstone | `tombstone` events | `agent_message_tombstoned` | `deferred` | 仅在实现 provider fallback 后需要 |
| assistant/user/system event projection | `normalizeMessage()` to SDK messages | `AgentEventProjector` | `compare` | 不暴露 legacy SDK shape，但要保留流式语义 |
| progress messages | `createProgressMessage()` | `agent_progress` event | `deferred` | tool runtime 当前无 progress channel |
| tool use summary | `createToolUseSummaryMessage()` | `agent_tool_summary` event | `deferred` | UI 辅助能力，不阻塞第一阶段 |
| stop hooks | `handleStopHooks()` | `AgentStopHookAdapter` | `deferred` | hooks plugin system 后续实现 |
| post sampling hooks | `executePostSamplingHooks()` | `AgentPostModelHookAdapter` | `deferred` | 同上 |
| mid-turn queued commands | command queue attachments | `TurnNotificationSource` | `deferred` | task/daemon/remote 后续实现 |
| MCP tool refresh | `refreshTools()` | `ToolRegistrySnapshot.refresh()` | `deferred` | MCP 骨架实现后接入 |
| memory prefetch | `startRelevantMemoryPrefetch()` | `ContextRuntime.prefetch()` | `deferred` | memory module 未实现 |
| skill discovery prefetch | skill prefetch module | `ExtensionRuntime.prefetchSkills()` | `deferred` | skill manager 暂缓 |
| transcript inline progress/attachment | `recordTranscript()` cases | `TranscriptWriter.recordEvent()` | `deferred` | 第一阶段只记录 user/assistant/tool_result/control |
| compact boundary resume | `compact_boundary` message | `AgentContextBoundary` | `deferred` | 第一阶段定义协议，具体 compaction 后续 |
| subagent context isolation | `createSubagentContext()` | `AgentForkRuntime` | `deferred` | 第一阶段只保留 agent id / parent id 字段 |
| forked agent loop | `runForkedAgent()` | `AgentSession.fork()` | `deferred` | 后续独立开发 |
| remote / bridge / CCR | bridge/session runner | adapter-specific runtime | `not_applicable` | 不进入 agent 核心；未来 adapter 层实现 |
| telemetry event names | `tengu_*` events | `politdeck_*` audit/event | `intentional_difference` | 命名和字段按 PolitDeck 重新定义 |
| feature flag 分支 | `feature(...)` | config/capability gates | `intentional_difference` | 不继承 legacy feature flag 名称 |
| Anthropic-specific message object | `BetaMessageParam` | `CanonicalMessage` | `intentional_difference` | 公共协议必须 provider-neutral |

## 5. 目标目录结构

建议新增目录：

```text
src/agent/
  index.ts

  protocol/
    events.ts
    state.ts
    input.ts
    result.ts
    errors.ts

  session/
    AgentSession.ts
    AgentSessionState.ts
    createAgentSession.ts

  turn/
    TurnRunner.ts
    TurnInputProcessor.ts
    TurnResultBuilder.ts

  loop/
    AgentLoop.ts
    AgentLoopState.ts
    collectToolCalls.ts
    ensureToolResultPairing.ts
    projectToolResults.ts
    decideLoopContinuation.ts

  runtime/
    AgentRuntime.ts
    AgentRuntimeConfig.ts
    AgentRuntimeDependencies.ts

  context/
    ContextRuntime.ts
    NullContextRuntime.ts

  transcript/
    TranscriptWriter.ts
    InMemoryTranscriptWriter.ts
    JsonlTranscriptWriter.ts

  testing/
    scriptedModel.ts
    scriptedContext.ts
    inMemoryAgentRuntime.ts
```

对应测试目录：

```text
tests/agent/
  protocol-events.test.ts
  session.test.ts
  turn-runner.test.ts
  loop-tool-continuation.test.ts
  loop-abort.test.ts
  loop-max-turns.test.ts
  transcript.test.ts
  parity-dual-contract.test.ts
  parity-dual-execution.test.ts

tests/fixtures/agent/dual-parity/
  contractScenarios.ts
  executionScenarios.ts

tests/helpers/
  agent.ts
  dualAgentContractReport.ts
  dualAgentExecutionReport.ts

third-party/claude-code-main/src/
  politdeck-agent-legacy-contract-report.ts
  politdeck-agent-legacy-execution-report.ts
```

## 6. Public Protocol

### 6.1 Agent Input

`AgentSession.submit()` 接收 provider-neutral input：

```ts
export type AgentInput =
  | { type: "text"; text: string; isMeta?: boolean }
  | { type: "blocks"; content: CanonicalContentBlock[]; isMeta?: boolean };

export type AgentSubmitOptions = {
  turnId?: string;
  maxTurns?: number;
  metadata?: Record<string, unknown>;
};
```

第一阶段只要求文本和 canonical blocks。slash command、local command、IDE selection、paste、MCP resource attachment 等都通过后续 `context` / adapter 层扩展，不应写死在 agent 核心。

### 6.2 Agent State

```ts
export type AgentSessionState = {
  sessionId: string;
  messages: CanonicalMessage[];
  usage: CanonicalUsage;
  permissionDenials: AgentPermissionDenial[];
  status: "idle" | "running" | "aborted" | "failed";
  currentTurnId?: string;
  abortController: AbortController;
};

export type AgentLoopState = {
  sessionId: string;
  turnId: string;
  messages: CanonicalMessage[];
  turnCount: number;
  maxTurns?: number;
  pendingToolCalls: CanonicalToolCall[];
  lastAssistantMessage?: CanonicalMessage;
  usage: CanonicalUsage;
  transition?: AgentLoopTransition;
};
```

`AgentLoopState` 是一次 turn 内部状态，`AgentSessionState` 是跨 turn 状态。不要让 adapter 直接修改这两个对象；外部只通过 `AgentSession` API 和事件流观察。

### 6.3 Agent Events

第一阶段必须稳定以下事件：

```ts
export type AgentEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "turn_started"; sessionId: string; turnId: string }
  | { type: "input_accepted"; sessionId: string; turnId: string; messages: CanonicalMessage[] }
  | { type: "model_request_started"; sessionId: string; turnId: string; model: string; provider: string }
  | { type: "model_event"; sessionId: string; turnId: string; event: CanonicalModelEvent }
  | { type: "assistant_message"; sessionId: string; turnId: string; message: CanonicalMessage }
  | { type: "tool_calls_detected"; sessionId: string; turnId: string; calls: CanonicalToolCall[] }
  | { type: "tool_result"; sessionId: string; turnId: string; result: PolitDeckToolResult }
  | { type: "tool_results_projected"; sessionId: string; turnId: string; message: CanonicalMessage }
  | { type: "turn_continued"; sessionId: string; turnId: string; reason: AgentLoopTransition["reason"] }
  | { type: "turn_completed"; sessionId: string; turnId: string; result: AgentTurnResult }
  | { type: "turn_failed"; sessionId: string; turnId: string; error: AgentError }
  | { type: "session_aborted"; sessionId: string; reason?: string };
```

事件分两类：

- 模型上下文事件：`assistant_message`、`tool_results_projected` 会进入 session message history。
- 观察事件：`model_event`、`tool_result`、`turn_started`、`turn_completed` 不直接进入模型上下文，除非显式投影。

这条边界对应 legacy 中 progress / stream event / transcript message 混杂造成的复杂性。PolitDeck 第一阶段要避免把所有输出都写进 prompt history。

### 6.4 Turn Result

```ts
export type AgentTurnResult = {
  type: "success" | "error" | "aborted" | "max_turns";
  sessionId: string;
  turnId: string;
  finalMessage?: CanonicalMessage;
  stopReason:
    | "completed"
    | "max_turns"
    | "aborted_streaming"
    | "aborted_tools"
    | "model_error"
    | "prompt_too_long"
    | "tool_error"
    | "unsupported_recovery";
  usage: CanonicalUsage;
  permissionDenials: AgentPermissionDenial[];
  turns: number;
  startedAt: string;
  completedAt: string;
  errors?: AgentError[];
};
```

`stopReason` 不是 provider `finishReason` 的别名。legacy 中已经明确 `stop_reason === "tool_use"` 不可靠；PolitDeck 必须以实际收集到的 tool call block 和恢复策略为准。

## 7. Runtime Dependencies

`AgentRuntime` 只持有抽象依赖：

```ts
export type AgentRuntimeDependencies = {
  model: {
    stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent>;
  };
  tools: {
    scheduler: PolitDeckToolScheduler;
    registry: ToolRegistry;
  };
  context: AgentContextRuntime;
  transcript: AgentTranscriptWriter;
  now: () => Date;
  uuid: () => string;
};
```

其中 `context` 第一阶段可由 `NullContextRuntime` 实现：

```ts
export type AgentContextRuntime = {
  prepareForModel(input: AgentContextPrepareInput): Promise<AgentPreparedContext>;
  applyToolResults(input: AgentApplyToolResultsInput): Promise<CanonicalMessage[]>;
  recoverFromModelError(input: AgentModelErrorRecoveryInput): Promise<AgentRecoveryDecision>;
};
```

第一阶段 `NullContextRuntime` 只做：

- 透传 session messages。
- 添加本次用户输入。
- 返回当前 tool schemas。
- 不做 token 预算和压缩。
- 对 prompt too long / media error / max output tokens 返回 `unsupported_recovery`。

这样 agent loop 可以先稳定编排协议，复杂 context 治理后续逐步替换。

## 8. 接入已重构模块的关键要求

Agent 是新架构的编排层，第一版实现必须直接接入当前已经重构出的 `model`、`tool`、`permission`，而不是重新造一套平行协议。下面这些点来自当前源码复核，是实现前必须处理的关键边界。

### 8.1 Model 接入

当前 `src/model/index.ts` 已导出 `Model.stream` / `streamModel()`、`CanonicalModelRequest`、`CanonicalModelEvent`、`CanonicalMessage`、`CanonicalToolSchema`、`CanonicalToolCall`、`CanonicalToolResultBlock`、`ModelConfig`、`ModelCapabilities` 和 `MultimodalConstraints`。

Agent 构造模型请求时必须：

- 使用 `ToolRegistry.toCanonicalSchemas()` 生成 `request.tools`，不要自己拼 provider-specific schema。
- 传入 `provider` 和 `model`，并让 `validateModelRequest()` 做 provider、model、tool use、streaming、system prompt、multimodal capability 检查。
- 在模型不支持 tool use 时，不要把工具 schema 传给模型；如果当前 turn 必须使用工具，应在 agent 层返回 `agent_model_capability_error` 或等价错误，而不是等 provider 报错。
- 让 multimodal input 先经过 `model` 的 `assertContentSupported()` 路径；agent 不要重复实现图片、PDF、音频限制。
- 使用 `CanonicalModelEvent` 驱动 loop，不读取 Anthropic/OpenAI raw event 来做业务判断，除非是在 model 层修复 normalizer。

当前重要缺口：

- `streamModel()` 的 public options 目前没有外部 `AbortSignal` 参数，内部 `sendProviderRequest()` 只创建 timeout controller。Agent 文档里的 `model.stream(request, signal)` 需要在实现前落到源码：要么扩展 `ModelRuntimeOptions` 支持 `signal`，要么提供 agent 专用 wrapper 合并 turn abort signal 和 provider timeout。否则 `AgentSession.abort()` 无法可靠取消模型请求。
- OpenAI stream normalizer 会在 finish 时产出 `tool_call_end`，但 Anthropic stream normalizer 当前只产出 `tool_call_start` 和 `tool_call_delta`，且 delta id 使用 index 字符串，未产出完整 `tool_call_end`。Agent loop 不能假设所有 provider 都会给完整 `CanonicalToolCall`。实现前应优先在 `model` 层补齐 Anthropic streaming tool call assembly，或在 agent 增加 provider-neutral `ModelEventAccumulator` 并用测试固定差异。

建议新增 provider-neutral accumulator：

```text
src/model/streaming/
  assembleModelMessage.ts
```

它负责把 `CanonicalModelEvent` 组装为：

```ts
export type AssembledAssistantMessage = {
  message: CanonicalMessage;
  finishReason: CanonicalFinishReason;
  usage?: CanonicalUsage;
  toolCalls: CanonicalToolCall[];
};
```

Agent loop 只消费这个 accumulator 的输出。这样 no-tool、tool-call、partial-error、abort 场景都能用同一套测试验证。

### 8.2 Tool 接入

当前 `src/tool/index.ts` 已导出 `ToolRegistry`、`createBuiltinRegistry()`、`ToolRuntime`、`SequentialToolScheduler`、`PolitDeckToolRuntimeContext`、`toCanonicalToolResultBlock()`，以及 read/glob/grep/edit/write/bash、ask user、web、MCP、structured output、plan mode 等内置工具 factory。

Agent 接入规则：

- 第一阶段 tool execution 必须走 `PolitDeckToolScheduler.executeAll()`，不要在 agent 中直接调用 `tool.execute()`。
- Agent 每次工具执行都要构造完整 `PolitDeckToolRuntimeContext`：`sessionId`、`turnId`、`cwd`、`abortSignal`、`permissionMode`、`permissionContext`、`auditRecorder`、`env`、`maxResultBytes`、`now`。
- `permissionMode` 和 `permissionContext.mode` 必须保持一致。当前 tool runtime 两个字段都存在；如果二者冲突，permission audit 和实际决策可能分叉。
- `ToolRegistry.toCanonicalSchemas()` 只输出 canonical `tool.name`，不会输出 aliases。模型侧应看到 PolitDeck canonical snake_case 名称；如果要兼容 legacy PascalCase alias（例如 `Read`、`Bash`、`Edit`），应由 registry lookup 接受 alias，但 parity scenario 必须明确模型 schema 暴露名和 call lookup 名是否一致。
- `createBuiltinRegistry()` 当前只注册 read/glob/grep/edit/write/bash。Agent 如果需要 plan mode、structured output、MCP、web、ask user question，必须通过 runtime config 显式注册额外 tools，不能假设 builtin registry 已包含全部工具。
- `ToolRuntime` 已经记录 permission audit 和 tool audit；agent 应通过 `auditRecorder` 透传到 session/adapter 统一 audit，不要二次猜测 tool 是否执行。
- `ToolRuntime` 在 permission `ask` 且 `canPrompt=false` 时会返回 `permission_required` error result。Headless agent 应把该 result 回填给模型，并把 denial/request 信息汇总到 `AgentTurnResult.permissionDenials`。

### 8.3 Permission 接入

当前 `PermissionRuntime` 的真实行为：

- deny rule 优先。
- ask rule 其次。
- tool-specific `checkPermissions()` 再执行。
- `bypassPermissions` 允许。
- `plan` mode 默认只允许 read-only；但如果 `bypassAvailable` 为 true，当前实现会允许。
- `acceptEdits` 允许 filesystem 非 read-only 工具。
- read-only 工具在普通模式下允许。
- `dontAsk` 会把 ask 转成 deny。

Agent 实现需要注意：

- `AgentSession` 的 permission mode 不能只存在于 agent state；必须下沉到每次 tool context。
- Plan mode 不只是 permission mode。当前 `src/tool/builtin/planMode.ts` 的 `enter_plan_mode` / `exit_plan_mode` 返回 `data.requestedMode`，agent 或 adapter 必须决定是否更新 session permission mode。不能让工具返回了 requested mode 但 session 状态不变。
- `exit_plan_mode` 标记 `requiresUserInteraction()`，headless 场景要么返回 permission/request event，要么明确 deferred；不能静默切换。
- Permission denial summary 应从 `ToolRuntime` result/audit 中归集，而不是在 agent 中复写 permission 判断。

### 8.4 Structured Output 接入

当前 `structured_output` 工具返回 `metadata: { structuredOutput: true }`。Agent 第一阶段如果支持 `jsonSchema` 或 headless structured output，需要：

- 将 `structured_output` 注册进 tool registry。
- 在 tool result 中检测 `metadata.structuredOutput === true`。
- 将 `result.data` 保存到 `AgentTurnResult.structuredOutput` 或 adapter-specific result。
- 决定该工具调用后是否继续请求模型。legacy `QueryEngine` 会捕获 structured output tool call 的数据并最终输出；PolitDeck 必须用 scenario 固定第一版行为。

如果第一阶段不支持 structured output，应把 `agent-structured-output` 加入 deferred parity scenario，而不是只注册工具但 agent 不消费 metadata。

### 8.5 Context 和 Model Validation 接入

`context.prepareForModel()` 输出的 messages 不是任意数组，必须满足 model request validation：

- content block modality 必须被目标模型支持。
- tool call / tool result 必须保持 provider 可投影的顺序。
- OpenAI request builder 会把 `tool_result` block 拆成 role `tool` message；Anthropic request builder 会把 `tool_result` 保留在 user message content 中。Agent 不能自己按某个 provider 的消息格式重排。
- thinking block 在 legacy 中有签名和保留规则；当前 canonical thinking block 只有 text。第一阶段如不保留 thinking signature，应列为 intentional difference 或 deferred，不要声称 thinking parity。

### 8.6 Audit 和 Event 接入

Agent event stream 和 tool audit 是两条链：

- `AgentEvent` 给 adapter/UI/SDK 消费。
- `PolitDeckToolAuditRecorder` 记录 permission/tool 执行。

Agent 不应把 audit record 直接塞进 model context，也不应把所有 `model_event` 写入 transcript。建议第一阶段 durable transcript 只写：

- accepted user message。
- final assembled assistant message。
- projected tool_result user message。
- compact/control boundary skeleton。
- turn result metadata。

观察性事件可以由 adapter 订阅，但默认不进入 prompt history。

## 9. Execution Flow

### 8.1 Session submit flow

```text
AgentSession.submit(input)
  -> create turn id
  -> TurnInputProcessor.accept(input)
  -> append accepted user message to session state
  -> transcript.recordAcceptedInput()
  -> emit input_accepted
  -> TurnRunner.run()
  -> persist assistant/tool_result/control messages as they become durable
  -> update session state and usage
  -> emit turn_completed / turn_failed
```

关键规则：

- 用户输入一旦 accepted，必须先写 transcript，再进入模型请求。
- 如果输入处理决定不调用模型，仍然要产出 `turn_completed`。
- 如果 transcript 写入失败，第一阶段应返回 `agent_transcript_error`，不要静默丢失可恢复性。

### 8.2 Loop iteration flow

```text
AgentLoop.run()
  -> context.prepareForModel(loopState)
  -> emit model_request_started
  -> for await model.stream(request)
       -> emit model_event
       -> accumulate assistant content
       -> collect tool_call blocks
       -> accumulate usage
  -> if model error
       -> context.recoverFromModelError()
       -> continue / fail
  -> if no tool calls
       -> complete turn
  -> scheduler.executeAll(tool calls)
       -> ToolRuntime validates input
       -> PermissionRuntime decides
       -> tool executes or returns permission error
  -> project tool results into canonical user message
  -> ensure every tool call has a matching tool_result
  -> if max turns reached
       -> complete with max_turns
  -> append assistant + tool_result messages
  -> continue next model request
```

### 8.3 Tool continuation rule

PolitDeck 继续条件必须匹配 legacy 的核心语义：

- 如果本轮 assistant message 中出现一个或多个 `tool_call` block，执行工具并继续。
- 不把 provider `finishReason === "tool_call"` 当作唯一继续条件。
- 如果 tool call 执行失败，也要把失败结果作为 `tool_result` 回填给模型，除非已达到 max turns 或 abort。
- 如果模型流失败且已经产出 tool call，必须生成 synthetic error tool result，避免 orphan tool call。

### 8.4 Tool result projection

PolitDeck `ToolRuntime` 已经提供 `toCanonicalToolResultBlock()`。agent 需要负责把一批 result 组合成一个 user message：

```ts
export function projectToolResults(results: PolitDeckToolResult[]): CanonicalMessage {
  return {
    role: "user",
    content: results.map(toCanonicalToolResultBlock),
  };
}
```

约束：

- `toolCallId` 必须等于原始 `CanonicalToolCall.id`。
- error result 必须设置 `isError: true`。
- 结果顺序默认跟 tool call 顺序一致。
- 第一阶段 scheduler 是 sequential，所以结果顺序稳定。
- 后续并发/streaming scheduler 必须显式记录原始 call order，不能让完成顺序改变模型上下文顺序，除非 parity 场景证明 legacy 也是完成顺序。

### 8.5 Abort flow

abort 需要覆盖三个阶段：

| 阶段 | 行为 |
| --- | --- |
| 模型请求前 | 不调用 model，返回 `agent_aborted` |
| 模型 streaming 中 | 停止读取流；若已收集 tool call，生成 synthetic error tool result；返回 `aborted_streaming` |
| 工具执行中 | scheduler/runtime 接收 abort signal；已完成结果保留，未完成工具返回 abort error；返回 `aborted_tools` |

第一阶段不要求完全模拟 legacy 的 interruption message 文案，但必须保证消息链结构有效：不能留下未配对 tool call。

## 10. Feature Matrix

| Feature | First phase | Status | Reason |
| --- | --- | --- | --- |
| `AgentSession.submit()` async iterable | yes | `compare` | SDK/headless 和 UI 共用事件流的基础 |
| 多 turn session state | yes | `compare` | legacy `QueryEngine` 核心行为 |
| canonical user/assistant messages | yes | `intentional_difference` | 不暴露 legacy Anthropic shape |
| model streaming event passthrough | yes | `compare` | 支撑流式输出 |
| model abort signal | yes | `compare` | 需要先补齐 `streamModel()` 外部 signal 接入 |
| provider-neutral message assembly | yes | `compare` | Anthropic/OpenAI streaming tool call 形状不同，agent 不能直接猜 |
| assistant message assembly | yes | `compare` | tool call 检测依赖完整 assistant content |
| tool call detection | yes | `compare` | loop 继续条件 |
| sequential tool scheduler | yes | `compare` | 当前 `src/tool/` 已具备 |
| complete tool runtime context | yes | `compare` | `ToolRuntime` 依赖 session/turn/cwd/permission/audit/abort/env |
| permission denial collection | yes | `compare` | result 需要暴露 denial summary |
| permission mode propagation | yes | `compare` | agent state 与 `PermissionContext.mode` 必须一致 |
| plan mode state transition | skeleton | `deferred` | `enter_plan_mode` / `exit_plan_mode` 需要 adapter/session 确认 |
| structured output capture | skeleton | `deferred` | 工具已存在，但 agent 需消费 metadata/data |
| tool result projection | yes | `compare` | 模型工具循环必要协议 |
| max turns | yes | `compare` | 防止无限循环 |
| abort propagation | yes | `compare` | 模型和工具都必须支持 |
| accepted input transcript write | yes | `compare` | resume 正确性关键 |
| JSONL transcript persistence | skeleton | `deferred` | 第一阶段可先做 memory writer + contract |
| context prepare interface | skeleton | `deferred` | 复杂压缩后续 |
| prompt too long recovery | no | `deferred` | 需要 token budget/context |
| max output token recovery | no | `deferred` | 需要模型策略 |
| fallback model retry | no | `deferred` | 需要 model selection policy |
| streaming tool executor | no | `deferred` | 当前 tool scheduler 是 sequential |
| progress event channel | skeleton | `deferred` | tool runtime 暂无 progress |
| stop hooks | no | `deferred` | extension/hooks 模块未实现 |
| post sampling hooks | no | `deferred` | 同上 |
| slash command input | no | `deferred` | adapter/context 承接 |
| local command direct result | no | `deferred` | adapter/context 承接 |
| attachments / IDE selection | no | `deferred` | context module 承接 |
| MCP resources in prompt | no | `deferred` | MCP resource skeleton 后续接入 |
| skills/plugins/memory prefetch | no | `deferred` | extension/context 后续 |
| subagent/fork | no | `deferred` | 后续独立 agent fork design |
| worktree mode | no | `deferred` | adapter/tool permission workspace roots 后续 |
| remote bridge / CCR | no | `not_applicable` | adapter 层，不进入 agent 核心 |
| legacy telemetry | no | `intentional_difference` | PolitDeck audit/event 重命名 |

## 11. Implementation Order

### Phase 0: Agent protocol only

新增：

- `src/agent/protocol/events.ts`
- `src/agent/protocol/state.ts`
- `src/agent/protocol/input.ts`
- `src/agent/protocol/result.ts`
- `src/agent/protocol/errors.ts`
- `src/agent/index.ts`

测试：

- event union 字段稳定。
- error code 归一化。
- `AgentTurnResult` stop reason 枚举覆盖 max turns、abort、model error。

完成标准：

- 不依赖 legacy import。
- 不依赖 provider-specific type。
- 所有 exported type 可由 CLI / SDK / UI adapter 引用。

### Phase 1: Model event accumulator and abort plumbing

先补齐 agent loop 依赖的 model 层能力：

- `ModelRuntimeOptions.signal` 或等价 external abort signal。
- timeout signal 与 turn abort signal 的合并策略。
- provider-neutral `assembleModelMessage()`。
- Anthropic streaming tool call assembly：从 `tool_call_start`、index-based delta 和 block stop 中组装完整 `CanonicalToolCall`。
- OpenAI streaming tool call assembly 回归测试，确保 existing `tool_call_end` 语义不退化。

测试：

- OpenAI stream 能组装 text + tool call + usage + finish reason。
- Anthropic stream 能组装 text + tool call input + usage + finish reason。
- invalid tool JSON 归一化为 model/provider error，不让 agent 收到半个成功 tool call。
- external abort signal 能取消 fetch / stream。
- timeout 和 abort 同时存在时，错误原因可归一化。

完成标准：

- Agent loop 不需要读取 raw provider event。
- Agent loop 能从同一 accumulator 得到完整 assistant message 和 tool calls。
- Abort 不只取消工具，也能取消模型请求。

### Phase 2: Loop helpers

新增：

- `collectToolCalls()`
- `projectToolResults()`
- `ensureToolResultPairing()`
- `decideLoopContinuation()`

测试：

- assistant message 中有 tool call 时必须继续。
- finish reason 为 stop 但有 tool call 时仍继续。
- finish reason 为 tool_call 但没有 tool call block 时不继续，或标记 invalid state。
- tool call 缺 result 时生成 synthetic error result。
- 多 tool call 按原始顺序投影。

完成标准：

- helper 只处理 canonical message 和 current tool result。
- 不调用 model、tool runtime 或 transcript。

### Phase 3: AgentLoop

实现 `AgentLoop.run()`：

- 调用 `context.prepareForModel()`。
- 构造 `CanonicalModelRequest`。
- 消费 `CanonicalModelEvent`。
- 组装 assistant message。
- 调用 `ToolScheduler.executeAll()`。
- 回填 tool results。
- 处理 max turns 和 abort。

测试：

- 无工具调用：一次模型请求后完成。
- 单工具调用：模型 -> 工具 -> tool_result -> 第二次模型。
- 多工具调用：所有结果回填后继续。
- 工具 permission denied：以 error tool_result 回填并继续。
- max turns：超过限制返回 `max_turns`。
- abort before model / during stream / during tools。
- model capability error：不支持 tool use、streaming 或 modality 时返回稳定 agent error。
- complete tool runtime context：cwd/env/permission/audit/abort 都能传到 `ToolRuntime`。

完成标准：

- 所有 loop tests 使用 scripted model，不访问真实 API。
- 所有 tool tests 使用 existing `createPolitDeckToolRuntimeFixture()` 或 agent 专用 fixture。

### Phase 4: TurnRunner

实现：

- 输入 accepted。
- transcript accepted input write。
- 调用 AgentLoop。
- 事件转发和 final result 构造。
- usage / permission denials 汇总。

测试：

- accepted input 先写 transcript 再模型请求。
- transcript writer 抛错时不调用模型。
- permission denials 汇总到 turn result。
- model events 和 agent events 顺序稳定。

完成标准：

- `TurnRunner` 不知道 CLI/SDK/UI 格式。
- transcript writer 可以是 in-memory 或 jsonl 实现。

### Phase 5: AgentSession

实现：

- session state 管理。
- 多 turn submit。
- abort。
- snapshot。
- resume 接口骨架。

测试：

- 第二次 submit 能看到第一次 assistant 消息。
- abort 会传播到当前 turn。
- snapshot 不暴露可变引用。
- resume 未实现时明确返回 `agent_unsupported_feature`，不要静默成功。

完成标准：

- 一个 session 可以连续跑多个 scripted turn。
- session state 和 transcript state 不混为一个对象。

### Phase 6: Dual parity harness

新增：

```text
tests/fixtures/agent/dual-parity/
  contractScenarios.ts
  executionScenarios.ts

third-party/claude-code-main/src/
  politdeck-agent-legacy-contract-report.ts
  politdeck-agent-legacy-execution-report.ts
```

Contract parity 先覆盖：

- session submit result shape。
- event status 序列。
- max turns status。
- permission denial summary。
- orphan tool result repair status。

Execution parity 先覆盖：

- no-tool turn。
- one tool turn。
- tool error turn。
- permission denied tool turn。
- max turns。
- abort before model。
- model error after partial tool call。

完成标准：

- `compare` 场景共享同一个 fixture。
- legacy runner 和 PolitDeck runner 都输出 normalized JSON。
- root test 对 `compare` 场景 deepEqual。
- 所有非 `compare` 场景必须有 reason。

## 12. Parity Scenario 设计

### 11.1 Contract scenario

```ts
export type AgentContractScenario = {
  id: string;
  status: "compare" | "intentional_difference" | "deferred" | "not_applicable";
  feature: string;
  input: {
    maxTurns?: number;
    permissionMode?: string;
    scriptedModelEvents?: unknown[];
    scriptedToolDefinitions?: unknown[];
  };
  compareFields: Array<
    | "eventTypes"
    | "terminalStatus"
    | "stopReason"
    | "turnCount"
    | "permissionDenialCount"
    | "toolResultPairing"
  >;
  reason?: string;
};
```

### 11.2 Execution scenario

```ts
export type AgentExecutionScenario = {
  id: string;
  status: "compare" | "intentional_difference" | "deferred" | "not_applicable";
  input: {
    prompt: string;
    maxTurns?: number;
    abortAt?: "before_model" | "during_model" | "during_tools";
    modelScript: AgentModelScriptStep[];
    tools?: AgentToolScript[];
  };
  reason?: string;
};
```

Normalized report：

```ts
export type AgentExecutionReport = {
  id: string;
  status: AgentParityStatus;
  result?: {
    terminalStatus: "success" | "error" | "aborted" | "max_turns";
    stopReason: string;
    eventTypes: string[];
    messages: Array<{
      role: "user" | "assistant";
      contentTypes: string[];
      text?: string;
      toolCallIds?: string[];
      toolResultIds?: string[];
      isError?: boolean;
    }>;
    permissionDenials: Array<{
      toolName: string;
      toolCallId: string;
    }>;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  };
  reason?: string;
};
```

Normalization rules：

- UUID、timestamps、durations 不比较原始值。
- session id / turn id 比较是否存在和引用一致，不比较具体随机值。
- provider raw event 不比较。
- permission denial 比较 tool name、tool call id、数量和状态。
- tool result 比较 success/error、tool call id、文本内容、error code。
- 不允许把 success vs error、max turns vs completed、abort vs completed 归一化掉。

## 13. Intentional Differences

| ID | Legacy behavior | PolitDeck behavior | Reason | Risk |
| --- | --- | --- | --- | --- |
| `agent-canonical-message-protocol` | Agent loop 内部大量使用 Anthropic `BetaMessageParam` / legacy message variants | Agent 公共协议使用 `CanonicalMessage` / `CanonicalModelEvent` | provider-neutral 是 PolitDeck 架构要求 | same |
| `agent-event-naming` | 事件和 telemetry 使用 `tengu_*`、legacy SDK message 名称 | 事件和 audit 使用 `politdeck_*` 或 provider-neutral event type | 项目命名迁移要求 | lower |
| `agent-feature-flags` | 旧项目通过 `feature(...)` 分支编译/运行 | PolitDeck 使用 config/capability gate，不继承旧 flag 名称 | 避免复制旧构建系统耦合 | lower |
| `agent-remote-bridge-outside-core` | bridge/CCR/remote session 与 query runtime 有大量耦合 | agent core 只暴露 adapter 可消费事件；remote 在 adapter 层实现 | 保持 agent runtime 可测试 | lower |
| `agent-no-legacy-sdk-shape` | `QueryEngine.submitMessage()` 直接产出 legacy SDK messages | `AgentSession.submit()` 产出 `AgentEvent`，SDK adapter 再投影 | 解耦 SDK/API surface | same |

这些 intentional differences 必须进入 parity fixture 的 `intentional_difference` 场景，不允许把它们伪装成 compare。

## 14. Deferred Register

| ID | Deferred behavior | Phase | Gate before release |
| --- | --- | --- | --- |
| `agent-input-slash-command` | slash command 和 local command 输入处理 | Context/adapter phase | CLI adapter 需要前置实现 |
| `agent-attachments` | paste、IDE selection、MCP resource、file attachments | Context phase | 多模态和 IDE 场景需要前置实现 |
| `agent-context-budget` | tool result budget、snip、microcompact、autocompact、collapse | Context phase | 长会话 release gate |
| `agent-reactive-recovery` | prompt too long / media error reactive compact | Context phase | 大上下文模型调用 release gate |
| `agent-max-output-recovery` | output limit recovery retry | Model/agent recovery phase | 长输出任务 release gate |
| `agent-fallback-model` | fallback model retry and tombstone | Model selection phase | fallback 配置 release gate |
| `agent-streaming-tools` | streaming tool execution while model streams | Tool scheduler phase | 并发/长工具 release gate |
| `agent-progress` | tool/hook progress message channel | Tool/extension phase | UI 进度展示 release gate |
| `agent-hooks` | pre/post/stop hooks | Extension phase | plugin release gate |
| `agent-memory-skills-plugins` | memory prompt、skill discovery、plugin cache | Extension/context phase | advanced assistant release gate |
| `agent-subagent-fork` | AgentTool、forked agent、sidechain transcript | Agent fork phase | subagent release gate |
| `agent-worktree` | isolated worktree context | Adapter/tool/permission phase | background PR release gate |
| `agent-jsonl-resume` | 完整 transcript resume/replay | Session phase | persistent CLI/SDK release gate |

Deferred 不等于 intentional difference。实现前不得声称 execution parity 覆盖这些行为。

## 15. Test Plan

### 14.1 Unit tests

最小测试层：

- `protocol-events.test.ts`：事件 union、error code、result shape。
- `loop-tool-continuation.test.ts`：tool call 检测和继续规则。
- `loop-tool-result-pairing.test.ts`：synthetic error tool result。
- `loop-max-turns.test.ts`：turn count 和 max turns。
- `loop-abort.test.ts`：不同 abort 点。
- `turn-runner.test.ts`：accepted input transcript 先写。
- `session.test.ts`：多 turn state、snapshot、abort。

### 14.2 Scripted model tests

不要用真实 API。使用 `scriptedModel.ts`：

```ts
export type ScriptedModelStep =
  | { type: "events"; events: CanonicalModelEvent[] }
  | { type: "error"; error: CanonicalModelError };
```

每次 `stream()` 消耗一个 step，并记录收到的 request。这样可以断言：

- 第二次模型请求包含第一次 assistant + tool_result。
- 工具结果顺序稳定。
- max turns 时不会发起额外请求。
- abort 后不会继续调 model。

### 14.3 Scripted tool tests

复用 `src/tool` runtime fixture。agent tests 不应该 mock permission runtime 的最终行为，除非测试 agent 自己的 denial 汇总；常规路径应让 `ToolRuntime` 真正执行 validation、permission、result 映射。

### 14.4 Transcript tests

使用 `InMemoryTranscriptWriter` 记录调用顺序：

```text
recordAcceptedInput
  before model.stream
recordDurableMessage(assistant)
recordDurableMessage(tool_result)
recordTurnResult
```

关键测试：

- accepted input 写入失败时 model 不被调用。
- assistant message 可以异步写，但 ordering contract 必须保留。
- compact boundary 未实现时不能伪造 resume 成功。

### 14.5 Dual parity tests

参考当前 tool parity 模式：

- `tests/tool/parity-dual-contract.test.ts`
- `tests/tool/parity-dual-execution.test.ts`
- `tests/helpers/dualParityReport.ts`
- `tests/helpers/dualParityExecutionReport.ts`

Agent parity 要求：

- `contractScenarios.ts` 和 `executionScenarios.ts` 是唯一场景来源。
- legacy runner 读取相同场景，输出 normalized JSON。
- PolitDeck runner 读取相同场景，输出 normalized JSON。
- root test 比较所有 `compare` 场景。
- `intentional_difference`、`deferred`、`not_applicable` 必须带 reason。

可先建立有限 legacy probes，不要求编译整个 vendored tree。`third-party/claude-code-main` 不应被当作完整可发布源码，只做行为探针来源。

## 16. Validation Commands

常规验证：

```bash
npm run build
npm test
```

Agent parity probe：

```bash
bun run third-party/claude-code-main/src/politdeck-agent-legacy-contract-report.ts
bun run third-party/claude-code-main/src/politdeck-agent-legacy-execution-report.ts
```

如果 legacy probe 需要在 vendored cwd 下运行，沿用 tool parity 的方式：

```bash
bun run src/politdeck-agent-legacy-execution-report.ts
```

并在 root test 中设置 `cwd: path.join(root, "third-party/claude-code-main")`。

## 17. Release Gates

第一阶段 agent runtime 可以合入的最低门槛：

- `src/agent/protocol` 类型完整导出。
- `model` streaming 能给 agent 提供 provider-neutral assembled assistant message；Anthropic 和 OpenAI tool call 都有完整 id/name/input。
- 模型请求支持 turn abort signal，abort 不只停工具。
- `AgentLoop` 支持 no-tool、single-tool、multi-tool、tool-error、permission-denied、max-turns、abort。
- `AgentLoop` 构造的 `PolitDeckToolRuntimeContext` 包含 cwd、env、permission context、audit recorder、abort signal 和 stable now。
- `AgentSession.submit()` 支持多 turn state。
- accepted input transcript 写入顺序有测试。
- plan mode / structured output 若未实现，必须在 parity fixture 中标记 deferred 并说明 release gate。
- root `npm run build` 和 `npm test` 通过。
- dual contract parity harness 存在，且所有非 compare 场景有 reason。
- 至少以下 execution parity 场景为 `compare`：no-tool、one-tool、tool-error、permission-denied、max-turns。

不得合入的情况：

- agent 直接 import `third-party/claude-code-main`。
- agent 公共协议泄漏 Anthropic/OpenAI provider-specific raw type。
- tool call 可以没有对应 tool_result。
- permission denial 只记录在 tool runtime 中，但 turn result 丢失。
- agent state 的 permission mode 与传给 `ToolRuntime` 的 `PermissionContext.mode` 不一致。
- agent 假设 `createBuiltinRegistry()` 包含 plan、structured output、MCP 或 web 工具。
- agent 直接读取 provider raw stream 来拼工具参数，而没有 model 层或 accumulator 测试。
- max turns 只依赖 provider finish reason。
- transcript accepted input 写入在模型响应之后才发生。

## 18. 配套测试文档

配套测试维护文档：

```text
docs/politdeck-agent-test-maintenance-guide.md
```

该文档详细定义：

- agent unit test layers。
- agent dual parity scenario schema。
- intentional difference register。
- deferred release gates。
- contract parity passed 与 execution parity passed 的准确含义。

实现期间如果 agent 行为、deferred 范围或 parity fixture 发生变化，必须同步更新本开发文档和测试维护文档。
