# PolitDeck Agent 单测维护与行为一致性文档

本文用于维护 PolitDeck agent 重构相关单元测试、集成测试和 dual parity 测试。配套开发设计见：

- `docs/politdeck-agent-refactor-development-guide.md`

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
- `Execution parity passed`：legacy 和 PolitDeck 同时执行同一场景，归一化后的可观察输出 deepEqual。
- `Deferred`：legacy 行为已识别，但当前阶段不实现。
- `Intentional difference`：新行为有意不同，且记录 reason、risk 和 release review 要求。

禁止：

- 只跑 PolitDeck 单测就说 parity passed。
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
createPolitDeckAgentRuntimeFixture()
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

这些测试要使用 canonical types 和 `PolitDeckToolResult`，不能 import legacy message 类型。

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
- `PolitDeckToolResult` 是 error。
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
  politdeck-agent-legacy-contract-report.ts
  politdeck-agent-legacy-execution-report.ts

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
- 比较 legacy report 和 PolitDeck report 的 id/status 列表。
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

第一阶段建议最少维护以下场景：

| ID | Status | Purpose |
| --- | --- | --- |
| `agent-no-tool-turn` | `compare` | 单次模型回复，无工具 |
| `agent-single-tool-continuation` | `compare` | tool call -> tool_result -> follow-up model |
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
| `agent-canonical-message-protocol` | `intentional_difference` | PolitDeck 不暴露 legacy Anthropic message shape |
| `agent-telemetry-event-names` | `intentional_difference` | `tengu_*` 改为 `politdeck_*` |
| `agent-thinking-signature` | `deferred` | legacy thinking signature 保留规则尚未进入 canonical protocol |
| `agent-plan-mode-transition` | `deferred` | plan mode tools 已有骨架，但 session 状态切换需 adapter/approval |
| `agent-structured-output` | `deferred` | structured output tool 已有骨架，但 agent result 捕获需实现 |
| `agent-slash-command-input` | `deferred` | slash command 在 adapter/context 阶段 |
| `agent-context-compaction` | `deferred` | token budget/compact 后续 |
| `agent-subagent-fork` | `deferred` | forked agent 后续 |
| `agent-remote-bridge` | `not_applicable` | remote adapter 不进入 agent core |

每个 scenario 的 reason 必须足够具体，不能只写 “not implemented”。

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
  politdeckBehavior: string;
  reason: string;
  risk: "lower" | "same" | "higher";
  reviewRequiredBeforeRelease: boolean;
};
```

初始 register：

| ID | Legacy behavior | PolitDeck behavior | Risk | Review |
| --- | --- | --- | --- | --- |
| `agent-canonical-message-protocol` | legacy SDK / Anthropic message shape 可穿透到 QueryEngine 输出 | Agent core 输出 provider-neutral `AgentEvent` / `CanonicalMessage` | same | yes |
| `agent-telemetry-event-names` | `tengu_*` event names | `politdeck_*` event/audit names | lower | no |
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
};
```

初始 gates：

| ID | Behavior | Phase | Release gate |
| --- | --- | --- | --- |
| `agent-slash-command-input` | slash/local command input | adapter/context | CLI interactive release |
| `agent-attachments` | IDE selection、paste、file/MCP resources | context | multimodal/IDE release |
| `agent-context-compaction` | snip/microcompact/autocompact/collapse | context | long-session release |
| `agent-reactive-recovery` | prompt too long/media recovery | context/model | long-context release |
| `agent-output-token-recovery` | max output token retry | model/agent | long-output release |
| `agent-fallback-model` | model fallback and tombstone | model selection | fallback release |
| `agent-streaming-tools` | streaming tool execution | tool scheduler | long-running tools release |
| `agent-hooks` | pre/post/stop hooks | extension | plugin release |
| `agent-plan-mode-transition` | enter/exit plan mode updates session permission state | agent/adapter | plan mode release |
| `agent-structured-output` | structured output tool data becomes final turn result | agent/adapter | headless JSON output release |
| `agent-thinking-signature` | thinking block signature preservation | model/context | thinking parity release |
| `agent-subagent-fork` | forked/subagent loops | agent fork | subagent release |
| `agent-jsonl-resume` | full transcript resume/replay | session | persistent session release |

Deferred gate 关闭前需要：

- 有实现。
- 有 unit tests。
- 有 parity scenario 或 intentional difference reason。
- 文档同步更新。

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
bun run src/politdeck-agent-legacy-contract-report.ts
bun run src/politdeck-agent-legacy-execution-report.ts
```

Root parity tests 应自行设置 vendored cwd，类似：

```ts
execFileSync("bun", ["run", "src/politdeck-agent-legacy-execution-report.ts"], {
  cwd: path.join(root, "third-party/claude-code-main"),
  encoding: "utf8",
});
```

不要依赖整个 vendored project build。只写聚焦 legacy agent 行为的 probes。

## 18. Parity Passed Checklist

可以说 `contract parity passed` 的条件：

- 所有 contract scenarios 的 id 唯一。
- legacy report 和 PolitDeck report 的 id/status 列表一致。
- 所有 `compare` contract scenario 的 normalized values deepEqual。
- 所有非 `compare` contract scenario 有 reason。

可以说 `execution parity passed` 的条件：

- 所有 execution scenarios 的 id 唯一。
- legacy report 和 PolitDeck report 的 id/status 列表一致。
- 所有 `compare` execution scenario 真实运行 legacy 和 PolitDeck loop。
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
- max turns 只测试了 PolitDeck。
- deferred 场景被跳过但没有 reason。
- intentional difference 没有 risk 和 review 标记。

## 19. Maintenance Rules

每次 agent 实现变化后必须检查：

- `docs/politdeck-agent-refactor-development-guide.md` 是否仍准确。
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
