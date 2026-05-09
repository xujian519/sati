# PilotDeck Agent 单测维护与行为一致性文档

本文用于维护 PilotDeck agent 重构相关单元测试、集成测试和 dual parity 测试。配套开发设计见：

- `docs/pilotdeck-agent-refactor-development-guide.md`

Agent 测试的目标不是证明新代码“看起来像”旧项目，而是证明以下外部可观察行为被稳定保留：

- 一个 session 能承载多个 turn。
- 每个 turn 能以 async event stream 形式输出状态。
- 模型流中的 tool call 能被识别、执行、回填，并触发下一次模型请求。
- 每个 tool call 都有同 ID 的 tool result。
- 权限拒绝、工具错误、模型错误、abort、max turns 都会得到稳定 result。
- 用户输入一旦 accepted，进入模型请求前就写入 transcript。
- Deferred 和 intentional difference 不会被误报为 parity passed。

## 1. Parity 术语

本文使用以下定义：

- `Contract parity passed`：metadata、事件序列、状态、错误码、schema 或 result shape 等契约层字段匹配。
- `Execution parity passed`：legacy 和 PilotDeck 同时执行同一场景，归一化后的可观察输出 deepEqual。
- `Deferred`：legacy 行为已识别，但当前阶段不实现。
- `Intentional difference`：新行为有意不同，且记录 reason、risk 和 release review 要求。

禁止：

- 只跑 PilotDeck 单测就说 parity passed。
- 只比较 contract fields 就说 execution parity passed。
- 把 provider raw object、随机 UUID、timestamp 归一化后顺带掩盖 success/error 差异。
- 把 deferred 行为写成 intentional difference。

## 2. 测试分层

Agent 测试分为八层：

```text
protocol tests
  -> loop helper tests
  -> agent loop tests
  -> turn runner tests
  -> session tests
  -> transcript tests
  -> contract parity tests
  -> execution parity tests
```

每层职责必须清晰。底层测试不应启动完整 session；上层 parity 测试不应绕过共享 fixture。

## 3. 测试命名规则

推荐路径：

```text
tests/agent/
  protocol-events.test.ts
  protocol-result.test.ts
  loop-helpers.test.ts
  loop-tool-continuation.test.ts
  loop-tool-result-pairing.test.ts
  loop-abort.test.ts
  loop-max-turns.test.ts
  turn-runner.test.ts
  session.test.ts
  transcript.test.ts
  parity-dual-contract.test.ts
  parity-dual-execution.test.ts

tests/fixtures/agent/
  dual-parity/
    contractScenarios.ts
    executionScenarios.ts
  scripted/
    modelScripts.ts
    toolScripts.ts

tests/helpers/
  agent.ts
  dualAgentContractReport.ts
  dualAgentExecutionReport.ts
```

推荐 helper：

```ts
createPilotDeckAgentRuntimeFixture()
createScriptedModelRuntime()
createScriptedAgentTool()
createInMemoryTranscriptWriter()
collectAgentEvents()
assertToolResultPairing()
normalizeAgentExecutionReport()
```

旧项目名称只允许出现在：

- legacy source 路径。
- legacy report 文件名。
- 旧行为说明文本。

新类型、事件和 helper 不得使用旧项目前缀。

## 4. Protocol Tests

Protocol tests 验证纯结构，不调用 model/tool/session runtime。

必须覆盖：

- `AgentEvent` union 的必要字段。
- `AgentTurnResult` 的 terminal status 和 stop reason。
- `AgentError` code、message、details。
- `AgentInput` 到 canonical user message 的最小映射。
- `AgentPermissionDenial` 只保存可报告字段，不保存 UI 状态。

建议断言：

```ts
assert.equal(event.type, "turn_started");
assert.equal(result.stopReason, "completed");
assert.equal(error.code, "agent_max_turns_reached");
```

Protocol tests 不比较 legacy 行为，不计入 parity passed。

## 5. Loop Helper Tests

Loop helper tests 验证纯函数：

- `collectToolCalls()`
- `projectToolResults()`
- `ensureToolResultPairing()`
- `decideLoopContinuation()`

必须覆盖：

| Case | Expected |
| --- | --- |
| assistant message 没有 tool call | 不继续 |
| assistant message 有一个 tool call | 继续 |
| assistant message 有多个 tool call | 继续，顺序稳定 |
| finish reason 是 `stop` 但 content 有 tool call | 继续 |
| finish reason 是 `tool_call` 但 content 没有 tool call | 不继续或返回 invalid state |
| tool call 缺 result | synthetic error tool result |
| error tool result | canonical block `isError: true` |
| 多 result projection | user message content 顺序匹配 call 顺序 |

这些测试要使用 canonical types 和 `PilotDeckToolResult`，不能 import legacy message 类型。

## 6. Agent Loop Tests

Agent loop tests 使用 scripted model 和真实 `ToolScheduler` / `ToolRuntime` fixture。

### 6.0 Model accumulator and abort plumbing

Agent loop tests 之前必须先有 model accumulator tests，因为当前 `model` 层已经是 agent 的 canonical 输入来源。测试要覆盖：

- OpenAI stream：`message_start`、text delta、tool call deltas、`tool_call_end`、`message_end` 能组装为完整 assistant message。
- Anthropic stream：`tool_use` start、input JSON delta、block stop / message delta 能组装为完整 `CanonicalToolCall`。当前源码还没有完整 `tool_call_end`，实现 agent 前必须补齐或由 accumulator 兜底。
- usage event 可以累加到 assembled message 或 loop state。
- provider finish reason 不作为唯一 tool continuation 依据。
- external abort signal 可以取消模型 stream；如果 `streamModel()` 尚未支持 signal，该测试必须先失败并推动 model 层修复。
- invalid streamed tool JSON 归一化为 model error，不能让 agent 执行半截 tool input。

这些测试属于 agent 前置集成测试。没有它们，不应开始写 `AgentLoop.run()`。

### 6.1 No-tool turn

脚本：

```text
model request 1
  -> assistant text
  -> message_end stop
```

断言：

- 只发起一次模型请求。
- 没有 tool execution。
- 产出 `turn_completed`。
- final message 是 assistant。
- stop reason 是 `completed`。

### 6.2 Single-tool continuation

脚本：

```text
model request 1
  -> assistant tool_call call-1 read_file
  -> message_end tool_call
tool read_file
  -> success tool_result call-1
model request 2
  -> assistant text
  -> message_end stop
```

断言：

- 第二次模型请求包含 assistant tool_call 和 user tool_result。
- tool result id 等于 `call-1`。
- event sequence 包含 `tool_calls_detected`、`tool_result`、`tool_results_projected`、`turn_continued`。
- final result success。

### 6.3 Multi-tool continuation

断言：

- 多个 tool call 都执行。
- result projection 的顺序与 assistant content 中的 tool call 顺序一致。
- 任一 tool error 不会使 agent loop 崩溃；错误以 tool_result 回填。

### 6.4 Permission denied

使用真实 `PermissionRuntime` 或 fixture tool 的 `checkPermissions()` 返回 deny。

断言：

- tool 不执行实际副作用。
- `PilotDeckToolResult` 是 error。
- canonical tool result block `isError: true`。
- turn result `permissionDenials.length` 增加。
- loop 继续让模型看到拒绝结果。

### 6.5 Model error

场景分两类：

- 模型请求前/请求中直接 error，且没有 tool call：turn failed，stop reason `model_error`。
- 模型已经产出 assistant tool_call 后 error：必须 synthetic tool_result 配对，再以 `model_error` 或 recovery decision 结束。

不能留下 orphan tool call。

### 6.6 Max turns

`maxTurns` 测试必须明确 turn count 规则：

- 第一次 model request 是 turn count 1。
- 每次完成一批 tool results 并准备继续时，下一次 model request 前递增。
- 如果 next turn count 超过 `maxTurns`，不再发起下一次 model request。

断言：

- terminal status 是 `max_turns`。
- stop reason 是 `max_turns`。
- 不多发模型请求。
- 如已有 tool call，已完成的 tool_result 不丢失。

### 6.7 Abort

必须覆盖三个 abort 点：

| Abort point | Expected |
| --- | --- |
| before model | 不调用 model，返回 `aborted` |
| during model | 停止 stream，补齐 synthetic tool_result，返回 `aborted_streaming` |
| during tools | scheduler 收到 signal，返回 `aborted_tools` |

Abort tests 不要求匹配 legacy 文案，但必须匹配消息链结构和 terminal status。

### 6.8 Tool runtime context integration

Agent 必须把已重构的 `ToolRuntime` 当成真实依赖测试，而不是 mock 掉。

必须断言传入 tool runtime context 的字段：

- `sessionId` 等于当前 session。
- `turnId` 等于当前 turn。
- `cwd` 等于 session/runtime cwd。
- `env` 能传给 bash runner。
- `abortSignal` 能传给 bash/tool execution。
- `permissionMode` 等于 `permissionContext.mode`。
- `auditRecorder` 能收到 permission 和 tool audit。
- `now()` 能让 started/completed 时间稳定。

还要覆盖：

- `ToolRegistry.toCanonicalSchemas()` 暴露 canonical snake_case name。
- alias tool call（如 `Read`）能被 registry lookup，但是否允许模型生成 alias 必须由 parity scenario 固定。
- `createBuiltinRegistry()` 只包含 read/glob/grep/edit/write/bash；plan、structured output、web、MCP、ask user 必须显式注册。

### 6.9 Plan mode and structured output skeleton

如果第一阶段注册 `enter_plan_mode` / `exit_plan_mode`：

- tool result 的 `data.requestedMode` 必须被 agent 或 adapter 明确消费。
- session permission mode 是否切换必须有测试。
- `exit_plan_mode` 的 `requiresUserInteraction()` 在 headless 下必须产生 request/deferred/error，不能静默成功。

如果第一阶段注册 `structured_output`：

- tool result `metadata.structuredOutput === true` 必须被捕获。
- `AgentTurnResult` 或 adapter result 必须包含 structured data。
- structured output 后是否继续模型请求必须有 scenario。

如果不支持这些行为，必须在 parity fixture 标记 `deferred`。

## 7. Turn Runner Tests

Turn runner 负责连接 input、transcript、loop、result。

必须覆盖：

- accepted input 先写 transcript，再调用 model。
- transcript accepted input 写失败时不调用 model。
- `shouldCallModel: false` 的 deferred path 返回 `agent_unsupported_feature` 或本地 result，不能假装模型成功。
- loop 产出的 durable assistant / tool_result message 会写 transcript。
- permission denials 汇总到 turn result。
- usage 从 loop result 汇总到 turn result。

推荐用 `InMemoryTranscriptWriter` 记录顺序：

```text
recordAcceptedInput
model.stream
recordDurableMessage(assistant)
recordDurableMessage(tool_result)
recordTurnResult
```

## 8. Session Tests

Session tests 验证跨 turn 行为。

必须覆盖：

- 多次 `submit()` 共享 session id。
- 第二次 submit 的 model request 包含第一次 turn 的 durable messages。
- `snapshot()` 返回不可变快照。
- `abort()` 传播到当前 turn。
- abort 后 session status 正确恢复为 `aborted` 或 `idle`，具体策略必须在 contract 中固定。
- `resume()` 未实现时返回明确 unsupported，不得静默创建空 session。

第一阶段不要求 JSONL resume passed；该能力是 deferred。

## 9. Transcript Tests

Transcript tests 分两层：

### 9.1 In-memory contract

验证 writer 调用顺序、写入内容分类和错误传播。

### 9.2 JSONL persistence skeleton

如果实现 `JsonlTranscriptWriter`，必须覆盖：

- user accepted input 写入。
- assistant durable message 写入。
- tool_result durable message 写入。
- turn result metadata 写入。
- progress/model_event 默认不进入 durable message chain。
- 文件写入错误返回 `agent_transcript_error`。

Resume 完整行为在第一阶段 deferred。任何 resume 测试只能断言 unsupported 或 skeleton metadata，不得称为 execution parity。

## 10. Dual Parity Harness

Agent dual parity 文件结构：

```text
tests/fixtures/agent/dual-parity/
  contractScenarios.ts
  executionScenarios.ts

third-party/claude-code-main/src/
  pilotdeck-agent-legacy-contract-report.ts
  pilotdeck-agent-legacy-execution-report.ts

tests/helpers/
  dualAgentContractReport.ts
  dualAgentExecutionReport.ts

tests/agent/
  parity-dual-contract.test.ts
  parity-dual-execution.test.ts
```

Root parity tests 必须：

- 确保 scenario id 唯一。
- 确保每个非 `compare` scenario 有 reason。
- 比较 legacy report 和 PilotDeck report 的 id/status 列表。
- 对 `compare` scenario deepEqual normalized values。
- 输出失败 scenario id，便于定位。

## 11. Contract Scenario Schema

```ts
export type AgentParityStatus =
  | "compare"
  | "intentional_difference"
  | "deferred"
  | "not_applicable";

export type AgentContractScenario = {
  id: string;
  status: AgentParityStatus;
  feature: string;
  input: {
    prompt?: string;
    maxTurns?: number;
    permissionMode?: string;
    modelScriptName?: string;
    toolScriptName?: string;
  };
  compareFields: Array<
    | "eventTypes"
    | "terminalStatus"
    | "stopReason"
    | "turnCount"
    | "modelRequestCount"
    | "toolCallCount"
    | "toolResultPairing"
    | "permissionDenialCount"
  >;
  reason?: string;
};

export type AgentContractReport = {
  id: string;
  status: AgentParityStatus;
  values?: Record<string, unknown>;
  reason?: string;
};
```

Contract scenarios 适合比较：

- 事件类型序列。
- terminal status。
- stop reason。
- model request count。
- max turns 计数。
- tool call/result 配对状态。
- permission denial 数量。

Contract parity 不能证明具体工具输出文本一致，也不能证明 transcript JSONL 完整 resume 行为一致。

## 12. Execution Scenario Schema

```ts
export type AgentExecutionScenario = {
  id: string;
  status: AgentParityStatus;
  input: {
    prompt: string;
    maxTurns?: number;
    permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";
    modelScript: AgentModelScriptStep[];
    tools?: AgentToolScript[];
    abortAt?: "before_model" | "during_model" | "during_tools";
  };
  reason?: string;
};

export type AgentExecutionReport = {
  id: string;
  status: AgentParityStatus;
  result?: {
    terminalStatus: "success" | "error" | "aborted" | "max_turns";
    stopReason: string;
    eventTypes: string[];
    modelRequestCount: number;
    toolExecutions: Array<{
      toolName: string;
      toolCallId: string;
      status: "success" | "error";
      errorCode?: string;
    }>;
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

Execution scenarios 必须真实跑 loop。不能直接调用 helper 后手动拼 result。

## 13. 第一批 Parity Scenarios

> 2026-05-08：表已与 §16 Deferred Gates 同步。`compare` 行表示 PilotDeck 实现与 legacy 行为 1:1 锁定；`deferred` 行表示 legacy 已识别但 PilotDeck 还没实装；`intentional_difference` 行必须在 §15 register 有对应条目；`not_applicable` 行不进入 parity gate。

### 13.1 已稳定（compare）—— 主路径

| ID | Status | Purpose |
| --- | --- | --- |
| `agent-no-tool-turn` | `compare` | 单次模型回复，无工具 |
| `agent-single-tool-continuation` | `compare` | tool call → tool_result → follow-up model |
| `agent-multiple-tool-continuation` | `compare` | 多 tool call 顺序和配对 |
| `agent-tool-error-result` | `compare` | 工具执行错误以 tool_result 回填 |
| `agent-permission-denied-result` | `compare` | permission deny 汇总和 error tool_result |
| `agent-max-turns-after-tool` | `compare` | tool 后达到 max turns，不继续请求 |
| `agent-abort-before-model` | `compare` | abort before model |
| `agent-model-error-after-tool-call` | `compare` | partial tool call 后模型错误，补齐 synthetic result |
| `agent-openai-stream-tool-assembly` | `compare` | OpenAI streaming tool call 组装完整 id/name/input |
| `agent-anthropic-stream-tool-assembly` | `compare` | Anthropic streaming tool call 组装完整 id/name/input |
| `agent-model-abort-signal` | `compare` | turn abort signal 能取消模型请求 |
| `agent-tool-runtime-context` | `compare` | session/turn/cwd/env/permission/audit/abort 透传给 ToolRuntime |
| `agent-tool-schema-canonical-names` | `compare` | 模型 schema 暴露 canonical tool name，alias lookup 行为明确 |
| `agent-plan-mode-transition` | `compare` | agent 已消费 requestedMode 并同步 permission state |
| `agent-structured-output` | `compare` | agent 已捕获 structured output 到 turn result |

### 13.2 已稳定（compare）—— 升级自 deferred

| ID | Status | Purpose |
| --- | --- | --- |
| `agent-thinking-signature` | `compare` | `CanonicalThinkingBlock.signature` round-trip：Anthropic `signature_delta` + assembler 合入；OpenRouter `delta.reasoning` → `thinking_delta`。Phase 1.5 已实装 |
| `agent-slash-command-input` | `compare` | `InputProcessor` 三层 dispatch：unknown command 透传 + warning，已注册 plugin command 变成 `Run plugin command "/foo" with argument: ...` user message。context Phase 4 已实装 |
| `agent-context-advanced-compaction` | `compare` | `CompactionEngine` summarize → boundary marker → keep tail；`AutoCompactionPolicy` 80%/95% 阈值；`MicroCompactionEngine` time-based 重写。context Phase 5 已实装；snip / cached microcompact 仍 deferred 列 §15 register |

### 13.3 已稳定（compare）—— 新增 scenario（已实装但漏记）

| ID | Status | Purpose |
| --- | --- | --- |
| `agent-tool-result-budget` | `compare` | oversize tool result（> `maxResultBytes`）→ `tool_result_reference` 块 + 持久化到 `{toolResultsDir}/{toolCallId}.{json|txt}`；reload 不重写（write-exclusive 标志）。context Phase 3 实装 |
| `agent-memory-injection` | `compare` | `DefaultContextRuntime.prepareForModel` 调 `MemoryAttachmentBuilder.build` → `<memory-context>` 段并入 `systemPromptParts`；retrieve 失败 → `memory_provider_error` diagnostic 不抛。context Phase 6 实装 |
| `agent-extension-prompt-section` | `compare` | `PromptAssembler` 消费 `ExtensionResolver.listCommands/listSkills` 输出，写入 `<available-commands>` / `<available-skills>` 段；空 list → 整段省略。Phase 6 实装 |
| `agent-attachments-resolver` | `compare` | `AttachmentResolver` 三种 mime 路径：text 文件按 utf-8 嵌入 `<attachment>` XML、image base64 包成 canonical image block、PDF 按 100 KB / 页估算包成 canonical pdf block。context Phase 4 实装；poppler / sharp 仍 deferred |
| `agent-input-processor-blocks` | `compare` | `InputProcessor.process({ type: "blocks", content })` 把已组装的 canonical blocks 转 user message 不重新解析 slash 前缀。context Phase 4 实装 |
| `agent-hooks-lifecycle` | `compare` | 一次完整 hooked turn：`SessionStart → UserPromptSubmit → PreToolUse → PermissionRequest → PostToolUse → Stop → SessionEnd`，hook output 注入 prompt context / 改写 tool input / 决策 permission。lifecycle 模块 e2e 已通过 |
| `agent-router-fallback-retry` | `compare` | retryable 错误由 `RouterRuntime` 根据 `router.fallback` 选择后续模型；agent 不再持有 `fallbackProvider/fallbackModel` 或 `AgentRecoveryPolicy`。二次失败与不可 retry 错误按 router/agent 错误分类失败。覆盖应落在 `tests/router/fallback.test.ts` 与 agent loop 集成场景 |

### 13.4 已稳定（compare）—— 升级自 deferred（2026-05-08 §16.1 完成后）

| ID | Status | Purpose |
| --- | --- | --- |
| `agent-reactive-recovery-truncate-and-retry` | `compare` | `AgentLoop` 收 PTL → `contextRuntime.recoverFromModelError` → `truncate_head_and_retry` 按 keepRatio 截尾、`stripTrailingErrorPair` 清半成品 assistant、retry；single-shot per turn，二次 PTL 由 loop 分类为 `prompt_too_long` 失败。覆盖于 `tests/agent/loop-reactive-recovery.test.ts` |
| `agent-output-token-recovery` | `compare` | `AgentLoop` 收 `max_output_reached` → bump `maxOutputTokens` ×2（cap 64k，default 4k）retry；二次 fail。覆盖于 `tests/agent/loop-output-token-recovery.test.ts` |
| `agent-streaming-tools-bash-progress` | `compare` | bash 流式 progress：`PilotDeckCommandRunner` `onStdout` / `onStderr` callback → `bash` 工具构造 `tool_progress` 事件 → `ToolRuntime` wrap 注入 `toolCallId` / `toolName`；sink 错误被 try/catch 吃掉。覆盖于 `tests/tool/builtin-bash-progress.test.ts` |
| `agent-subagent-fork` | `intentional_difference` | PilotDeck `agent` 是 P0 单次同步模型调用 + 4 个内建 preset；legacy `Agent` 是完整 fork loop（async / worktree / swarm / coordinator）。完整 parity 列 `agent-subagent-fork-full` deferred gate |

### 13.5 Deferred / Intentional difference / Not applicable

| ID | Status | Purpose |
| --- | --- | --- |
| `agent-canonical-message-protocol` | `intentional_difference` | PilotDeck 不暴露 legacy Anthropic message shape；reason 见 §15 register |
| `agent-telemetry-event-names` | `intentional_difference` | `tengu_*` 改为 `pilotdeck_*`；reason 见 §15 register |
| `agent-subagent-fork-full` | `deferred` | subagent 自己跑工具循环（独立 AgentLoop instance / 独立 permission / 独立 lifecycle）；与 `web_fetch` 完整版共享 fork loop 基础设施 |
| `agent-tool-progress-events` | `deferred` | tool progress sink 已接通 ToolRuntime，AgentLoop 端尚未把 `tool_progress` 抬升为 `AgentEvent`（事件 surface 升级独立做） |
| `agent-remote-bridge` | `not_applicable` | remote adapter 不进入 agent core |

每个 scenario 的 reason 必须足够具体，不能只写 "not implemented"。`deferred` 行进入实装前必须先有这条 scenario 与对应 §16 gate；scenario 状态从 `deferred` 转 `compare` 必须同步 `tests/fixtures/agent/dual-parity/contractScenarios.ts` 与 `executionScenarios.ts`。

## 14. Normalization Rules

必须归一化：

- UUID。
- timestamp。
- duration。
- temp path。
- raw provider object。
- stack trace。
- event 中的随机 request metadata。

必须保留：

- terminal status。
- stop reason。
- success vs error。
- error code。
- model request count。
- model abort stage and error classification。
- tool call id 和 tool result id 的对应关系。
- tool call name/input after streaming assembly。
- message role 和 content type。
- permission denial 数量和 tool name。
- `PermissionContext.mode` 与 agent permission mode 的一致性。
- max turns 的 turn count。
- abort 阶段。

特别规则：

- 可以把具体 UUID 映射为 `id-1`、`id-2`，但同一 report 内引用关系必须保持。
- 可以省略 raw model event，但不能省略由 raw event 归一化出的 tool call。
- 可以截断长文本，但不能把 error text 截成与 success text 相同。
- usage 可以只比较 normalized totals；如果 legacy 无法稳定产出 usage，则 scenario 应只比较 usage 字段存在性或标记 reason。

## 15. Intentional Difference Register

```ts
export type AgentIntentionalDifference = {
  id: string;
  legacyBehavior: string;
  pilotdeckBehavior: string;
  reason: string;
  risk: "lower" | "same" | "higher";
  reviewRequiredBeforeRelease: boolean;
};
```

初始 register：

| ID | Legacy behavior | PilotDeck behavior | Risk | Review |
| --- | --- | --- | --- | --- |
| `agent-canonical-message-protocol` | legacy SDK / Anthropic message shape 可穿透到 QueryEngine 输出 | Agent core 输出 provider-neutral `AgentEvent` / `CanonicalMessage` | same | yes |
| `agent-telemetry-event-names` | `tengu_*` event names | `pilotdeck_*` event/audit names | lower | no |
| `agent-feature-gates` | `feature(...)` scattered through loop | config/capability gate at dependency boundary | lower | no |
| `agent-remote-outside-core` | remote/bridge/CCR 分支进入 loop | remote 只通过 adapter 消费 agent events | lower | yes |
| `agent-no-progress-in-durable-chain` | legacy 需要兼容旧 progress transcript 链 | first phase durable chain excludes progress by default | same | yes |

`higher` risk 必须 review。任何安全边界变弱都必须 review。

## 16. Deferred Gates

```ts
export type AgentDeferredGate = {
  id: string;
  behavior: string;
  phase: string;
  releaseGate: string;
  status: "resolved" | "in_progress" | "open";
  resolution?: string;     // resolved 时填写实装位置
};
```

Gates（2026-05-08 同步）：

| ID | Behavior | Phase | Release gate | Status | Resolution |
| --- | --- | --- | --- | --- | --- | --- |
| `agent-slash-command-input` | slash/local command input | adapter/context | CLI interactive release | ✅ resolved | `src/context/input/InputProcessor.ts`（context Phase 4 三层 dispatch：adapter parser → `extension.commands` 来源 → InputProcessor 投影） |
| `agent-attachments` | IDE selection / paste / file resources | context | multimodal/IDE release | ✅ resolved | `src/context/attachments/AttachmentResolver.ts`（context Phase 4：text + base64 image + PDF size 估算，pdfinfo / sharp 仍 deferred） |
| `agent-context-advanced-compaction` | snip / microcompact / autocompact / collapse | context | long-session release | ✅ resolved | `src/context/compaction/{CompactionEngine,AutoCompactionPolicy,MicroCompactionEngine}.ts`（context Phase 5；snip / cached microcompact 仍 deferred 列 §15 register） |
| `agent-reactive-recovery` | prompt too long / media recovery | context/model | long-context release | ✅ resolved | `AgentLoop.tryReactiveRecover()` 调 `contextRuntime.recoverFromModelError`，`truncate_head_and_retry` 决策按 `keepRatio` 截尾 + `stripTrailingErrorPair` 清理半成品 assistant。Single-shot per turn (`hasAttemptedCompact`)；二次 PTL 由 loop 分类并失败。`AgentContextRuntime.recoverFromModelError` 已升级为可选方法兼容旧 fixture。 |
| `agent-output-token-recovery` | max output token retry | model/agent | long-output release | ✅ resolved | `AgentLoop` 检测 `max_output_reached` → bump `maxOutputTokens` ×2（cap `OUTPUT_TOKEN_RETRY_CEILING=64_000`，default `4_096`），`stripTrailingErrorPair` 后单次 retry；二次失败落 fallback / fail。 |
| `agent-router-fallback` | model fallback and tombstone | router model selection | fallback release | ✅ resolved | fallback 已迁移到 `src/router/`：`RouterRuntime` 使用 `router.fallback` 管理 scenario fallback 链，`AgentRuntimeConfig` 不再包含 `fallbackProvider` / `fallbackModel`。tombstone 仍未做（不阻塞主线，列 §15 register）。 |
| `agent-streaming-tools` | streaming tool execution | tool scheduler | long-running tools release | ✅ resolved | `PilotDeckToolProgressSink` 类型 + `PilotDeckToolRuntimeContext.progress` field 已接入；`PilotDeckCommandRunner` 加 `onStdout` / `onStderr` callback；`bash` 工具按 chunk 发 progress；`ToolRuntime.execute` wrap progress sink 自动注入 `toolCallId` / `toolName`。Sink 错误被 try/catch 吃掉不破坏执行。AgentLoop 端 emit `AgentEvent.tool_progress` 留下一轮（事件 surface 未上线）。 |
| `agent-hooks` | pre / post / stop hooks | extension | plugin release | ✅ resolved | `src/lifecycle/` + `src/extension/hooks/`（PreToolUse / PostToolUse / PostToolUseFailure / PermissionRequest / PermissionDenied / SessionStart / SessionEnd / Stop / UserPromptSubmit / PreCompact / PostCompact），ToolRuntime 已接入 `dispatchLifecycle()`。 |
| `agent-thinking-signature` | thinking block signature preservation | model/context | thinking parity release | ✅ resolved | `CanonicalThinkingBlock.signature` + `src/model/providers/anthropic/stream.ts` 处理 `signature_delta` + `assembleModelMessage` 合入；OpenRouter `delta.reasoning` 也走 `thinking_delta` 通道。 |
| `agent-subagent-fork` | forked / subagent loops | agent fork | subagent release | 🟡 in_progress | **P0 最小版已实装**：`src/tool/builtin/agent.ts` `createAgentTool()` + 4 个内建 preset (`general_purpose` / `plan` / `verify` / `explore`)，单次同步模型调用，输入 `{ description, prompt, subagentType? }`。架构口子：`PilotDeckToolRuntimeContext.model?: PilotDeckToolModelClient` + `AgentLoop.createToolContext` 注入 `dependencies.model`。**完整 fork**（subagent 自己开 AgentLoop 跑工具循环）列单独 deferred gate `agent-subagent-fork-full`，与 `web_fetch` 完整版同期。 |
| `agent-subagent-fork-full` | subagent runs its own tool loop (legacy parity) | agent fork | full-fork release | 🟠 open | 需要在 `agent` 工具内 spawn 一个隔离的 `AgentLoop` instance（独立 sessionId / permissionContext / tool registry subset / lifecycle dispatcher），递归 turn 直到 stop reason；`web_fetch` 完整版会复用同一基础设施。 |
| `agent-jsonl-resume` | full transcript resume / replay | session | persistent session release | ✅ resolved | `src/session/transcript/{JsonlTranscriptWriter,TranscriptReader,TranscriptReplay}.ts` + `src/session/storage/{ProjectSessionStorage,SessionLiteReader,SessionList}.ts`；compact_boundary 切片回放已支持。 |

Deferred gate 关闭前需要：

- 有实现。
- 有 unit tests。
- 有 parity scenario 或 intentional difference reason。
- 文档同步更新。

### 16.1 已完成 tasks（2026-05-08）

按 §16 表对应顺序：

1. ✅ **`agent-reactive-recovery` 接通**：`AgentLoop.tryReactiveRecover` + 单 turn 单次截尾 + `stripTrailingErrorPair` 清理半成品 assistant。`AgentContextRuntime.recoverFromModelError` 升级为可选方法兼容 `NullContextRuntime`。单测：`tests/agent/loop-reactive-recovery.test.ts`（5 个用例）。
2. ✅ **`agent-output-token-recovery` 实装**：`max_output_reached` → 单次 retry，bump `maxOutputTokens` ×2（cap 64k，default 4k）。单测：`tests/agent/loop-output-token-recovery.test.ts`（4 个用例）。
3. ✅ **`agent-streaming-tools` 实装**：`PilotDeckToolProgressSink` + `PilotDeckToolRuntimeContext.progress` + `PilotDeckCommandRunner.onStdout/onStderr` callback + bash 流式 progress + ToolRuntime wrap toolCallId 注入。单测：`tests/tool/builtin-bash-progress.test.ts`（4 个用例）。
4. ✅ **`agent-subagent-fork` P0 最小版**：`createAgentTool()` + 4 个内建 preset + `PilotDeckToolModelClient` 接口 + `PilotDeckToolRuntimeContext.model` field + `AgentLoop.createToolContext` 注入 `dependencies.model` + `createBuiltinRegistry({ agent })` opt-in。单测：`tests/tool/builtin-agent.test.ts`（9 个用例）。完整 fork（subagent 自己跑工具循环）拆出新 gate `agent-subagent-fork-full`。

回归：286 测试 / 282 pass / 4 skipped (real-API e2e) / 0 fail。

## 17. Validation Commands

常规：

```bash
npm run build
npm test
```

Agent focused tests：

```bash
npm test -- tests/agent
```

Legacy probe：

```bash
bun run src/pilotdeck-agent-legacy-contract-report.ts
bun run src/pilotdeck-agent-legacy-execution-report.ts
```

Root parity tests 应自行设置 vendored cwd，类似：

```ts
execFileSync("bun", ["run", "src/pilotdeck-agent-legacy-execution-report.ts"], {
  cwd: path.join(root, "third-party/claude-code-main"),
  encoding: "utf8",
});
```

不要依赖整个 vendored project build。只写聚焦 legacy agent 行为的 probes。

## 18. Parity Passed Checklist

可以说 `contract parity passed` 的条件：

- 所有 contract scenarios 的 id 唯一。
- legacy report 和 PilotDeck report 的 id/status 列表一致。
- 所有 `compare` contract scenario 的 normalized values deepEqual。
- 所有非 `compare` contract scenario 有 reason。

可以说 `execution parity passed` 的条件：

- 所有 execution scenarios 的 id 唯一。
- legacy report 和 PilotDeck report 的 id/status 列表一致。
- 所有 `compare` execution scenario 真实运行 legacy 和 PilotDeck loop。
- 所有 `compare` execution scenario 的 normalized result deepEqual。
- 所有非 `compare` execution scenario 有 reason。
- normalization 没有移除 success/error、stop reason、tool result pairing、permission denial、max turns、abort stage 等真实行为差异。

不能说 parity passed 的情况：

- legacy probe 没跑。
- model streaming accumulator 没有覆盖 Anthropic 和 OpenAI tool call assembly。
- `streamModel()` 或 agent model wrapper 不能接收 turn abort signal。
- 只比较了 event type，没有比较 terminal status。
- tool result id 没比较。
- tool input 没比较。
- tool runtime context 没比较 permission mode / cwd / abort / audit。
- max turns 只测试了 PilotDeck。
- deferred 场景被跳过但没有 reason。
- intentional difference 没有 risk 和 review 标记。

## 19. Maintenance Rules

每次 agent 实现变化后必须检查：

- `docs/pilotdeck-agent-refactor-development-guide.md` 是否仍准确。
- 本文件的 deferred gates 是否有状态变化。
- parity fixture 是否需要新增 scenario。
- normalization 是否过宽。
- existing `tests/model/`、`tests/tool/`、`tests/permission/` 是否仍覆盖 agent 依赖契约。

如果实现改变 agent 行为：

- 先更新 scenario status 或 expected normalized result。
- 再更新 unit tests。
- 最后更新文档。

如果发现 legacy 行为之前漏记：

- 先新增 scenario，状态可以先是 `deferred`。
- 写清 legacy entrypoint 和 reason。
- 不要只在 prose 里补一句说明。
