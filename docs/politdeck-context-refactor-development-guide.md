# PolitDeck Context 重构代码开发文档

本文用于指导将 `third-party/claude-code-main` 中围绕 agent loop 的上下文构造、消息投影、工具结果预算、附件、memory、MCP resources、compact 和 overflow recovery 能力重构为 PolitDeck 顶层 `context` 模块。

本文件遵循 `.cursor/skills/refactor-with-parity` 的要求：不能声称“与旧实现行为一致”，除非存在同一套共享场景同时运行 legacy 和 PolitDeck 实现，并比较归一化输出。

## 1. 背景与边界

总方案 `docs/rewrite-plan/02-rewrite-project-report.md` 定义：

```text
agent
  -> context
  -> model
  -> tool
  -> session
```

`context` 的职责是每次模型请求前后的上下文治理：

- PromptAssembler。
- MessageProjector。
- TokenBudgetManager。
- ToolResultBudget。
- CompactionEngine。
- MemoryResolver。
- AttachmentResolver。
- ContextOverflowRecovery。

它对 `agent` 暴露的接口是：

```text
prepareForModel(turnState) -> ModelContext
recoverFromModelError(error, turnState) -> RecoveryDecision
applyToolResults(results, turnState) -> TurnState
```

当前仓库只有基础骨架：

```text
src/context/
  ContextRuntime.ts
  NullContextRuntime.ts
```

当前 `AgentLoop` 通过 `AgentRuntimeDependencies.context` 调用 `prepareForModel()`，并把返回的 `messages` / `tools` 传给 `model`。这条接入点已经存在，后续 context 能力必须沿这个接口增长，而不是把逻辑重新塞回 `AgentLoop`。

## 2. Source Of Truth

| 类型 | 路径 | 用途 |
| --- | --- | --- |
| 总方案 | `docs/rewrite-plan/02-rewrite-project-report.md` | context 顶层归属和接口 |
| 现状分析 | `docs/current-agent-loop-analysis/03-context-session-runtime.md` | legacy 上下文、session、附件、恢复分析 |
| 当前实现 | `src/context/` | PolitDeck context 当前骨架 |
| 当前实现 | `src/agent/loop/AgentLoop.ts` | context 与 agent 的接入点 |
| 当前实现 | `src/session/` | compact boundary / transcript / replay 联动目标 |
| 当前实现 | `src/model/` | canonical message 和 model capabilities |
| 当前实现 | `src/tool/` | tool result 内容和 max result bytes |
| legacy prompt | `third-party/claude-code-main/src/utils/queryContext.ts` | system prompt / user context / system context 构造 |
| legacy input | `third-party/claude-code-main/src/utils/processUserInput/processUserInput.ts` | slash、附件、本地命令、模型覆盖 |
| legacy messages | `third-party/claude-code-main/src/utils/messages.ts` | normalize/reorder/strip/merge/tool_result 配对 |
| legacy budget | `third-party/claude-code-main/src/utils/toolResultStorage.ts` | tool result budget 和大结果持久化 |
| legacy compact | `third-party/claude-code-main/src/services/compact/*` | compact、autocompact、microcompact、summary |
| legacy query | `third-party/claude-code-main/src/query.ts` | context 策略在主 loop 中的顺序 |
| legacy attachments | `third-party/claude-code-main/src/utils/attachments.ts` | 文件、IDE、memory、MCP、task、skill attachments |

## 3. 当前 PolitDeck Context 状态

当前已有：

| Feature | 当前文件 | 状态 | 说明 |
| --- | --- | --- | --- |
| context runtime interface | `src/context/ContextRuntime.ts` | `compare` skeleton | 定义 `prepareForModel()` |
| null context runtime | `src/context/NullContextRuntime.ts` | `compare` skeleton | 透传 messages/tools，可按 `maxMessages` 保留尾部消息 |
| agent integration | `src/agent/loop/AgentLoop.ts` | `compare` skeleton | `createModelRequest()` 调用 context runtime |
| model compatibility | `src/model/protocol/canonical.ts` | `compare` | context 输出 canonical messages |
| session boundary hook | `src/session/transcript/TranscriptEntry.ts` | `compare` skeleton | 已有 `control_boundary` entry 类型 |
| memory resolver interface | `src/context/memory/MemoryResolver.ts` | `compare` skeleton | 定义 retrieve / captureTurn 协议 |
| EdgeClaw memory adapter | `src/context/memory/EdgeClawMemoryProvider.ts` | `intentional_difference` skeleton | 适配 EdgeClaw `retrieveContext()` / `captureTurn()` |
| memory config parsing | `src/polit/config/parseMemoryConfig.ts` | `compare` skeleton | 解析 `memory.provider=edgeclaw` 配置 |

当前还没有：

- prompt assembly。
- user/system context parts。
- input processor。
- attachment resolver。
- memory resolver 高级策略。
- MCP resource injection。
- tool result budget persistence。
- compact summary。
- microcompact/cache edit。
- autocompact。
- reactive compact。
- context collapse。
- model error recovery loop。
- token counting。
- context parity fixtures。

## 4. Legacy 能力清单与缺口

### 4.1 Prompt Assembly

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| default system prompt | `getSystemPrompt()` via `fetchSystemPromptParts()` | `context/prompt/PromptAssembler` | `deferred` | 需要从 tool schemas、model、working dirs 构造 |
| user context | `getUserContext()` | `context/prompt/UserContextResolver` | `deferred` | 包含 cwd、环境、用户上下文 |
| system context | `getSystemContext()` | `context/prompt/SystemContextResolver` | `deferred` | custom system prompt 下跳过 |
| custom system prompt | `QueryEngine.customSystemPrompt` | `PromptAssembler` | `deferred` | 应替换 default prompt |
| append system prompt | `appendSystemPrompt` | `PromptAssembler` | `deferred` | 追加到 prompt parts |
| memory mechanics prompt | `loadMemoryPrompt()` / EdgeClaw memory prompt | `MemoryResolver` | `deferred` | memory module 后续 |
| coordinator context | `getCoordinatorUserContext()` | `extension/context contributions` | `deferred` | coordinator mode 后续 |

### 4.2 Input Processing

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| text prompt to user message | `processTextPrompt()` | `context/input/InputProcessor` | `compare` skeleton | 当前 `TurnInputProcessor` 只支持 text/blocks，应迁入 context |
| slash commands | `parseSlashCommand()` / `processSlashCommand()` | `adapters/cli` + `extension.commands` + `context/input` | `deferred` | 不应进入 model |
| local bash mode command | `processUserInputBase()` | `adapters/cli` + `context/input` | `deferred` | local command output 投影 |
| pasted contents | `pastedContents` / image store | `AttachmentResolver` | `deferred` | 多模态附件 |
| IDE selection | `ideSelection` | `AttachmentResolver` | `deferred` | IDE adapter 后续 |
| model override | slash command result model | `AgentRuntimeConfig` update | `deferred` | 影响后续 model request |
| allowed tools update | `allowedTools` | `permission/session rules` | `deferred` | 与 permission 联动 |
| shouldQuery false | slash/local command-only result | `InputProcessorResult` | `deferred` | 不能强行进入 model |

### 4.3 Message Projection

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| get after compact boundary | `getMessagesAfterCompactBoundary()` | `MessageProjector` | `deferred` | 当前只按 `maxMessages` 截尾 |
| reorder attachments | `reorderAttachmentsForAPI()` | `MessageProjector` | `deferred` | 附件必须在 provider API 允许位置 |
| normalize for API | `normalizeMessagesForAPI()` | `MessageProjector` | `deferred` | PolitDeck 输出 canonical messages，provider 转换在 model |
| merge user/tool results | `mergeUserMessagesAndToolResults()` | `MessageProjector` | `deferred` | 保证 tool_result 跟 tool_call 配对 |
| strip unavailable tool refs | `stripUnavailableToolReferencesFromUserMessage()` | `ToolReferenceProjector` | `deferred` | 依赖 deferred tool search |
| strip media after media errors | `sanitizeErrorToolResultContent()` | `ContextOverflowRecovery` | `deferred` | 防止反复 400 |
| thinking block preservation | query + messages rules | `MessageProjector` | `deferred` | 需要 provider signature 策略 |

### 4.4 Tool Result Budget

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| aggregate result budget | `applyToolResultBudget()` | `ToolResultBudget` | `deferred` | 当前 tool runtime 只有 per-result bytes limit |
| persist large results | `persistToolResult()` | `session/storage/tool-results` + `ToolResultBudget` | `deferred` | 需要 project/session path |
| content replacement state | `contentReplacementState` | `ToolResultBudgetState` | `deferred` | resume 后恢复 replacement decisions |
| persisted output message | `<persisted-output>` | `MessageProjector` | `intentional_difference` | PolitDeck 应使用 structured canonical reference |
| no budget for opted-out tools | maxResultSize infinity | `ToolResultBudget` | `deferred` | 需读取 tool definition |

### 4.5 Attachments / Memory / MCP Resources

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| file attachment | `getAttachmentMessages()` | `AttachmentResolver` | `deferred` | read file/token budget 联动 |
| image resize/downsample | `maybeResizeAndDownsampleImageBlock()` | `AttachmentResolver` | `deferred` | model multimodal constraints 联动 |
| PDF page/count | `pdfUtils` / `getPDFPageCount()` | `AttachmentResolver` | `deferred` | PDF constraints |
| IDE diagnostics | `diagnosticTracker` | `AttachmentResolver` | `deferred` | IDE adapter |
| memory files | `getMemoryFiles()` / `getManagedAndUserConditionalRules()` | `MemoryResolver` | `deferred` | memory module |
| nested memory attachments | `getMemoryFilesForNestedDirectory()` | `MemoryResolver` | `deferred` | cwd-aware memory |
| auto memory retrieval | `findRelevantMemories()` | `MemoryResolver` | `deferred` | model-assisted memory selection |
| MCP resources | MCP resources in app state | `McpResourceResolver` | `deferred` | Current MCP resource tools exist, context injection not done |
| task attachments | `generateTaskAttachments()` | `TaskAttachmentResolver` | `deferred` | task runtime |
| skill discovery/listing | skill search prefetch | `ExtensionResolver` | `deferred` | extension phase |

## 4.5.1 EdgeClaw Memory Core 替换评估

目标：评估是否可以用 `third-party/edgeclaw-memory-core` 替换 legacy `memdir` / auto-memory / session-memory 相关能力。

### 可行性结论

可以作为 PolitDeck 的长期 memory backend，但不能直接替换整个 legacy context memory 流程。

适合替换的部分：

- 长期记忆存储：`MemoryRepository`、`FileMemoryStore`、SQLite/file-backed memory。
- 记忆记录模型：user/project/feedback/general_project_meta。
- 项目维度记忆：`projectId`、`projectName`、`WorkspaceMemoryMode`、general projects。
- LLM 提取记忆：`LlmMemoryExtractor`。
- 检索与召回：`ReasoningRetriever`、`retrieveContext()`。
- 后台整理/复盘：heartbeat、dream review、index/dream settings。
- session -> memory capture：`captureTurn()` / `captureStrategy`。

不能直接替换的部分：

- legacy `CLAUDE.md` / nested memory 文件自动发现。
- prompt 拼接时机和 system prompt section ordering。
- attachments 中 memory file 注入和 dedupe。
- compact 后 memory re-injection。
- tool result budget / context collapse / reactive compact。
- MCP resources、skills、plugins 的 context contribution。
- permission/session/worktree mode 对 memory 注入的影响。

因此推荐做法是：

```text
PolitDeck Context
  -> MemoryResolver interface
    -> EdgeClawMemoryProvider
      -> edgeclaw-memory-core service/repository/retriever
```

不要让 `AgentLoop` 或 `model` 直接依赖 `edgeclaw-memory-core`。

### EdgeClaw API 能力

`edgeclaw-memory-core` 暴露：

- `EdgeClawMemoryServiceOptions`
  - `workspaceDir`
  - `rootDir`
  - `dbPath`
  - `memoryDir`
  - `captureStrategy: "last_turn" | "full_session"`
  - `includeAssistant`
  - `maxMessageChars`
  - `llm` config
- `CaptureTurnResult`
  - `captured`
  - `normalizedMessages`
  - `sessionKey`
- `RetrieveContextResult`
  - extends `RetrievalResult`
  - `systemContext`
- memory records:
  - `MemoryMessage`
  - `MemoryCandidate`
  - `MemoryFileRecord`
  - `MemoryUserSummary`
  - `ProjectMetaRecord`
  - `ReadableProjectCatalogEntry`

这说明它天然更像一个 memory service/backend，而不是 legacy `CLAUDE.md` 文件发现器。

### 与 legacy memory 的主要差异

| 维度 | Legacy memory / context | EdgeClaw memory core | 影响 |
| --- | --- | --- | --- |
| 存储形态 | `CLAUDE.md`、nested memory files、memdir、session memory | file memory + SQLite repository + project/user records | 需要迁移/兼容旧文件发现 |
| 注入方式 | system prompt section / attachments / nested_memory | `retrieveContext().systemContext` | 需要 `MemoryResolver` 把 systemContext 注入 PromptAssembler |
| 检索策略 | 文件发现 + 规则 + 部分 model selection | reasoning retriever + manifest/shortlist/cache | 可增强检索，但 parity 需单独定义 |
| 项目维度 | cwd/nested directories/project roots | workspaceDir + projectId + general projects | 可对齐 PolitDeck project storage，但要统一 projectId |
| 记忆生成 | 自动 memory、session memory compact、手写 memory 文件 | captureTurn + LLM extraction + dream review | 更结构化，但行为不同 |
| 用户画像 | legacy memory prompt/files | user summary / UserIdentity records | 可替换，但 prompt 文案不同 |
| compact 联动 | compact 后 re-inject memory/attachments | 独立 retrieval/capture pipeline | 需要 Context/Compaction 明确调用 |
| 依赖配置 | legacy env/config | `EDGECLAW_*` / llm options / rootDir | 应映射到 PolitConfig，不直接读 `.env` |

### PolitDeck 接入方案

已新增第一版：

```text
src/context/memory/
  MemoryResolver.ts
  EdgeClawMemoryProvider.ts
```

后续完整目标：

```text
src/context/memory/
  MemoryResolver.ts
  EdgeClawMemoryProvider.ts
  LegacyMemoryCompatibility.ts
```

接口：

```ts
export type MemoryResolver = {
  retrieve(input: {
    query: string;
    sessionId: string;
    projectRoot: string;
    recentMessages: CanonicalMessage[];
  }): Promise<{
    systemContext?: string;
    diagnostics: ContextDiagnostic[];
    metadata?: Record<string, unknown>;
  }>;

  captureTurn(input: {
    sessionId: string;
    projectRoot: string;
    messages: CanonicalMessage[];
  }): Promise<void>;
};
```

当前 `EdgeClawMemoryProvider` 已负责：

- 把 `CanonicalMessage[]` 转成 `MemoryMessage[]`。
- 调 `retrieveContext()`，把 `systemContext` 返回给 `PromptAssembler`。
- 在 turn 完成后调用 `captureTurn()`，且 capture 失败不打断 agent turn。

仍待补齐：

- 用 PolitDeck `projectRoot` 生成并管理 EdgeClaw `workspaceDir` 的工厂。
- 把 PolitDeck model config 映射为 EdgeClaw `llm` config 的 service builder。
- 在 `ContextRuntime.prepareForModel()` 中真正调用 `MemoryResolver.retrieve()`。
- 在 `TurnRunner` / `AgentSession` turn 完成后调用 `MemoryResolver.captureTurn()`。

### 配置映射

不要直接要求 PolitDeck 使用根目录 `.env`。已扩展 `politdeck.yaml` 解析，推荐配置：

```yaml
memory:
  provider: edgeclaw
  enabled: true
  rootDir: ~/.politdeck/memory
  captureStrategy: last_turn
  includeAssistant: true
  maxMessageChars: 12000
  llm:
    provider: edgeclaw
    model: anthropic/claude-sonnet-4.6
```

与当前本地 `.env` 风格的关系：

- `EDGECLAW_API_BASE_URL` -> `model.providers.<id>.url` 或 `memory.llm.baseUrl`
- `EDGECLAW_API_KEY` -> `model.providers.<id>.apiKey` 或 `memory.llm.apiKey`
- `EDGECLAW_MODEL` -> `memory.llm.model`

PolitDeck 中应优先复用 `model` 配置，避免 memory 和 model 各自维护一套 key。

### 兼容策略

第一阶段不要删除 legacy-style memory 文件能力，而是做两层：

```text
MemoryResolver
  -> EdgeClawMemoryProvider
  -> FileMemoryCompatibilityProvider
```

其中：

- EdgeClaw 负责长期结构化记忆。
- Compatibility provider 负责读取现有 `CLAUDE.md` / nested memory / project rules 语义，直到 extension/config 模块接管。

### Parity 分类

| Feature | Replacement status | Parity status | Reason |
| --- | --- | --- | --- |
| long-term user/project memory | EdgeClaw | `intentional_difference` initially | 数据模型不同，但目标能力更强；当前已有 provider adapter skeleton |
| memory retrieval into prompt | EdgeClaw systemContext | `compare` after scenarios | 可比较“是否注入相关 memory context” |
| nested `CLAUDE.md` discovery | Compatibility provider | `deferred` | EdgeClaw 不负责目录规则 |
| session memory compaction | EdgeClaw capture/dream | `intentional_difference` | pipeline 不同 |
| memory tools (`memory_list/search/get`) | EdgeClaw repository APIs | `deferred` | 需要 tool adapters |
| memory prompt mechanics | PromptAssembler + EdgeClaw context | `intentional_difference` | prompt 文案不同 |

### 风险

- 行为 parity 风险：EdgeClaw retrieval 是 reasoning-based，不会和 legacy 文件发现逐条匹配。
- 配置风险：EdgeClaw README 依赖 `EDGECLAW_*`，PolitDeck 应改为 `politdeck.yaml` 驱动。
- 存储风险：EdgeClaw 默认 `~/.edgeclaw/memory`，PolitDeck 应设置到 `~/.politdeck/memory`。
- Prompt 注入风险：`systemContext` 过长时必须经过 `TokenBudgetManager`。
- 数据迁移风险：旧 `CLAUDE.md` / memory files 需要 import/mirror 策略。

### 推荐结论

推荐替换方向：

- 用 `edgeclaw-memory-core` 作为 PolitDeck memory backend。
- 不直接替换 `context` 模块。
- 不直接让 `agent` 调 EdgeClaw。
- 通过 `Context.MemoryResolver` 接入。
- 第一阶段作为 `intentional_difference`，等 shared scenarios 稳定后再把部分 retrieval 场景升级为 `compare`。

### 4.6 Compact / Context Budget

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| token warning state | `calculateTokenWarningState()` | `TokenBudgetManager` | `deferred` | Need tokenizer/estimator |
| blocking limit | query blocking limit | `TokenBudgetManager` | `deferred` | Current null runtime no token count |
| manual compact | `compactConversation()` | `CompactionEngine` | `deferred` | Summarization model call |
| auto compact | `autoCompactIfNeeded()` | `CompactionEngine` | `deferred` | Threshold/circuit breaker |
| compact boundary | `createCompactBoundaryMessage()` | `session.control_boundary` + `context` | `deferred` | session schema has boundary skeleton |
| post compact messages | `buildPostCompactMessages()` | `CompactionEngine` | `deferred` | Boundary + summary + kept messages |
| preserved segment metadata | `annotateBoundaryWithPreservedSegment()` | `CompactionBoundary` | `deferred` | Resume relink |
| PTL retry during compact | `truncateHeadForPTLRetry()` | `CompactionEngine` | `deferred` | Last-resort compact retry |
| session memory compact | `trySessionMemoryCompaction()` | `MemoryResolver` + `CompactionEngine` | `deferred` | memory module |

### 4.7 Microcompact / Context Collapse / Reactive Recovery

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| microcompact | `deps.microcompact()` | `MicroCompactionEngine` | `deferred` | API/cache-edit based local compaction |
| cached microcompact boundary | `createMicrocompactBoundaryMessage()` | `session.control_boundary` | `deferred` | Need cache deletion token tracking |
| snip | `snipCompactIfNeeded()` | `SnipCompactionEngine` | `deferred` | History slicing |
| context collapse projection | `contextCollapse.applyCollapsesIfNeeded()` | `ContextCollapseStore` | `deferred` | Granular collapses |
| collapse overflow drain | `contextCollapse.recoverFromOverflow()` | `ContextOverflowRecovery` | `deferred` | On real API 413 |
| reactive compact | `tryReactiveCompact()` | `ContextOverflowRecovery` | `deferred` | Prompt too long / media recovery |
| max output recovery | query max output recovery | `ContextOverflowRecovery` | `deferred` | Continuation meta prompt |

## 5. Target Structure

目标目录：

```text
src/context/
  index.ts

  protocol/
    types.ts
    diagnostics.ts
    errors.ts

  input/
    InputProcessor.ts
    processTextInput.ts
    processSlashCommandResult.ts

  prompt/
    PromptAssembler.ts
    UserContextResolver.ts
    SystemContextResolver.ts

  projection/
    MessageProjector.ts
    ToolResultProjector.ts
    AttachmentProjector.ts
    ThinkingBlockPolicy.ts

  budget/
    TokenBudgetManager.ts
    ToolResultBudget.ts
    ToolResultPersistence.ts

  attachments/
    AttachmentResolver.ts
    FileAttachmentResolver.ts
    ImageAttachmentResolver.ts
    PdfAttachmentResolver.ts
    IdeAttachmentResolver.ts
    McpResourceResolver.ts

  memory/
    MemoryResolver.ts
    MemoryFileResolver.ts
    RelevantMemoryResolver.ts

  compaction/
    CompactionEngine.ts
    AutoCompactionPolicy.ts
    MicroCompactionEngine.ts
    ContextCollapseStore.ts
    CompactBoundary.ts

  recovery/
    ContextOverflowRecovery.ts
    PromptTooLongRecovery.ts
    MaxOutputRecovery.ts
```

## 6. Public Protocol

当前接口：

```ts
export type AgentContextRuntime = {
  prepareForModel(input: AgentContextPrepareInput): Promise<AgentPreparedContext>;
};
```

目标接口：

```ts
export type ContextRuntime = {
  processInput(input: ContextInput): Promise<ContextInputResult>;
  prepareForModel(input: ContextPrepareInput): Promise<ModelContext>;
  applyToolResults(input: ContextToolResultInput): Promise<ContextToolResultResult>;
  recoverFromModelError(input: ContextRecoveryInput): Promise<ContextRecoveryDecision>;
};
```

其中：

```ts
export type ModelContext = {
  messages: CanonicalMessage[];
  systemPrompt?: string;
  tools: CanonicalToolSchema[];
  metadata?: Record<string, unknown>;
  diagnostics: ContextDiagnostic[];
  boundaries: ContextBoundary[];
};
```

`agent` 不应该自己做：

- prompt 拼接。
- compact 判断。
- tool result budget。
- attachment 注入。
- prompt too long recovery。

`agent` 只消费 `ContextRuntime` 的结果并决定 loop 状态。

## 7. 与现有模块的衔接

### 7.1 Agent

当前接入点：

```ts
const prepared = await contextRuntime.prepareForModel({
  messages: cloneMessages(messages),
  tools: registry.toCanonicalSchemas(),
  maxMessages: config.maxContextMessages,
});
```

后续演进：

- `AgentLoop` 调用 `prepareForModel()` 获取 `messages/systemPrompt/tools`。
- 工具执行后调用 `applyToolResults()`，而不是直接 `projectToolResults()`。
- 模型错误时调用 `recoverFromModelError()`，而不是只靠 `AgentRecoveryPolicy`。
- `TurnRunner` 调用 `context.processInput()`，逐步替代 `TurnInputProcessor`。

### 7.2 Model

`context` 输出必须是 `CanonicalMessage[]`，并由 `model` 做 provider request 转换。`context` 可读取 model capabilities：

- `maxContextTokens`。
- multimodal constraints。
- `supportsToolUse`。
- `supportsThinking`。

但 `context` 不应输出 Anthropic/OpenAI raw message。

### 7.3 Tool

`context` 需要读取：

- tool schemas。
- tool max result size。
- tool result content。
- deferred tool / MCP tool availability。

`ToolResultBudget` 要和 `session` 联动，把大结果持久化到 project session 目录，并把 model 可见内容替换为 canonical reference。

### 7.4 Session

`context` 需要写入：

- compact boundary。
- microcompact boundary。
- content replacement records。
- tool result persisted file metadata。

这些都必须通过 `session` 模块接口，不直接写文件。

### 7.5 Extension

plugins/skills/hooks/MCP contributions 通过 `extension` 给 context 提供：

- prompt fragments。
- commands。
- memory providers。
- resource providers。
- hooks。
- permission rules。

context 不直接加载 plugin 文件或 MCP transport。

## 8. Implementation Order

### Phase 0：边界整理

已完成：

- `src/context/` 顶层模块存在。
- `AgentLoop` 通过 dependency 注入使用 `context`。

### Phase 1：Context Protocol

实现：

- `src/context/protocol/types.ts`。
- `ContextRuntime` 完整接口。
- `ContextDiagnostic`。
- `ContextBoundary`。

测试：

- null runtime 仍可替换。
- agent 可消费新接口。

### Phase 2：Prompt / Message Projection

实现：

- `PromptAssembler`。
- `MessageProjector`。
- compact boundary 后消息选择。
- tool_result 配对和排序策略。
- thinking block policy skeleton。

测试：

- system prompt + append prompt。
- compact boundary 后只取后续消息。
- tool_result 总在对应 tool_call 后。

### Phase 3：Tool Result Budget

实现：

- aggregate budget。
- persisted large tool result。
- replacement state。
- session persistence integration。

测试：

- 超大结果被替换为 reference。
- persisted file 可读。
- replay 后 replacement state 保持。

### Phase 4：Input / Attachments

实现：

- `InputProcessor`。
- text prompt。
- attachment resolver interface。
- file/image/PDF/IDE/MCP resource skeleton。

测试：

- shouldQuery false。
- unsupported attachment diagnostics。
- multimodal constraints。

### Phase 5：Compact / Recovery

实现：

- token budget manager。
- blocking limit。
- manual compact。
- auto compact policy。
- prompt too long recovery。
- max output recovery。

测试：

- threshold decisions。
- compact boundary transcript entry。
- recovery decision does not loop infinitely。

### Phase 6：Memory / Extension Context

实现：

- memory file resolver。
- relevant memory resolver。
- skill/plugin prompt contributions。
- MCP resource context contributions。

测试：

- memory dedupe。
- nested memory path handling。
- plugin contribution ordering。

## 9. Feature Matrix

| Feature | Current | Target | Status |
| --- | --- | --- | --- |
| prepareForModel | yes | full model context | `compare` skeleton |
| maxMessages retention | yes | real token budget | `intentional_difference` now, deferred target |
| prompt assembly | no | PromptAssembler | `deferred` |
| message projection | partial in agent | MessageProjector | `deferred` |
| tool result budget | per-tool runtime limit only | aggregate/persisted budget | `deferred` |
| compact boundary | session skeleton | context-aware boundary | `deferred` |
| manual compact | no | CompactionEngine | `deferred` |
| autocompact | no | AutoCompactionPolicy | `deferred` |
| reactive compact | no | ContextOverflowRecovery | `deferred` |
| attachments | no | AttachmentResolver | `deferred` |
| memory | partial | MemoryResolver + EdgeClaw adapter | `intentional_difference` skeleton |
| MCP resources | tool skeleton only | McpResourceResolver | `deferred` |
| slash/local command input | no | InputProcessor + adapters | `deferred` |

## 10. Intentional Differences

| ID | Legacy behavior | PolitDeck behavior | Reason | Risk |
| --- | --- | --- | --- | --- |
| `context-canonical-messages` | Legacy context ultimately targets Anthropic message params | PolitDeck context emits `CanonicalMessage[]` | Provider-neutral model layer | same |
| `context-no-agent-inline-storage` | Legacy query directly calls sessionStorage helpers in context paths | PolitDeck context talks to session interfaces | Preserve module boundary | lower |
| `context-no-feature-flags` | Legacy uses `feature()` and product-specific gates | PolitDeck uses config/capability/dependency injection | Avoid legacy build coupling | lower |
| `context-null-retention-now` | Current PolitDeck only keeps latest N messages | Temporary skeleton only | Enables safe integration before token budget exists | same |

## 11. Deferred Register

| ID | Behavior | Phase | Release gate |
| --- | --- | --- | --- |
| `context-prompt-assembler` | default/user/system prompt assembly | Phase 2 | model request parity |
| `context-message-projector` | normalize/reorder/strip/merge messages | Phase 2 | provider request parity |
| `context-tool-result-budget` | aggregate tool result budget and persistence | Phase 3 | long tool output release |
| `context-attachments` | file/image/PDF/IDE/MCP resources | Phase 4 | multimodal/IDE release |
| `context-input-processor` | slash/local command/input expansion | Phase 4 | CLI release |
| `context-token-budget` | token estimation and blocking limit | Phase 5 | long-session release |
| `context-manual-compact` | manual compact summary | Phase 5 | `/compact` release |
| `context-auto-compact` | autocompact threshold and circuit breaker | Phase 5 | long-session release |
| `context-reactive-compact` | prompt-too-long/media recovery | Phase 5 | recovery parity |
| `context-memory` | memory file and relevant memory injection | Phase 6 | memory release |
| `context-extension-contrib` | plugin/skill prompt contributions | Phase 6 | extension release |

## 12. Test Plan

新增测试建议：

```text
tests/context/protocol.test.ts
tests/context/prompt-assembler.test.ts
tests/context/message-projector.test.ts
tests/context/tool-result-budget.test.ts
tests/context/attachments.test.ts
tests/context/compaction.test.ts
tests/context/recovery.test.ts
tests/context/memory.test.ts
```

Dual parity：

```text
tests/fixtures/context/dual-parity/
  contractScenarios.ts
  executionScenarios.ts

third-party/claude-code-main/src/
  politdeck-context-legacy-contract-report.ts
  politdeck-context-legacy-execution-report.ts
```

第一批 compare scenarios：

- compact boundary 后消息选择。
- tool_result budget replacement。
- prompt-too-long recovery decision。
- attachment reorder。
- system prompt custom vs default behavior。

## 13. Validation Commands

```bash
npm run build
npm test
```

Legacy probes 避免直接编译整个 vendored tree。优先聚焦 pure helpers，例如：

- `getMessagesAfterCompactBoundary()`。
- `buildPostCompactMessages()`。
- `calculateTokenWarningState()`。
- selected `normalizeMessagesForAPI()` scenarios。

## 14. Release Gates

Context 主链路可认为完成的最低条件：

- `prepareForModel()` 输出完整 `ModelContext`。
- prompt assembly 覆盖 default/custom/append/user/system context。
- compact boundary 后消息选择正确。
- tool result budget 有 aggregate limit 和 persisted output。
- context 写 compact/content replacement 到 `session`，不直接写文件。
- prompt too long / media / max output recovery 有稳定策略。
- attachment resolver 至少覆盖 file/image/PDF skeleton。
- dual parity harness 存在，所有非 compare scenario 有 reason。

不得声称完成的情况：

- 只用 `maxMessages` 截尾却说 token budget parity。
- `AgentLoop` 继续直接投影 tool results，绕过 context。
- compact boundary 只写 transcript 但 resume 不理解。
- attachment 直接传给 model 而不是投影成 canonical messages。
