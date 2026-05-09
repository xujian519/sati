# PolitDeck Wiring Gaps（截止 2026-05-09）

每条 feature 都有完整 implementation + 单元测试，但 **生产入口
`createLocalGateway()` / `AgentLoop.createToolContext()` 没把它们焊接起来**，
所以主链路没工作。Wiring contract test 在 `tests/wiring/feature-wiring.test.ts`，
fail 数 = wiring gap 数。

测试结果速览：23 wiring 测试 / 7 ✅ / 16 ❌。

---

## ✅ 已正确接线（7）

| Feature | 焊接位置 | 验证手段 |
|---|---|---|
| A1 worktree lookup | `src/polit/paths.ts` 调 `findCanonicalProjectRoot` | grep |
| B2 `web_fetch` 工具 | `createBuiltinRegistry()` 默认注册 | dynamic |
| B3 MCP 静态 instructions | `PromptAssembler.assemble` 调 `extension.listMcpInstructions()` | grep |
| C2 subagent fork API | `AgentLoop.createToolContext` 设 `subagent: this.buildSubagentForkApi(...)` | grep |
| Router | `createLocalGateway` 调 `createRouterRuntime` 并把 `runtime.router` 透传 deps | grep |
| Cron 控制器 | `createGateway({ cron: options.cron })` | grep |

---

## ❌ 接线漏洞（16）

### Wave A — context / token

| ID | 缺什么 | 实际症状 | 修法 |
|---|---|---|---|
| **A2** real tokenizer fallback | `createLocalGateway` 没给 `TokenBudgetManager` 注入 provider tokenizer | char/4 估算永远生效，长 prompt 不会按真 token 数收紧 | `new TokenBudgetManager({ tokenizer: pickProviderTokenizer(snapshot.config.model) })` 喂给 context |
| **A3** `structured_output` 工具 | `createBuiltinRegistry()` 没注册 | 即便 model 命中 schema 也没工具可调 | `createBuiltinRegistry.ts` 加 `registry.register(createStructuredOutputTool())` |
| **A4** cached microcompact | `CachedMicroCompactionEngine` 从未实例化 | Anthropic prefix-cache 永远不复用，token 浪费 | `createLocalGateway` 在 context 装一个，gated on `config.context.cachedMicrocompactEnabled` |
| **A5** snip compact | `CompactionEngine` / `AutoCompactionPolicy` 从未实例化 | 长会话不会自动 compact，到容量后只能由 prompt-too-long-recovery 兜底 | 同上：构造并塞进 context runtime |

### Wave B — elicitation

| ID | 缺什么 | 实际症状 | 修法 |
|---|---|---|---|
| **B1.tool** `ask_user_question` 工具 | `createBuiltinRegistry()` 没注册 | model 想问用户也没 tool 可调 | 加 `createAskUserQuestionTool()` |
| **B1.channel** elicitation 通道注入 | `AgentLoop.createToolContext` 没设 `elicitation:` | 即便 tool 注册了，执行时拿不到 host channel，立刻报 `unsupported_tool` | `dependencies.elicitation` 传到 `createToolContext` |

### Wave C — MCP / sidechain / file history / background tasks

| ID | 缺什么 | 实际症状 | 修法 |
|---|---|---|---|
| **C1** MCP runtime | `McpRuntime` / `createMcpToolDefinitionsFromRuntime` 从未在生产路径调用 | `politdeck.yaml` 配的 mcp servers 完全没起 | `createLocalGateway` 按 config 启动 `McpRuntime`、`await createMcpToolDefinitionsFromRuntime` 后 register 进 ToolRegistry |
| **C3** sidechain transcript hooks | `createLocalGateway` 没传 `subagentTranscript:` 进 deps | 子 agent fork 跑得了但 sidechain `<sub>.jsonl` 不会写、parent transcript 也没 `subagent_started/_completed` 标记 | 用 `JsonlTranscriptWriter.recordSubagentStarted/_Completed` + `forSubagent` 织 hooks，传到 `dependencies.subagentTranscript` |
| **C4.sink** file history sink | `AgentLoop.createToolContext` 没设 `fileHistory:` | `edit_file` / `write_file` 写文件**不**生成 backup，rewind 失效 | 在 deps 加 `fileHistory: PolitDeckToolFileHistorySink`，loop 透传 |
| **C4.id** `messageId` | 同上没设 | 即便接了 sink，trackEdit 没法分组 | loop 传 turnId fallback |
| **C5** background task runtime | `BackgroundTaskRuntime` 从未实例化、`task_*` tools 没注册 | bash run_in_background → unsupported tool | `new BackgroundTaskRuntime()` + `createBuiltinRegistry({ backgroundTasks: { runtime } })` |

### 跨切：memory / tool-result-budget

| ID | 缺什么 | 实际症状 | 修法 |
|---|---|---|---|
| **memory.provider** | `EdgeClawMemoryProvider` 从未实例化 | `snapshot.config.memory` 解析了但没人读 | `createLocalGateway` 按 `memory.enabled && provider==="edgeclaw"` 起 `EdgeClawMemoryService` + `EdgeClawMemoryProvider` |
| **memory.context** | `DefaultContextRuntime` 没拿到 `memoryResolver` | `<memory-context>` 永远不会拼进 system prompt | 上一条产物喂给 `new DefaultContextRuntime({ memoryResolver })` |
| **memory.capture** | turn 结束没有 `captureTurn` 调用 | 用户聊天历史不会进 EdgeClaw 索引 | `AgentLoop` 在 yield `turn_completed` 之前调 `memoryResolver.captureTurn`，或暴露在 deps 上由上层做 |
| **budget.provider** | `ToolResultBudget` 从未实例化 | 大 tool result 全量留在 prompt 里 | `new ToolResultBudget({ toolResultsDir, maxResultSizeChars })` 接 context |
| **budget.apply** | `AgentLoop` 没调 `contextRuntime.applyToolResults` | 即便接了 budget 也不会触发落盘 | `AgentLoop` 在 tool result 注入历史前调一次 `contextRuntime.applyToolResults?.(...)`，并把 `applyToolResults` 提到 `AgentContextRuntime` 接口（目前只声明了 `prepareForModel` + `recoverFromModelError`） |

---

## 接线策略要点（修的时候参考）

1. **C5 / C1 / memory** 都对 `ProjectRuntime` 加新成员：建议在 `ProjectRuntimeRegistry.resolve()` 里实例化（per-project，缓存），不在 `createSession()` 里 new（per-session 浪费）。
2. **C3 / C4 / B1 channel / messageId** 都跟"per-session 上下文"有关：在 `createSession()` 里造、传 deps。
3. **Memory captureTurn / applyToolResults** 需要扩 `AgentContextRuntime` 接口；同事的 router 改动没动这块，提交前确认与他对齐。
4. **B3 静态 instructions** 已经接通，但是 **C1 真实 MCP runtime 接通后，要把 dynamic instructions 也聚合进 `getAllMcpInstructions()`**，否则只有 manifest 里写死的会出现在 prompt 里。
5. **A4/A5/B1 channel** 这类 "cross-cutting" 接线建议改用一个集中的 `wireProjectDependencies(snapshot, deps)` 函数，而不是把所有 `if` 散在 `createLocalGateway` 里 —— 否则下次又会漏。

---

## 修复后该改的测试

`tests/wiring/feature-wiring.test.ts` 当前用 grep+pattern，能发现 wiring 漏掉但**不能**发现 wiring 错配。修完之后，每条建议补一个**真正跑 turn**的 integration test：

- `tests/wiring/memory-runtime.test.ts`：fake `EdgeClawMemoryService.retrieveContext` → 跑 `gateway.submitTurn(...)` → 断言 stub 收到的 system prompt 含 `<memory-context>`，并且 fake `captureTurn` 在 `turn_completed` 后被调到。
- `tests/wiring/file-history-runtime.test.ts`：fake model 返回 `edit_file` tool_call → 检查文件被改 + backup 存在。
- `tests/wiring/elicitation-runtime.test.ts`：fake model 返回 `ask_user_question` → 检查 elicitation 通道收到 question。
- `tests/wiring/background-task-runtime.test.ts`：fake model `bash {run_in_background: true}` → 检查 `task_list` 里有 entry。
- `tests/wiring/mcp-runtime.test.ts`：注入 in-memory MCP server → 检查 tool 出现在 registry。

为了真跑 turn，需要给 `createLocalGateway` 加一个 `__test__model?: ModelRuntime` 注入点（或者抽出 `createProjectRuntime` 函数让 test 用更细的入口）。这是修复 wiring 时一并要做的事。
