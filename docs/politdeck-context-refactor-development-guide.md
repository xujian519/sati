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

## 3.1 Legacy 实现实证调研（2026-05）

为避免在 Phase 2-6 设计阶段凭空决策，已对 `third-party/claude-code-main` 做了 10 项实证调研，下表把"我们要做的事"和"legacy 已经怎么做"挂上钩。后续 §4 / §8 的设计取舍均基于此表的事实，不再重复论证。

| # | 关注点 | Legacy 实现位置 | 关键事实 | PolitDeck 决策 |
| --- | --- | --- | --- | --- |
| 1 | Token estimation | `src/services/tokenEstimation.ts`、`src/utils/tokens.ts` | 默认 char/4 估算（JSON 类用 /2，图片 PDF 固定 ~2000 tokens）；可选 `anthropic.beta.messages.countTokens` 真实 tokenizer | char/4 + per-provider override hook（同 legacy 默认路径），真实 tokenizer 列为 deferred |
| 2 | Summary model 调用 | `src/services/compact/compact.ts` | 优先 `runForkedAgent` 复用 prompt cache，fallback `queryModelWithStreaming`；system prompt 写死；`COMPACT_MAX_OUTPUT_TOKENS=20_000`，`MAX_COMPACT_STREAMING_RETRIES=2` | 复用 `AgentModelRuntime.stream()` + 写死 compact systemPrompt；fork 路径列为 deferred |
| 3 | Compact boundary | `src/utils/messages.ts`、`src/utils/sessionStoragePortable.ts` | transcript 写 `type:"system",subtype:"compact_boundary"` + `compactMetadata`；resume 时分块向前扫文件（chunk 1MB，跳过 5MB），运行时 `getMessagesAfterCompactBoundary` 切片 | `session/transcript/TranscriptEntry.control_boundary` 对齐 `compactMetadata`；replay 跳过 boundary 之前的消息；切片助手放 `MessageProjector` |
| 4 | Prompt-too-long 识别 | `src/services/api/errors.ts`、`src/query.ts` | 不靠 HTTP code，而是 `error.message.toLowerCase().includes('prompt is too long')`（Anthropic）；OpenAI 走 `withRetry.ts` 的 400 + `'input length and max_tokens exceed context limit'` 正则；413 还有 `Request too large` 单独路径 | `model/protocol/errors.ts` 加 `CanonicalModelErrorCode = "prompt_too_long" \| "request_too_large" \| "max_output_reached" \| ...`；anthropic / openai 适配器各自匹配 legacy 字符串 |
| 5 | Microcompact | `src/services/compact/microCompact.ts`、`src/services/api/claude.ts` | 两条路径：(a) time-based：idle 后直接改写本地 tool_result；(b) cached：插入 Anthropic `cache_edits`，调 prompt cache 编辑 API；legacy 注释写明纯客户端 microcompact 已移除 | 第一阶段只做 time-based（直接改本地 messages）；cached/cache_edits 路径列 deferred + intentional_difference（PolitDeck 暂不暴露 prompt cache 编辑） |
| 6 | Tool result persistence | `src/utils/toolResultStorage.ts` | 路径 `{projectDir}/{sessionId}/tool-results/{toolUseId}.{json\|txt}`；写入 flag `'wx'`；模型看到 `<persisted-output>` XML + 绝对路径 + 2000 字预览；`DEFAULT_MAX_RESULT_SIZE_CHARS=50_000` | 路径形态对齐 legacy；**model-visible 占位用 canonical reference block 而非 XML**（已在 §4.4 标 intentional_difference） |
| 7 | Thinking signature | `src/services/api/claude.ts`、`src/utils/messages.ts` | streaming 里 case `signature_delta` 写入 thinking block 的 `signature` 字段（初始化 `''`）；切换 credential 时 `stripSignatureBlocks` 删除避免 400 | `CanonicalThinkingBlock` 加 `signature?: string`；anthropic provider stream 累积；MessageProjector 在压缩 thinking 时保留 signature |
| 8 | Reactive compact 循环防护 | `src/query.ts`（`reactiveCompact.ts` 在本 vendor 树缺失） | 用 `hasAttemptedReactiveCompact` 布尔门闩，"single-shot on each"；顺序：collapse drain 一轮 → reactive compact 一轮 → 仍 PTL 直接 yield 错误 | 每个 turn 内 `hasAttemptedCompact` boolean；超过一次 PTL 直接 turn_failed，不引入 retry 计数器 |
| 9 | Compact 后 memory 注入 | `src/services/compact/compact.ts` `buildPostCompactMessages` | 固定顺序：`boundaryMarker → summaryMessages → messagesToKeep → attachments → hookResults`；attachments 含 session hook、deferred tools delta、agent listing、MCP instructions delta | `CompactionEngine.buildPostCompactMessages()` 完全照抄此顺序；attachments 走 `MemoryResolver` + `AttachmentResolver` |
| 10 | Attachments | `src/utils/attachments.ts`、`src/utils/imageResizer.ts`、`src/utils/pdf.ts` | 图片 resize 用 `image-processor-napi` / `sharp`；PDF 页数用 `pdfinfo` 子进程或按 100KB/页估；IDE selection 来自 `useIdeSelection`；MCP 走 `@server:uri` → `mcpClient.readResource` | 第一阶段只做 text + 已 base64 image；`sharp` / `pdfinfo` / IDE / MCP 全部 deferred 直到对应模块就位 |

注意事项：
- legacy 的 `src/services/compact/reactiveCompact.{ts,js}` 在本 vendor 树缺失，第 8 项无法对照 legacy 的精确 retry 计数；PolitDeck 取严格 single-shot。
- legacy `cachedMicrocompact.js` 也是动态 import，仓内未带源码；cached path 不做 dual parity。

## 3.2 Phase 2-6 实施前的硬性决策

下表是基于 §3.1 调研得出的"开始之前必须先固定"的决策。这些决策一旦定下，可以直接写进各 Phase 的实现，不再讨论。

| 决策 | 取值 | 出处 |
| --- | --- | --- |
| Token estimator | char/4（JSON 字段 /2）+ per-provider override hook | §3.1 #1 |
| 真实 tokenizer 接入 | deferred；先决条件 PR 不做 | §3.1 #1 |
| Summary model 通道 | 复用 `AgentModelRuntime.stream()`；不做 forked agent | §3.1 #2 |
| Summary system prompt | 写死 `"You are a helpful AI assistant tasked with summarizing conversations."` | §3.1 #2 |
| Summary max output | `COMPACT_MAX_OUTPUT_TOKENS = 20_000`，对齐 legacy | §3.1 #2 |
| Summary stream retry | `MAX_COMPACT_STREAMING_RETRIES = 2`，对齐 legacy | §3.1 #2 |
| Compact boundary 写入 | `session.control_boundary` + `compactMetadata { trigger, preTokens, preservedSegment, ... }` | §3.1 #3 |
| Compact boundary 消费 | replay 跳过 boundary 之前消息；运行时 `MessageProjector` 切片 | §3.1 #3 |
| PTL 识别 | `error.message.toLowerCase().includes('prompt is too long')`（Anthropic）；`'input length and max_tokens exceed context limit'` 正则（OpenAI） | §3.1 #4 |
| PTL 错误码 | `CanonicalModelErrorCode = "prompt_too_long" \| "request_too_large" \| "max_output_reached" \| ...` | §3.1 #4 |
| Microcompact 第一阶段 | **只做 time-based path**（直接改本地 tool_result） | §3.1 #5 |
| Cached microcompact / `cache_edits` | intentional_difference + deferred；不暴露 Anthropic prompt cache 编辑 API | §3.1 #5 |
| Tool result 持久化路径 | `{politHome}/projects/{projectId}/chats/{sessionId}/tool-results/{toolUseId}.{json|txt}`，flag `'wx'` | §3.1 #6 |
| Tool result preview 大小 | `PREVIEW_SIZE_BYTES = 2000`，对齐 legacy | §3.1 #6 |
| Tool result aggregate budget | `DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000`，对齐 legacy | §3.1 #6 |
| Tool result model-visible 占位 | **canonical reference block**：`{ type: "tool_result_reference", path, originalBytes, preview, mimeType? }`，不抄 `<persisted-output>` XML | §3.1 #6 / §4.4 |
| Thinking signature | `CanonicalThinkingBlock.signature?: string`；anthropic stream 处理 `signature_delta` | §3.1 #7 |
| Reactive compact 防循环 | 每个 turn `hasAttemptedCompact: boolean`；超过一次 PTL 直接 turn_failed | §3.1 #8 |
| Compact PTL 头部重试 | `truncateHeadForPTLRetry()`：切除头部 25%；single-shot | §3.1 #8 |
| Post-compact messages 顺序 | `boundaryMarker → summary → keep → attachments → hookResults` | §3.1 #9 |
| Memory 注入时机 | compact 后通过 `attachments` 槽位由 `CompactionEngine.buildPostCompactMessages` 触发 `MemoryResolver`；PromptAssembler **不**在 prepareForModel 里直接调 memory | §3.1 #9 |
| 图片 attachments 第一阶段 | 原图 base64 直传，不引 `sharp` / `image-processor-napi`；intentional_difference | §3.1 #10 |
| PDF attachments 第一阶段 | 按 100KB/页估算，不引 poppler 子进程；intentional_difference | §3.1 #10 |
| IDE / MCP attachments | deferred 直到 IDE adapter / MCP client 就位 | §3.1 #10 |
| **PromptAssembler 文案** | PolitDeck **自写精简版**，但保留 legacy `getSystemPrompt` / `getUserContext` / `getSystemContext` 的全部"信息槽"（tool descriptions / cwd / git status / env / model / additionalWorkingDirectories / mcp instructions） | review 决策 2026-05 |
| **ContextRuntime 是否拿 model 依赖** | 否（**选 B**）。`CompactionEngine` 由 `AgentLoop` 持有；context 提供决策、loop 帮忙调 model 后回灌结果。`ContextRuntime` 接口零 model 依赖 | review 决策 2026-05 |
| **ContextRecoveryDecision shape** | `{ type: "truncate_head_and_retry"; keepRatio: number; reason: string }` 唯一一种回退动作；其它情况 (`unknown` 错误等) 由 loop 通过 `AgentRecoveryPolicy` 处理或直接 turn_failed | review 决策 2026-05 |
| **ExtensionResolver 范围** | 三类 plugin 派生信息：(a) `listCommands()`（消费 `PluginRuntime.getAllCommands()` 聚合 getter，由 extension owner 提供，**不在 context 里 flatMap snapshot()**），(b) `listSkills()`（消费 `getAllSkills()`），(c) `listMcpInstructions()` **deferred**——extension 只 aggregate plugin manifest 的 mcpServers contribution，不做实际 connection；真实 connect / handshake / read instructions 归 MCP runtime（待 MCP service 落地后接）。**不做 prompt fragment 注册表 / 独立 singleton registry**：未来共用 extension owner 计划的 `ExtensionSnapshot`（turn-stable contribution view，含 commands/skills/prompt fragments/mcpServers），Phase 6 只读 `ExtensionSnapshot` 不落地新 registry。`PromptContribution` / `CommandContribution` type alias 保留为协议占位，Phase 6 不消费 | review 决策 2026-05 + extension owner 反馈 2026-05 |
| **Compact lifecycle 事件** | 复用现有 `PreCompact` / `PostCompact`（已在 `src/extension/hooks/protocol/events.ts` 枚举里），**不**新增 `CompactStart` / `CompactComplete` / `CompactFailed`。compact 的二次 model 调用**不**触发 `UserPromptSubmit` / `Stop` / `StopFailure`，避免与 user turn 语义递归。失败信息进 `PostCompact` payload 的 `status` / `error` 字段；只有 parity / 产品需要独立 hook 时再考虑加 `CompactFailed` | extension owner 反馈 2026-05 |
| **Slash command 解析归属** | 拆三层：**(a)** `adapters/cli\|tui` 负责 input 字符层的解析（识别 `/foo` 前缀，token split），**(b)** `extension.commands`（含 plugin commands/skills）作为命令来源，**(c)** `context/input` `InputProcessor` 负责执行 / 投影到 user message 或 short-circuit 返回。TUI 内置命令（`/new` / `/sessions` / `/mode`）保留为 UI/session 层命令，TUI 直接处理；其它通用 slash command 一律走 dispatcher，TUI 不再硬编码命令 | extension owner 反馈 2026-05 |

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
| get after compact boundary | `getMessagesAfterCompactBoundary()` | `MessageProjector` | `deferred` | 当前只按 `maxMessages` 截尾；目标抄 legacy `findLastCompactBoundaryIndex` + `slice`（§3.1 第 3 项） |
| reorder attachments | `reorderAttachmentsForAPI()` | `MessageProjector` | `deferred` | 附件必须在 provider API 允许位置 |
| normalize for API | `normalizeMessagesForAPI()` | `MessageProjector` | `deferred` | PolitDeck 输出 canonical messages，provider 转换在 model |
| merge user/tool results | `mergeUserMessagesAndToolResults()` | `MessageProjector` | `deferred` | 保证 tool_result 跟 tool_call 配对 |
| strip unavailable tool refs | `stripUnavailableToolReferencesFromUserMessage()` | `ToolReferenceProjector` | `deferred` | 依赖 deferred tool search |
| strip media after media errors | `sanitizeErrorToolResultContent()` | `ContextOverflowRecovery` | `deferred` | 防止反复 400 |
| thinking block preservation | query + messages rules | `MessageProjector` | `deferred` | 需要 provider signature 策略；先决条件：`CanonicalThinkingBlock.signature?: string` + anthropic provider 处理 `signature_delta`（§3.1 第 7 项） |

### 4.4 Tool Result Budget

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| aggregate result budget | `applyToolResultBudget()` | `ToolResultBudget` | `deferred` | 当前 tool runtime 只有 per-result bytes limit；`DEFAULT_MAX_RESULT_SIZE_CHARS=50_000` 对齐 legacy（§3.1 第 6 项） |
| persist large results | `persistToolResult()` | `session/storage/tool-results` + `ToolResultBudget` | `deferred` | 路径形态对齐 legacy `{projectDir}/{sessionId}/tool-results/{toolUseId}.{json\|txt}`；写入 flag `'wx'` 防覆盖 |
| content replacement state | `contentReplacementState` | `ToolResultBudgetState` | `deferred` | resume 后恢复 replacement decisions |
| persisted output message | `<persisted-output>` XML | `MessageProjector` 输出 canonical reference block | `intentional_difference` | reason: PolitDeck 用 `{ type: "tool_result_reference", path, preview, originalBytes }` 走 canonical schema，不用 XML 字符串；risk: 若 model prompt 模板期望 XML 标签需要 release review |
| no budget for opted-out tools | maxResultSize infinity | `ToolResultBudget` | `deferred` | 需读取 tool definition |

### 4.5 Attachments / Memory / MCP Resources

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| file attachment（text + base64 image） | `getAttachmentMessages()` | `AttachmentResolver` + `FileAttachmentResolver` | `deferred` | Phase 4 第一阶段做 text + 已 base64 image |
| image resize/downsample | `maybeResizeAndDownsampleImageBlock()` → `image-processor-napi` / `sharp` | `ImageAttachmentResolver` | `intentional_difference` | reason: 第一阶段不引 `sharp` / `image-processor-napi`，原图直传；risk: 大图被 provider 拒；release review |
| PDF page/count | `pdfUtils` / `getPDFPageCount()` → `pdfinfo` (poppler) | `PdfAttachmentResolver` | `intentional_difference` | reason: 第一阶段不引 poppler 子进程，按 100KB/页估算；release review |
| IDE diagnostics / selection | `diagnosticTracker` / `useIdeSelection` | `IdeAttachmentResolver` | `deferred` | 依赖 IDE adapter，PolitDeck 当前无 |
| memory files | `getMemoryFiles()` / `getManagedAndUserConditionalRules()` | `MemoryResolver` | `deferred` | legacy `CLAUDE.md` 文件发现，PolitDeck 走 EdgeClaw retrieve 路径（§4.5.1） |
| nested memory attachments | `getMemoryFilesForNestedDirectory()` | `MemoryResolver` | `deferred` | cwd-aware memory |
| auto memory retrieval | `findRelevantMemories()` | `MemoryResolver` | `deferred` | model-assisted memory selection |
| MCP resources | `processMcpResourceAttachments()` `@server:uri` | `McpResourceResolver` | `deferred` | 依赖 `tool/builtin/mcpResources` 真实接 MCP client |
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
| token warning state | `calculateTokenWarningState()` | `TokenBudgetManager` | `deferred` | char/4 估算（§3.1 第 1 项），不引真实 tokenizer |
| blocking limit | query blocking limit | `TokenBudgetManager` | `deferred` | 用 `TokenBudgetManager.shouldBlock(messages, capabilities)` |
| manual compact | `compactConversation()` | `CompactionEngine` | `deferred` | summary 调用走 `AgentModelRuntime.stream()`；写死 systemPrompt（§3.1 第 2 项）；max output 20k 对齐 legacy |
| auto compact | `autoCompactIfNeeded()` | `AutoCompactionPolicy` | `deferred` | threshold 默认 80% maxContextTokens，对齐 legacy 行为 |
| compact boundary | `createCompactBoundaryMessage()` | `session.control_boundary` + `CompactionEngine.writeBoundary()` | `deferred` | 写入 `compactMetadata`：trigger / preTokens / preservedSegment / preCompactDiscoveredTools（§3.1 第 3 项） |
| post compact messages | `buildPostCompactMessages()` | `CompactionEngine.buildPostCompactMessages()` | `deferred` | 顺序固定 `boundaryMarker → summary → keep → attachments → hookResults`（§3.1 第 9 项） |
| preserved segment metadata | `annotateBoundaryWithPreservedSegment()` | `CompactBoundary` | `deferred` | resume relink；replay 跳过 boundary 之前消息时保留该 metadata |
| PTL retry during compact | `truncateHeadForPTLRetry()` | `CompactionEngine.truncateHead()` | `deferred` | 头部 25% 切除 last-resort；single-shot |
| session memory compact | `trySessionMemoryCompaction()` | `MemoryResolver` + `CompactionEngine` | `intentional_difference` | reason: PolitDeck 走 EdgeClaw `captureTurn()` pipeline（§4.5.1），与 legacy session memory compact 不同语义 |

### 4.7 Microcompact / Context Collapse / Reactive Recovery

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| microcompact (time-based) | `microcompactMessages()` time-based path | `MicroCompactionEngine` | `deferred` | Phase 5 第一阶段做：直接改写本地 tool_result（§3.1 第 5 项） |
| microcompact (cached / cache_edits) | `cachedMicrocompactPath()` + `insertCacheEdits()` | `MicroCompactionEngine.cachedPath` | `intentional_difference` | reason: PolitDeck 第一阶段不暴露 Anthropic prompt cache 编辑 API；risk: 大对话 cache 命中率低于 legacy；release review 时升级 |
| cached microcompact boundary | `createMicrocompactBoundaryMessage()` | `session.control_boundary` | `intentional_difference` | 同上；time-based path 不需要 cache deletion token tracking |
| snip | `snipCompactIfNeeded()` | `SnipCompactionEngine` | `deferred` | history slicing；Phase 5 后期 |
| context collapse projection | `contextCollapse.applyCollapsesIfNeeded()` | `ContextCollapseStore` | `deferred` | granular collapses |
| collapse overflow drain | `contextCollapse.recoverFromOverflow()` | `ContextOverflowRecovery` | `deferred` | on real API 413 |
| reactive compact | `tryReactiveCompact()` | `ContextOverflowRecovery` | `deferred` | single-shot 布尔 guard，超过一次 PTL 直接 turn_failed（§3.1 第 8 项）；legacy `reactiveCompact.ts` vendor 缺失，PolitDeck 取严格 single-shot |
| max output recovery | query max output recovery | `ContextOverflowRecovery` | `deferred` | continuation meta prompt |

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

### 实施进度（2026-05-08）

| Phase | 状态 | 备注 |
| --- | --- | --- |
| Phase 0 | ✅ 完成 | `src/context/` 顶层模块、AgentLoop 注入完成 |
| Phase 1 | ✅ 完成 | `ContextRuntime` 完整接口在 `src/context/protocol/types.ts` |
| Phase 1.5 | ✅ 完成 | `CanonicalModelErrorCode` + thinking signature + control_boundary schema + `toolResultsDir` |
| Phase 2 | ✅ 完成 | `PromptAssembler` (5-section) + `MessageProjector` + `DefaultContextRuntime` |
| Phase 3 | ✅ 完成 | `ToolResultBudget` + `tool_result_reference` block + 持久化 |
| Phase 4 | ✅ 完成 | `InputProcessor` 三层 + `AttachmentResolver`（text + base64 image + pdf size estimate） |
| Phase 5 | ✅ 完成 | `TokenBudgetManager` + `CompactionEngine` + `AutoCompactionPolicy` + `MicroCompactionEngine` + `ContextOverflowRecovery` |
| Phase 6 | ✅ 完成 | `PluginRuntimeExtensionResolver` + `MemoryAttachmentBuilder` + DefaultContextRuntime memory 接入 |
| Dual parity | ✅ 完成 | `tests/fixtures/context/dual-parity/legacyParityScenarios.ts` 5 类 / 18 场景，全 `compare`，对齐 `tests/context/parity/legacy-context-parity.test.ts` |

测试：245 项（242 pass / 3 e2e skipped / 0 fail）。OpenRouter Kimi K2.6 真实 API 验证通过：
- Tool use E2E：`POLITDECK_RUN_REAL_TOOL_E2E=1 node --test dist/tests/agent/e2e/real-tool-use.test.js`（10.7 秒 pass）。
- Context prompt E2E：`POLITDECK_RUN_REAL_CONTEXT_E2E=1 node --test dist/tests/context/e2e/real-context-prompt.test.js`（12.8 秒 pass，验证 `DefaultContextRuntime.prepareForModel` 出来的 systemPrompt 含 PolitDeck identity + 工具目录 + user-context + environment）。

未列入本轮但已在文档归档为 deferred / intentional_difference：
- `context-microcompact-cached`（Anthropic `cache_edits` 路径）。
- `context-mcp-instructions`（实际 MCP connect / instructions 接入）。
- `context-extension-snapshot`（plugin runtime `ExtensionSnapshot` 上线后切到 turn-stable 视图）。
- `context-pdf-pdfinfo`（poppler）/ `context-image-resize`（sharp）。
- `context-real-tokenizer`（真实 tokenizer，目前 char/4 估算，多媒体 2000 token 占位）。
- `context-snip-compaction` / `context-forked-agent` / `context-tool-result-xml-envelope`。

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

### Phase 1.5：Preconditions（不动 context，只补 model / session 基础设施）

> 必须先做的依赖；不做这一组就开 Phase 2-6 会反复改 `AgentLoop` / fixture。

实现：

- `model/protocol/errors.ts` 增加 `CanonicalModelErrorCode`：
  - `prompt_too_long`、`request_too_large`、`max_output_reached`、`rate_limited`、`upstream_error`、`unknown`。
- `model/providers/anthropic/stream.ts` 解析 error 时按 §3.1 第 4 项匹配 `'prompt is too long'`（case-insensitive）；413 + `'Request too large'` 走 `request_too_large`。
- `model/providers/openai/stream.ts` 按 `'input length and max_tokens exceed context limit'` 正则识别 PTL。
- `model/protocol/canonical.ts` `CanonicalThinkingBlock` 加 `signature?: string`；`anthropic` provider stream 处理 `signature_delta` 累积进去（§3.1 第 7 项）。
- `model/index.ts` `AgentModelRuntime` 接口加 `complete(request, signal)` 可选方法（虽然 Phase 5 默认仍走 `stream()`，留 forked agent 路径口子）。
- `session/transcript/TranscriptEntry.ts` 完善 `control_boundary` schema：`subtype: "compact_boundary" | "microcompact_boundary"` + `compactMetadata { trigger, preTokens, preservedSegment?, logicalParentUuid?, preCompactDiscoveredTools? }`。
- `session/transcript/JsonlTranscriptWriter.ts` 加 `recordControlBoundary()`。
- `session/transcript/TranscriptReplay.ts` 加 `findLastBoundaryIndex()`，replay 时跳过 boundary 之前的 message（保留 boundary metadata 用于诊断）。
- `session/storage/ProjectSessionStorage.ts` 加 `toolResultsDir(sessionId)`；返回 `{politHome}/projects/{projectId}/chats/{sessionId}/tool-results/`。

测试：

- 各 provider 抛 PTL / RTL / max output 错误时 `CanonicalModelError.code` 正确（dual parity 用 legacy `getAssistantMessageFromError` 输出归一化）。
- thinking signature round-trip：anthropic stream → `CanonicalThinkingBlock.signature` → MessageProjector 透传。
- `JsonlTranscriptWriter.recordControlBoundary` + `TranscriptReplay` 切片回放正确。
- `toolResultsDir` 路径 `wx` flag 防覆盖。

不做：

- 真实 tokenizer（仅占位 char/4，留 Phase 5 实现）。
- forked agent / fork sub-session（Phase 5 列 deferred）。

### Phase 2：Prompt / Message Projection

实现：

- `PromptAssembler`：five-section 模型，**PolitDeck 自写文案**但保留 legacy 全部信息槽：

  ```text
  Section 1  default_system_prompt（custom 时跳过）
    - 产品身份："You are PolitDeck, an AI agent runtime..."（精简版）
    - tool catalog：从 ToolRegistry 列每个工具的 name + description
    - permission mode 提示：default / plan / acceptEdits / bypassPermissions
    - 多 working directory 列表（来自 permissionContext.additionalWorkingDirectories）
    - mcp server instructions（来自 ExtensionResolver.listMcpInstructions()）
  Section 2  user_context（始终存在）
    - cwd
    - environment summary（OS / shell / node version）
    - git status 摘要（branch / dirty / ahead-behind）
    - active model + provider
    - active session metadata（id / mode）
  Section 3  system_context（custom 时跳过）
    - 时间戳、locale
    - PolitHome 路径
    - extension 注册的 commands / skills 摘要（来自 ExtensionResolver.listCommands()/listSkills()）
  Section 4  custom_system_prompt（来自 AgentRuntimeConfig，覆盖 Section 1+3）
  Section 5  append_system_prompt（来自 AgentRuntimeConfig，追加在末尾）
  ```

  关键点：
  - 文案不抄 legacy（避免 prompt 工程归属问题），但 **每个信息槽都要有占位**，不能丢 legacy 的功能维度。
  - PromptAssembler 输出 `string[]`（每段独立），由 model layer 决定如何拼成 provider-specific system prompt。
  - 不接 memory：memory 通过 attachments 槽位由 CompactionEngine 触发（§3.2）。
  - 不接 plugin contributions 注册表：仅消费 `ExtensionResolver` 的 three-method API（§3.2）。

- `MessageProjector`：
  - `getMessagesAfterCompactBoundary()` 切片（对齐 legacy `findLastCompactBoundaryIndex`，§3.1 第 3 项）。
  - `mergeUserMessagesAndToolResults()` 保证 tool_result 跟 tool_call 配对。
  - `reorderAttachmentsForAPI()` 占位（attachments 在 Phase 4）。
  - thinking block policy：保留 `signature`，不在 projection 里删除（Phase 1.5 已经支持字段）。

测试：

- system prompt + append prompt 拼接顺序固定。
- compact boundary 后只取后续消息（dual parity vs legacy `getMessagesAfterCompactBoundary`）。
- tool_result 总在对应 tool_call 后。
- thinking block 的 signature 透传到 model request。

### Phase 3：Tool Result Budget

实现：

- `TokenBudgetManager` 第一版（char/4，对齐 §3.1 第 1 项 legacy 默认行为）。
- `ToolResultBudget`：
  - aggregate budget 默认 `DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000`（与 legacy 对齐）。
  - opted-out tools (`maxResultBytes === Infinity`) 不计入。
- `ToolResultPersistence`：
  - 写入 `session/storage/ProjectSessionStorage.toolResultsDir`，文件 `{toolUseId}.{json|txt}`。
  - 写入 flag `'wx'` 防覆盖。
- `MessageProjector` 输出 canonical reference block（**intentional_difference**，不抄 `<persisted-output>` XML，§4.4）：
  ```ts
  { type: "tool_result_reference", path, originalBytes, preview, mimeType? }
  ```
- replacement state 记录到 session（resume 后保持）。

测试：

- 超大结果被替换为 reference block。
- persisted file 内容正确（json/txt 区分）。
- replay 后 replacement decisions 一致。
- intentional_difference scenario：legacy 输出 XML，PolitDeck 输出 reference block，归一化后语义对齐（保留路径 + 预览）。

### Phase 4：Input / Attachments

**Slash command 三层架构（决策 §3.2）**：

```text
[adapters/cli|tui  ] 字符识别 / token split / 内置 UI 命令
        ↓
        如果是 /foo 通用命令
        ↓
[InputProcessor    ] 用 ExtensionResolver.listCommands() 找命令
[ (context/input)  ] 命中 → 执行 / 投影 ; 未命中 → diagnostic
        ↓
        最终输出：CanonicalMessage[] + shouldCallModel: boolean
```

实现：

- **adapter 层（不在 context 里）**：
  - `adapters/channel/cli/CliChannel`、`adapters/channel/tui/app/TuiApp` 处理 `/new` / `/sessions` / `/mode` UI/session 内置命令（不涉及 plugin、不调 InputProcessor）。
  - 其它 `/...` 输入透传给 `InputProcessor.processInput()`，**不再硬编码 plugin 命令**。
- **`InputProcessor`**（在 `src/context/input/`）：
  - text prompt（迁出 `agent/turn/TurnInputProcessor`）。
  - slash command dispatch：调 `dependencies.extension.listCommands()` 查表；命中则按命令类型决定 `shouldCallModel`：
    - markdown body command → 投影成 user message（命令体作为 prompt），`shouldCallModel: true`
    - local-output command（plugin 声明 `outputOnly`）→ 直接返回 local result，`shouldCallModel: false`
    - skill command → 触发 skill prefetch（attachment 槽位），`shouldCallModel: true`
  - 未命中 slash command → 走 `unknown_command` diagnostic + 直接当 user text 处理（兜底）。
- `AttachmentResolver` 接口 + 第一阶段实现：
  - `FileAttachmentResolver`：读 text 文件（base64 image 透传）。
  - `ImageAttachmentResolver`：原图 base64 直传（**intentional_difference**：不引 `sharp` / `image-processor-napi`）。
  - `PdfAttachmentResolver`：按 100KB/页估算（**intentional_difference**：不引 poppler）。
  - `IdeAttachmentResolver`：deferred（PolitDeck 无 IDE adapter）。
  - `McpResourceResolver`：deferred（等 MCP runtime 落地，§3.2 ExtensionResolver 范围）。

测试：

- text 直传：`shouldCallModel: true`。
- TUI 内置 `/new` 不走 InputProcessor（adapter 层处理）。
- plugin slash command 命中：返回投影后的 user message 或 local result。
- 未知 slash command：diagnostic + 兜底处理。
- 大图 / PDF 的 multimodal constraints 检查（model capabilities）。
- unsupported attachment 给出 diagnostic 而不是 throw。

### Phase 5：Compact / Recovery

**关键边界（决策 §3.2 选 B）**：`ContextRuntime` 接口本身**不持有** `AgentModelRuntime`。`CompactionEngine` 由 `AgentLoop` 持有并注入它的 `dependencies.model`。Context 通过 `recoverFromModelError()` 返回**决策**，loop 拿决策后自己调 model + 写 transcript + 回灌消息。这样 context 边界保持纯。

调用流：

```text
AgentLoop 流式遇到 prompt_too_long
  ↓
context.recoverFromModelError({ error, messages, hasAttemptedCompact })
  ↓
返回 { type: "truncate_head_and_retry", keepRatio: 0.5, reason: "ptl-first-attempt" }
  或 { type: "give_up", reason: "..." }
  ↓
AgentLoop 自己执行：
  - 切尾 messages（保留尾部 keepRatio 比例）
  - 调 dependencies.model.stream() 让 CompactionEngine.summarize 生成摘要
  - context.applyToolResults / 写 control_boundary 到 transcript
  - hasAttemptedCompact=true 重试一轮
```

实现：

- **`ContextRecoveryDecision` shape**（决策 §3.2）：

  ```ts
  export type ContextRecoveryDecision =
    | { type: "truncate_head_and_retry"; keepRatio: number; reason: string }
    | { type: "give_up"; reason: string };
  ```

  唯一动作只有 `truncate_head_and_retry`；其它错误（auth / quota / unknown）由 loop 通过 `AgentRecoveryPolicy` 处理或直接 turn_failed。

- `ContextRuntime.recoverFromModelError(input)`：

  ```ts
  recoverFromModelError(input: {
    error: CanonicalModelError;
    messages: CanonicalMessage[];
    hasAttemptedCompact: boolean;
  }): Promise<ContextRecoveryDecision>;
  ```

  规则：
  - `error.code === "prompt_too_long"` 且 `hasAttemptedCompact === false` → `truncate_head_and_retry, keepRatio: 0.5, reason: "ptl-first-attempt"`
  - `error.code === "prompt_too_long"` 且 `hasAttemptedCompact === true` → `truncate_head_and_retry, keepRatio: 0.25, reason: "ptl-second-attempt-aggressive"`（§3.1 #8 + legacy `truncateHeadForPTLRetry` 25% 切头逻辑）
  - 其它 error code → `give_up, reason: "non_recoverable: {code}"`
  - **不做第三次重试**：第二次 PTL 失败后 loop 必须 turn_failed（§3.1 #8 single-shot 严格化）

- `TokenBudgetManager`（Phase 3 已有，这里加 blocking limit / warning state，对齐 legacy `calculateTokenWarningState`）。
- `CompactionEngine`（**由 AgentLoop 持有，不在 ContextRuntime 接口里**）：
  - 构造：`new CompactionEngine({ model: AgentModelRuntime, tokenBudget: TokenBudgetManager, lifecycle?: LifecycleRuntime, ... })`
  - `summarize(messages)`：
    1. 调 `lifecycle?.dispatch({ event: "PreCompact", payload: { trigger, preTokens } })`。
    2. 调 `model.stream()`；systemPrompt 写死（§3.1 #2）；max output 20k；fork 路径列 deferred。
    3. 调 `lifecycle?.dispatch({ event: "PostCompact", payload: { status: "success" \| "error", error?, summaryTokens } })`。
    4. **不**触发 `UserPromptSubmit` / `Stop` / `StopFailure`（决策 §3.2 compact lifecycle）；compact 失败的 `Stop` / `StopFailure` 由 AgentLoop 在最终 turn 失败时统一触发，避免事件递归。
  - `writeBoundary(transcript, metadata)` 写 `control_boundary` 到 transcript。
  - `buildPostCompactMessages(result)` 顺序：`boundaryMarker → summary → keep → attachments → hookResults`（§3.1 #9）。
  - `truncateHead(messages, keepRatio)` 切除头部，single-shot。
- `AutoCompactionPolicy`：阈值 80% maxContextTokens 触发（对齐 legacy 经验值）。`AgentLoop` 在每次 `prepareForModel` 后调用，决定是否在发送前主动 compact。
- `MicroCompactionEngine` 第一版：
  - **time-based path 直接改写本地 tool_result**。
  - cached path / `cache_edits` 列 intentional_difference + deferred。
- `ContextOverflowRecovery` = `recoverFromModelError` 的实现，依靠 `hasAttemptedCompact` 状态由 `AgentLoop` 在 turn 内传入。

测试：

- threshold 决策（80% / 95% / 100% 三档）。
- compact boundary transcript entry 写入正确。
- post-compact messages 顺序对齐 legacy `buildPostCompactMessages`。
- recovery 不死循环：第一次 PTL → keepRatio 0.5；第二次 PTL → keepRatio 0.25；第三次 PTL → loop 收到 `give_up` 必须 turn_failed。
- microcompact time-based 改写后 token count 显著下降。
- ContextRuntime mock 不持有 model：在测试里 `recoverFromModelError` 是纯函数，loop 拿到 decision 后行为独立可断言。

### Phase 6：Memory / Extension Context

**前置依赖**（决策 §3.2 + extension owner 反馈）：
- 等 extension owner 提供 `PluginRuntime.getAllCommands()` / `getAllSkills()` 聚合 getter；如未到位，`ExtensionResolver` 暂用 `runtime.snapshot().flatMap` 顶上，并标 TODO link 到 extension owner 的 issue。
- MCP server 实际连接 / instructions 读取的能力来自后续 MCP runtime；`listMcpInstructions()` Phase 6 直接返回 `[]` + diagnostic，等 MCP runtime 接入再实装。
- `ExtensionSnapshot` API 落地后，`ExtensionResolver` 改为读 snapshot 的 contribution view（避免 context 跟 PluginRuntime 强耦合）。

实现：

- `MemoryResolver` 完整版接到 `PromptAssembler.memorySection()`：
  - `EdgeClawMemoryProvider.retrieve()` 失败给 diagnostic，不 throw。
- `RelevantMemoryResolver`：基于 EdgeClaw retrieve 输出 + 当前 turn user message。
- compact 后的 memory 重新注入：
  - 由 `CompactionEngine.buildPostCompactMessages` 通过 `attachments` 槽位调用 `MemoryResolver`，**不让 PromptAssembler 单方面在 prepareForModel 里加**（§4.5.1）。
- `ExtensionResolver` 接口（context 模块定义，extension 模块提供实现 / data source）：
  ```ts
  export interface ExtensionResolver {
    listCommands(): ContributedCommand[];      // 来自 PluginRuntime.getAllCommands()
    listSkills(): ContributedSkill[];          // 来自 PluginRuntime.getAllSkills()
    listMcpInstructions(): McpServerInstruction[];  // Phase 6 返回 []
  }
  ```
  `ContributedCommand` / `ContributedSkill` 是 context 自己定义的轻量接口（`{ name, description?, content?, namespace? }`），**不**导出 `PolitDeckLoadedPlugin`。
- PromptAssembler 的 Section 1 `tool catalog` / Section 3 `available commands` / Section 3 `available skills` 子段消费 `ExtensionResolver` 输出。
- `McpResourceResolver`：依赖 MCP runtime 实装；Phase 6 仅 wire-name skeleton。

测试：

- memory dedupe（同一 memory 不重复注入）。
- compact 后 memory 通过 attachments 重新注入，且顺序正确。
- EdgeClaw retrieve 失败时整个 prepareForModel 仍然成功（含 diagnostic）。
- ExtensionResolver mock 返回 commands/skills，PromptAssembler 在 Section 3 中体现。
- ExtensionResolver mock `listMcpInstructions()` 返回 `[]`，prompt 没有 mcp section（不应 throw）。

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
| `context-tool-result-reference` | `<persisted-output>` XML 字符串 | canonical reference block `{ type: "tool_result_reference", path, originalBytes, preview, mimeType? }` | provider-agnostic schema，避免 XML 解析；§3.1 #6 / §4.4 | release review：若上层 prompt 模板假设 XML 标签需调整 |
| `context-microcompact-time-only` | time-based + cached (`cache_edits`) 双路径 | Phase 5 只做 time-based，cached / Anthropic prompt cache 编辑路径列 deferred | PolitDeck 暂不暴露 prompt cache 编辑 API；§3.1 #5 / §4.7 | 大对话 cache 命中率低于 legacy；release review 时升级 |
| `context-no-forked-agent-summary` | summary 优先 `runForkedAgent` 复用主线 prompt cache | PolitDeck 复用 `AgentModelRuntime.stream()`，不做 fork | 不暴露 fork primitive；§3.1 #2 | summary cost 略高 |
| `context-image-no-resize` | `image-processor-napi` / `sharp` resize+downsample | Phase 4 第一阶段原图 base64 直传 | 不引图像处理依赖；§3.1 #10 | 大图被 provider 拒绝；release review |
| `context-pdf-page-estimate` | `pdfinfo` (poppler) 子进程获取页数 | Phase 4 按 100KB/页估算 | 不引 poppler 依赖；§3.1 #10 | 估算偏差 |
| `context-reactive-compact-single-shot` | legacy `tryReactiveCompact` 内部 retry 计数（vendor 缺失） | 严格 single-shot 布尔 guard | vendor 缺源码无法对照；§3.1 #8 | 复杂场景下 PTL 提前 turn_failed |
| `context-prompt-self-authored` | legacy `getSystemPrompt()` 文案是 Claude 产品工程的 prompt | PolitDeck 自写精简版 system prompt，保留全部信息槽（tool catalog / cwd / git / env / mcp instructions / commands / skills），文案不抄 | 避免 prompt 工程归属问题，且 PolitDeck 是不同产品身份；review 决策 2026-05 | 模型行为可能与 Claude Code 不同，需要在 dual parity 中验证（信息槽完整即视为 parity ok，文案差异不计） |
| `context-recovery-truncate-only` | legacy reactive compact 包含 collapse drain + reactive compact + max output recovery 多种动作 | PolitDeck `ContextRecoveryDecision` 唯一动作 `truncate_head_and_retry`，其它情况由 loop 通过 `AgentRecoveryPolicy` 处理或 turn_failed | 简化 recovery state machine，避免引入 collapse store；review 决策 2026-05 | 部分场景（如 single message 超长）可能直接失败而 legacy 会再尝试 |
| `context-no-model-dependency` | legacy compact 直接在 query 路径里调 model | PolitDeck `ContextRuntime` 接口零 model 依赖；`CompactionEngine` 由 `AgentLoop` 持有；context 通过 `recoverFromModelError` 返回决策，loop 帮调 model | 保持 context 模块边界纯，不污染 ContextRuntime；review 决策 2026-05 | loop 多承担一点编排逻辑 |
| `context-extension-resolver-readonly` | legacy 没有 ExtensionResolver 概念，直接在 query 里用 `mcpClients` / `commands` / 多个 helper | PolitDeck context 通过 `ExtensionResolver` 三个只读方法消费 plugin 派生信息；不做独立 registry，未来读 extension owner 的 `ExtensionSnapshot` | 保持 context 单向依赖 extension；extension owner 反馈 2026-05 | 等 `ExtensionSnapshot` 落地前用 `PluginRuntime.getAllCommands()/getAllSkills()` 顶替 |

## 11. Deferred Register

| ID | Behavior | Phase | Release gate |
| --- | --- | --- | --- |
| `context-precondition-error-codes` | `CanonicalModelErrorCode` (PTL/RTL/MOR) + provider 解析 | Phase 1.5 | Phase 5 启动前 |
| `context-precondition-thinking-signature` | `CanonicalThinkingBlock.signature` + anthropic stream `signature_delta` | Phase 1.5 | Phase 2 启动前 |
| `context-precondition-control-boundary` | `JsonlTranscriptWriter.recordControlBoundary` + replay 跳过 | Phase 1.5 | Phase 5 启动前 |
| `context-precondition-tool-results-dir` | `ProjectSessionStorage.toolResultsDir` | Phase 1.5 | Phase 3 启动前 |
| `context-prompt-assembler` | default/user/system prompt assembly | Phase 2 | model request parity |
| `context-message-projector` | normalize/reorder/strip/merge messages + boundary slicing | Phase 2 | provider request parity |
| `context-tool-result-budget` | aggregate tool result budget and persistence | Phase 3 | long tool output release |
| `context-attachments` | file/image/PDF/IDE/MCP resources | Phase 4 | multimodal/IDE release |
| `context-input-processor` | slash/local command/input expansion | Phase 4 | CLI release |
| `context-token-budget` | char/4 token estimation + warning state + blocking limit | Phase 5 | long-session release |
| `context-real-tokenizer` | 真实 tokenizer (`anthropic.beta.messages.countTokens` / tiktoken) | post-Phase 5 | tokenizer parity |
| `context-manual-compact` | manual compact summary | Phase 5 | `/compact` release |
| `context-auto-compact` | autocompact threshold and circuit breaker | Phase 5 | long-session release |
| `context-microcompact-cached` | cached microcompact / `cache_edits` 路径 | post-Phase 5 | prompt cache 编辑 API 接入后 |
| `context-reactive-compact` | prompt-too-long/media recovery（single-shot guard） | Phase 5 | recovery parity |
| `context-snip-compact` | history slicing | Phase 5 后期 | history scale release |
| `context-memory-pipeline` | memory retrieve + post-compact reinject | Phase 6 | memory release |
| `context-memory-claudemd-discovery` | legacy `CLAUDE.md` / nested memory file 自动发现 | post-Phase 6 | legacy memory 兼容期 |
| `context-extension-contrib` | plugin/skill prompt contributions | Phase 6 | extension release |
| `context-mcp-resource-injection` | MCP `@server:uri` attachments | Phase 6 | MCP client 接入后 |
| `context-mcp-instructions` | `ExtensionResolver.listMcpInstructions()` 真实数据 | Phase 6 | MCP runtime / connection layer 落地后 |
| `context-extension-snapshot` | 改读 extension owner 提供的 `ExtensionSnapshot` 而非 `PluginRuntime.snapshot()` | post-Phase 6 | extension owner 上线 `ExtensionSnapshot` |
| `context-slash-command-dispatch` | 把 `/foo` 解析 / dispatch 完整接通 `extension.commands` | Phase 4 | extension owner 提供 `getAllCommands()` |
| `context-compact-failed-event` | 是否新增 `CompactFailed` lifecycle event | post-Phase 5 | parity 或产品确实需要单独匹配失败时 |
| `context-ide-attachments` | IDE selection / diagnostics | post-Phase 6 | IDE adapter 就位后 |

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
