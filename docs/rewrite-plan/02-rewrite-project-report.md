# 新项目重写总方案报告

本文给出从当前项目能力出发、重新开发一个新项目的总体方案。本文不是重构计划，也不是 MVP 阶段拆分，而是目标架构和完整产品形态的设计报告。

## 总体判断

从当前项目的 agent loop 复杂度看，直接在旧目录上重构很难获得真正的新架构。更合理的方案是：

```text
先把现有核心能力规格化
  -> 再围绕 agent runtime 重新设计产品内核
  -> 最后用适配层承载 CLI、UI、SDK、MCP、插件和存储
```

新项目命名为 `PilotDeck`，应追求核心行为一致，而不是代码结构一致或文件命名一致。

核心行为一致包括：

- 多 turn 会话。
- 模型流式输出。
- 工具调用循环。
- 工具权限和安全控制。
- 工具结果回填。
- 上下文预算和压缩。
- session transcript 和恢复。
- SDK/headless 与交互式 UI 共用运行时。
- 扩展能力以稳定接口进入 runtime。

## 目标架构

建议新项目采用以 `agent` 为中心的分层架构：

```text
src/
  pilot/
    config/              配置加载、合并、热更新分类、PilotConfigStore

  agent/
    session/             AgentSession
    turn/                TurnRunner
    loop/                AgentLoop 状态机
    sub/                 子 agent 委派
    protocol/            AgentEvent、AgentTurnResult、AgentLoopTransition、errors
    runtime/             AgentRuntimeDependencies

  model/
    catalog/             模型目录
    config/              模型配置
    protocol/            CanonicalMessage、CanonicalModelEvent、CanonicalToolCall
    providers/           Anthropic / OpenAI-compatible adapter
    request/             请求构造
    response/            响应解析
    streaming/           流式事件归一化
    structuredOutput/    结构化输出
    errors/              错误分类

  context/
    prompt/              系统提示词组合
    memory/              Memory 解析
    attachments/         附件处理
    compaction/          CompactionEngine（PreCompact/PostCompact lifecycle）
    budget/              Token 预算
    input/               输入处理
    instructions/        Instructions 加载
    projection/          上下文投影
    extension/           扩展上下文注入
    recovery/            上下文溢出恢复
    protocol/            上下文协议类型

  tool/
    registry/            ToolRegistry
    scheduler/           ToolScheduler
    execution/           ToolRuntime（PreToolUse/PostToolUse lifecycle 集成）
    builtin/             内置工具
    elicitation/         Elicitation 通道
    audit/               工具审计
    protocol/            PilotDeckToolResult、PilotDeckToolProgressEvent

  permission/
    policy/              PermissionPolicy
    decision/            PermissionDecision runtime
    protocol/            权限协议类型

  lifecycle/
    protocol/            PilotDeckLifecycleHookEvent、LifecycleDispatchInput/Result、effects、errors
    runtime/             LifecycleRuntime、LifecycleDispatcher、LifecycleObserver

  extension/
    hooks/
      protocol/          PilotDeckHookEvent、input、output、settings
      config/            parseHooksConfig、matchHook、matchHookCondition
      execution/         HookRuntime、Command/Prompt/Http/Agent/Callback HookExecutor、AsyncHookRegistry
      events/            HookExecutionEventBus
    plugins/
      protocol/          manifest、plugin、marketplace、errors
      loading/           PluginLoader、PluginHookLoader、PluginCommandLoader
      runtime/           PluginRuntime、PluginReloadPolicy
    skills/              技能管理 CRUD
    contributions/       HookContribution、PromptContribution、RouterContribution
    protocol/            contribution、source、errors

  session/
    transcript/          TranscriptReplay
    resume/              会话恢复
    storage/             会话存储
    filesystem/          文件系统后端
    metadata/            会话元数据
    worktree/            Worktree 管理

  gateway/
    protocol/            GatewayEvent、Gateway 接口、WsFrame
    client/              InProcessGateway、GatewayWsClient、RemoteGateway
    server/              GatewayWsConnection
    elicitation/         GatewayElicitationChannel
    permission/          createGatewayPermissionHook（callback hook 桥接）

  router/
    protocol/            RouterEvent、RouterDecision
    config/              路由配置
    scenario/            场景匹配
    fallback/            Fallback 链
    orchestrate/         编排
    retry/               重试策略
    tokenSaver/          Token 节省
    customRouter/        自定义路由
    session/             会话级路由状态
    stats/               统计

  mcp/
    client/              MCP 客户端
    protocol/            MCP 协议类型
    runtime/             MCP 运行时

  always-on/
    protocol/            AlwaysOnEventPhase、AlwaysOnPhaseEvent
    runtime/             DiscoveryFire
    storage/             AlwaysOnEventStore
    config/              Always-On 配置
    workspace/           工作区管理
    tool/                Always-On 工具
    web/                 AlwaysOnRunHistoryService
    contracts/           Always-On 契约

  cron/
    protocol/            CronTask 类型
    runtime/             CronRuntime
    storage/             CronTaskStore（appendRunEvent）
    config/              Cron 配置
    tool/                Cron 工具

  task/
    protocol/            任务类型
    runtime/             TaskRuntime
    storage/             任务存储

  cli/                   pilotdeck CLI、createLocalGateway、ExtensionWatchManager

  web/
    client/              WebGatewayEvent、GatewayBrowserClient
    server/              Web 服务端

  adapters/
    channel/
      cli/               CLI 渲染
      tui/               TUI 渲染（Ink）
      feishu/            飞书渲染
    web/                 Web adapter
```

依赖方向：

```text
adapters/channel (cli, tui, feishu)
  -> gateway
    -> agent
      -> model
      -> context
      -> tool
      -> permission
      -> session
      -> lifecycle -> extension/hooks
      -> extension/plugins
    -> router -> model
    -> extension (snapshot contributions)

cli (pilotdeck server)
  -> gateway
  -> pilot/config (PilotConfigStore)
  -> extension (ExtensionWatchManager)
  -> lifecycle

web (browser UI)
  -> gateway (via WS client)

always-on / cron
  -> gateway (submitTurn)
  -> session (transcript/storage)
```

`agent` 可以依赖抽象接口，但不应依赖具体 CLI、React/Ink、文件系统实现、MCP transport 或 telemetry SDK。`gateway` 是所有外部消费者的统一入口。

## 核心模块设计

### Gateway

`Gateway` 是所有外部消费者（CLI、TUI、Web、SDK）的统一入口接口。

职责：

- 接收 turn 请求，分发给内部 `AgentSession`。
- 将 `AgentEvent` 投影为 `GatewayEvent` 流式返回。
- 管理会话列表、新建、恢复、关闭。
- 桥接 Elicitation（工具问用户）和 Permission（权限请求）的 host 回调。
- 代理配置重载、Cron 调度、技能管理等 RPC。
- 通过 `WsNotificationFrame` 广播跨会话通知（如 `config_changed`）。

当前实现：

- `InProcessGateway`：进程内嵌入，直接持有 session factory、lifecycle runtime、router。
- `GatewayWsClient` + `GatewayWsConnection`：通过 WebSocket 连接远端 Gateway server。
- `RemoteGateway`：远端 Gateway 的客户端封装。

接口定义于 `src/gateway/protocol/types.ts`：

```text
Gateway.submitTurn(input) -> AsyncIterable<GatewayEvent>
Gateway.abortTurn({ sessionKey, runId? })
Gateway.listSessions(input) -> ListSessionsResult
Gateway.resumeSession({ sessionKey }) -> { sessionKey }
Gateway.newSession(input) -> { sessionKey }
Gateway.closeSession({ sessionKey, reason? })
Gateway.respondElicitation(input) -> { delivered }
Gateway.permissionDecide(input) -> { delivered }
Gateway.reloadConfig?() -> ReloadConfigResult
Gateway.skillsList?(input) -> SkillsListResult
...cron RPCs
```

### AgentSession

`AgentSession` 是产品的会话根对象。

职责：

- 创建 turn。
- 保存 session state。
- 管理 transcript。
- 暴露 `AgentEvent` 流。
- 管理 abort。
- 支持 resume。
- 在 session 生命周期触发 lifecycle dispatch（`SessionStart`、`Setup`、`SessionEnd`）。
- 注入工具、模型、权限、上下文、lifecycle 和扩展运行时。

当前接口：

```text
AgentSession.submit(input, options) -> AsyncIterable<AgentEvent>
AgentSession.abort(reason)
```

`resume` 由 `createAgentSession` 工厂和 `TranscriptReplay` 协同完成，不在 `AgentSession` 实例方法上。

### TurnRunner

`TurnRunner` 执行一次用户输入对应的完整 turn。它负责调用输入处理、构造 turn context、调用 agent loop、将事件写入 transcript、统计 usage 和错误，并产出最终结果。

### AgentLoop

`AgentLoop` 是最核心的状态机。它负责准备模型请求、消费模型流、识别工具调用、触发工具调度、回填工具结果、判断继续或结束，并调用上下文恢复策略。

它只处理抽象事件，不直接操作 UI、文件、数据库或 shell。

### Model

`model` 负责模型请求的标准化和 provider 适配。

能力：

- Anthropic/OpenAI/本地模型等 provider 接入。
- 校验和消费全局 config 模块从 `~/.pilotdeck/pilotdeck.yaml` 读取出的 `model` 配置段。
- 支持 URL、API key、协议格式、默认模型、headers、timeout、model list、model 级 capabilities 和 multimodal input constraints 等配置项。
- 当前阶段不实现 OAuth 登录，但配置结构保留未来扩展认证方式的空间。
- 基于 canonical protocol 进行请求和响应转换，避免 agent loop 绑定某个厂商 SDK 类型。
- 流式事件归一化。
- fallback model。
- thinking block。
- tool schema。
- request metadata。
- retry 和错误分类。

### Tool

`tool` 负责工具定义、调度和执行。

能力：

- ToolRegistry。
- ToolScheduler。
- ToolExecutor。
- StreamingToolExecutor。
- MCPToolAdapter。
- BuiltinToolPack。
- 工具 progress。
- 工具错误归一化。

### Permission

`permission` 是安全边界。

能力：

- policy rule。
- permission mode。
- path/shell/network safety。
- allow/deny/ask。
- interactive adapter。
- headless adapter。
- audit log。

权限判断必须在工具执行前完成，并允许修改输入。

### Context

`context` 负责每次模型请求前后的上下文治理。

能力：

- PromptAssembler。
- MessageProjector。
- TokenBudgetManager。
- ToolResultBudget。
- CompactionEngine。
- MemoryResolver。
- AttachmentResolver。
- ContextOverflowRecovery。

它对 agent loop 暴露统一接口：

```text
prepareForModel(turnState) -> ModelContext
recoverFromModelError(error, turnState) -> RecoveryDecision
applyToolResults(results, turnState) -> TurnState
```

输入附件、IDE selection、memory、MCP resources 和其他 context attachments 由 `context` 解析、裁剪和投影为 canonical messages。`model` 不接收独立 attachments 字段，只消费 `Context.prepareForModel()` 产出的 canonical messages。

### Session

`session` 负责持久化和恢复。

能力：

- transcript append。
- event log。
- compact boundary。
- tombstone。
- replay。
- resume。
- migration。

存储后端可以是文件、SQLite、远端服务或内存。

### Extension

`extension` 统一管理插件、技能、hook、MCP contributions。

扩展只能贡献声明式能力：

- tools。
- commands。
- prompt fragments。
- hooks。
- resources。
- permission rules。
- renderers。

扩展不应直接操作 agent loop 内部状态。

## 总体运行流程

新项目的完整 turn 应按以下方式运行：

```text
AgentSession.submit(input)
  -> InputProcessor.parse(input)
  -> TranscriptStore.append(input accepted)
  -> Extension.collectContributions()
  -> Context.prepareInitialContext()
  -> emit turn.started
  -> AgentLoop.run()
      -> Context.prepareForModel()
      -> Model.stream()
      -> emit model events
      -> Tool.detectToolCalls()
      -> Permission.decide()
      -> Tool.execute()
      -> emit tool events
      -> Context.applyToolResults()
      -> decide continue / complete / recover
  -> TranscriptStore.append(final result)
  -> emit turn.completed
```

## 与旧项目能力的对应关系


| 旧项目能力                    | 新项目归属                                   |
| ------------------------ | --------------------------------------- |
| `QueryEngine`            | `AgentSession` + `TurnRunner`           |
| `query.ts`               | `AgentLoop`                             |
| `services/tools/*`       | `tool`                                  |
| `Tool.ts`                | `ToolDefinition` + `ToolRuntimeContext` |
| `useCanUseTool.tsx`      | `permission` + Gateway permission hook  |
| `services/compact/*`     | `context/compaction`                    |
| `sessionStorage.ts`      | `session/transcript`                    |
| `processUserInput`       | `context/input`                         |
| `commands.ts`            | `extension/contributions`               |
| `tools.ts`               | `tool/registry`                         |
| `services/mcp/*`         | `mcp/`                                  |
| `skills/*` / `plugins/*` | `extension/plugins` + `extension/skills` |
| `screens` / `components` | `adapters/channel/tui`                  |
| `utils/hooks.ts`         | `extension/hooks/execution`             |
| `utils/hooks/hookEvents` | `extension/hooks/events`                |
| `utils/hooks/AsyncHookRegistry` | `extension/hooks/execution/AsyncHookRegistry` |
| `utils/plugins/*`        | `extension/plugins/loading`             |
| Gateway / submission     | `gateway/` + `cli/createLocalGateway`   |
| Router / fallback        | `router/`                               |


## 关键设计原则

### 以行为协议替代源码结构

不要复刻旧项目的目录、文件和函数组织。应复刻的是协议：

- turn event。
- model event。
- tool call/result。
- permission decision。
- context boundary。
- transcript record。

### Loop 内核保持纯粹

agent loop 不应直接知道：

- React/Ink。
- CLI 参数。
- 具体文件系统。
- 具体 shell 实现。
- telemetry SDK。
- MCP transport。
- 插件加载细节。

这些都通过接口注入。

### 工具和权限不可分离

每次工具调用必须绑定权限决策。工具执行器不应绕过 `permission` 模块。

### 权限模式必须覆盖原项目核心模式

新项目必须明确支持当前项目中的三种核心权限模式：`default`、`plan`、`bypassPermissions`。

- `default`：保持原项目默认权限语义。工具调用按照配置规则、工作区边界、工具类型和 allow/deny/ask 规则判断；读类工具更容易通过，写类、shell、副作用类工具可能触发确认或拒绝。
- `plan`：保持原项目计划模式语义。agent 偏向提出计划而不是直接修改；与 `ExitPlanMode` / `ExitPlanModeV2` 等退出计划机制配合；计划审批会影响后续工具是否可执行。
- `bypassPermissions`：保持原项目绕过权限语义。该模式减少或绕过确认环节，使工具执行阻塞最少；同时必须保留模式标识、审计记录和可被上层入口显式启用的约束。

这三种模式要进入 `PermissionConfig` 和 `Permission.decide()` 的核心状态机，而不是作为 CLI 参数或 UI 特例处理。

### 上下文治理是运行时能力

compact、tool result budget、memory、attachments 不是 prompt 拼接细节，而是 agent 能长期稳定工作的核心能力。

### Transcript 是事实来源

UI 状态、SDK replay、resume 都应从 transcript 或 event log 推导。不要让 UI 状态成为会话事实来源。

### PilotDeck 全局命名与路径

重写后项目的产品名、运行时命名空间和用户级路径应统一为 `PilotDeck` / `Pilot`。凡是集中管理配置、记忆、会话、缓存、扩展目录的全局变量、常量或对象，都应使用 `Pilot` 前缀，避免沿用旧项目命名或通用 `Claude` / `Agent` 前缀。

建议建立 `src/pilot/paths` 或等价模块统一导出：

```text
PilotHome = ~/.pilotdeck
PilotConfigPath = ~/.pilotdeck/pilotdeck.yaml
PilotMemoryDir = ~/.pilotdeck/memory
PilotSessionDir = ~/.pilotdeck/sessions
PilotCacheDir = ~/.pilotdeck/cache
PilotExtensionDir = ~/.pilotdeck/extensions
```

业务模块只依赖这些集中常量或解析函数，不直接拼接 `~/.pilotdeck` 下的具体文件路径。

### 扩展只能贡献能力，不能侵入内核

插件、技能、MCP、hook 都必须通过 contribution 进入系统。

### Agent / Context / Tool / Extension 等价实现

`agent`、`context`、`tool`、`extension` 四个模块应以当前项目能力为准做等价重写，不以创新为目标。

这些部分在当前项目中已经形成了优秀的产品行为和工程边界。重写目标是保持能力一致、协议一致和用户体验一致：

- `agent` 保持当前多 turn agent loop、tool_use/tool_result 回填、streaming event、interrupt/recovery、subagent 嵌套等核心行为。
- `context` 保持当前 system prompt/user context/system context 组合、memory、attachments、tool result budget、compact boundary、microcompact、autocompact、overflow recovery 等能力；attachments 由 context 解析、裁剪并投影进 canonical messages，不作为 model 模块的独立输入。
- `tool` 保持当前工具 schema、工具注册、输入校验、串并行调度、streaming tool execution、progress、错误回填、MCP tool 接入等能力。
- `extension` 保持当前 plugins、skills、hooks、commands、MCP contributions、prompt fragments、permission rules 等贡献模型。

重写时允许改变内部代码组织，但不应借机删除或重新发明这些模块的核心行为。

## 总体技术建议

### 语言和运行环境

当前根项目已经使用 TypeScript + 标准 ESM，并通过 npm scripts 调用 `tsc` 与 Node test runner。后续建议：

- 以根 `package.json` 为准使用 `npm run build` 和 `npm test`。
- 旧项目 parity probe 如依赖 vendored Bun 脚本，应限制在对应 legacy harness 内，不作为新项目运行时假设。
- 使用标准 ESM。
- 使用 `zod` 或类似 schema 库定义工具输入。
- 使用 async iterable 作为统一流式协议。

### Agent Loop 底座选择

Agent loop 底座选择改为自研。新项目不依赖 Claude Agent SDK、pi-agent 或其他高层 agent SDK 托管核心 loop。

原因：

- 当前项目的核心能力本身不是通过外部 Claude Agent SDK 高层封装实现，而是在项目内部实现了 `QueryEngine`、`query()`、工具执行、权限、上下文治理和 session runtime。
- 新项目需要控制不同运行模式、权限模式、生命周期、上下文压缩、工具调度和 transcript 语义；这些能力如果绑定到外部 agent SDK，后续会被 SDK 的协议、状态机和扩展点限制。
- 新项目需要 provider-neutral 的长期演进能力，包括 Anthropic、OpenAI-compatible、pi-agent、本地模型和未来模型协议。
- 新项目需要把不同入口模式和权限模式纳入自己的 runtime，而不是适配某个 SDK 的既定抽象。

自研范围包括：

```text
AgentSession / TurnRunner / AgentLoop
Gateway（InProcessGateway / GatewayWsClient / RemoteGateway）
Router（场景路由、fallback、重试、token saver）
Model（provider adapter、canonical protocol、streaming）
Tool（registry、scheduler、execution、elicitation）
Permission（policy、decision）
Context（prompt、memory、compaction、budget、recovery）
Session（transcript、resume、worktree）
Lifecycle（LifecycleRuntime、LifecycleDispatcher）
Extension（hooks、plugins、skills、contributions）
MCP（client、runtime）
Always-On / Cron（发现、编排、存储）
CLI / Web / TUI / Feishu adapters
```

Claude Agent SDK、pi-agent 或其他 SDK 的定位应调整为：

- 作为行为参考：学习其 agent loop、hooks、sessions、MCP、subagents 等成熟设计。
- 作为 provider adapter 的可选实现：在特定场景下调用外部 SDK，但不托管主 runtime。
- 作为兼容层：用于迁移或对接外部生态，而不是作为核心架构依赖。

最终目标是由新项目自有的 `AgentLoop` 决定 turn 状态机、事件流、工具执行、权限决策、上下文治理、恢复和持久化。

### 模型协议转换

新项目不应把 Anthropic 消息协议直接作为内部唯一协议。建议定义 canonical protocol：

```text
CanonicalMessage
CanonicalToolSchema
CanonicalToolCall
CanonicalToolResult
CanonicalModelEvent
CanonicalUsage
CanonicalError
```

不同 provider 通过 adapter 转换：

```text
AnthropicAdapter
OpenAICompatibleAdapter
PiAgentAdapter
LocalModelAdapter
```

能力差异通过 `ModelCapabilities` 和 multimodal constraints 声明。`ModelCapabilities` 表达 tool use、parallel tool calls、thinking、prompt cache、JSON schema、最大上下文和最大输出 token 等通用能力；multimodal constraints 用字符串列表和限制项表达输入模态，例如 `input: ["text", "image", "pdf"]`、`maxImagesPerRequest` 和 `supportedImageMimeTypes`。

Model 模块的详细设计见 `[../model/](../model/)`。

### 配置系统

与 agent loop 紧密相关的配置应收敛到 `~/.pilotdeck/pilotdeck.yaml` 这一份总配置中，由全局 config 模块读取和拆分，而不是散落在 CLI 参数、环境变量和全局 state 中。

配置应至少包括：

- `ModelConfig`：provider、model、thinking、temperature、effort、fastMode、taskBudget、model list、model capabilities、multimodal input constraints；fallback 链由 `router.fallback` 管理。
- `LoopConfig`：maxTurns、streamingToolExecution、toolConcurrencyLimit、continueOnToolError、abortTimeoutMs。
- `ContextConfig`：maxContextTokens、autoCompact、compactThreshold、toolResultBudget、memoryEnabled、contextOverflowRecovery。
- `ToolConfig`：enabledTools、disabledTools、toolPresets、mcpServers、shellTimeout、fileReadLimit、globResultLimit。
- `PermissionConfig`：permissionMode、workspaceRoots、alwaysAllow、alwaysDeny、alwaysAsk、readOnlyMode、headlessAskBehavior。其中 permissionMode 必须至少覆盖 `default`、`plan`、`bypassPermissions`。
- `SessionConfig`：sessionId、transcriptEnabled、resumeEnabled、storageBackend、flushPolicy。
- `ExtensionConfig`：hooksEnabled、pluginsEnabled、skillsEnabled、extensionDirs、hookTimeout、hookFailurePolicy。

### Hooks 与生命周期

新项目已实现系统化生命周期，基于 `PilotDeckHookEvent` 定义于 `src/extension/hooks/protocol/events.ts`。实际 hook 事件列表：

```text
PreToolUse             工具执行前（可修改 input、决定权限、追加 context）
PostToolUse            工具成功后（可追加 context、更新 MCP 输出、阻止继续）
PostToolUseFailure     工具失败后（可观察 error）
Notification           通知（infrastructure-only，待 Always-On/Feishu 成熟后接入）
UserPromptSubmit       用户 prompt 提交后（可追加 context 或阻止模型请求）
PreModelRequest        模型请求前（可注入 context 或阻止请求）
SessionStart           会话创建/恢复（可追加 context、initial user message、watch paths）
SessionEnd             会话结束（并发执行，短超时）
Stop                   模型停止后（可阻止 continuation、产生 stop reason）
StopFailure            Stop hook 失败
SubagentStart          子 agent 启动
SubagentStop           子 agent 停止
PreCompact             上下文压缩前
PostCompact            上下文压缩后
PermissionRequest      权限请求 ask 场景（hook 可自动 allow/deny）
PermissionDenied       权限拒绝后（可要求 retry）
Setup                  初始化/维护入口
ConfigChange           配置热更新（sessionId 为空，进程/项目级）
InstructionsLoaded     系统指令加载完成
CwdChanged             工作目录变化（@todo，待 Always-On workspace 切换支持）
FileChanged            文件变化（@todo，待 ToolRuntime dispatch 接入）
WorktreeCreate         Worktree 创建
WorktreeRemove         Worktree 移除
Elicitation            MCP server 请求用户输入
ElicitationResult      MCP elicitation 用户回应
```

不迁移的 legacy 事件：`TeammateIdle`、`TaskCreated`、`TaskCompleted`（标记为 `not_applicable`）。

hook 运行语义已明确实现：

- 执行器类型：`command`、`prompt`、`http`、`agent`、`callback`（内部注册）。
- 匹配：`matcher` + `if` 条件过滤。
- hook 不直接修改内部状态，返回 `PilotDeckHookEffect`（additional_context / block / permission_decision / updated_tool_input / worktree_path 等）。
- `LifecycleRuntime.dispatch()` 返回 effects + messages + blockingErrors + nonBlockingErrors。
- 超时策略：代码常量 `PILOTDECK_HOOK_TIMEOUT_MS`（10 min）/ `PILOTDECK_SESSION_END_HOOK_TIMEOUT_MS`（1.5s）。
- hook 失败按 exit code 分类：0=成功、2=blocking、其他=non-blocking error。
- async hook 支持 `AsyncHookRegistry` 注册和 `asyncRewake` marker。
- `HookExecutionEventBus` 广播 hook 执行事件（started/response），受 `includeHookEvents` 配置影响。

### 存储

推荐抽象接口：

```text
TranscriptStore
SessionStore
WorkspaceStateStore
CacheStore
```

默认本地实现可以基于文件或 SQLite，但 runtime 不绑定具体实现。

### 测试

新项目必须从第一天具备 conformance tests：

- fake model 输出 assistant/tool_use。
- fake tool 返回 tool_result。
- fake permission 返回 allow/deny/ask。
- fake context manager 触发 compact/recovery。
- fake transcript 验证写入顺序。

测试对象不是 UI，而是 agent loop 行为协议。model 模块测试文件统一维护在项目根目录 `tests/model/` 下，覆盖配置段解析、Anthropic/OpenAI 请求转换、响应解析、流式事件归一化和错误归一化。其中响应解析、流式解析和 provider 错误归一化使用真实 URL 与 API key 做端到端集成测试；其他配置和请求构造测试优先使用 fixture、fake transport 或 mock。

### 错误模型

错误应标准化：

```text
ModelError
ToolError
PermissionError
ContextOverflowError
UserInterruptError
StorageError
ExtensionError
```

每种错误都要明确是否对用户可见、是否可恢复、是否需要生成 tool_result、是否写 transcript、是否终止 turn。

## 完整产品形态

新项目最终应包含：

- 一个独立 agent 包。
- 一个 CLI adapter。
- 一个 SDK/headless adapter。
- 一个 TUI 或 Web UI adapter。
- 一组内置工具。
- 一个 MCP adapter。
- 一个 extension 模块。
- 一个 transcript/resume 系统。
- 一套权限策略和交互适配器。
- 一套 conformance tests。

产品应允许不同入口共享同一套核心：

```text
CLI.submit()
SDK.submit()
TUI.submit()
Remote.submit()
  -> AgentSession.submit()
```

## 主要风险

### 行为规格不完整

当前项目很多行为隐藏在 feature flag、注释、历史兼容和错误恢复路径中。若只看表层功能，容易漏掉 tool_result 配对、compact boundary、streaming fallback、interrupt recovery 等关键协议。

### 过早做 UI

如果先做 UI，很容易重新把 UI state 写进 runtime。应先稳定事件流和 AgentSession。

### 工具系统低估复杂度

工具不是函数调用。它包含权限、schema、hook、进度、并发、取消、结果归一化和 telemetry。新项目必须把工具系统作为核心模块设计。

### 上下文压缩低估复杂度

长会话能力依赖上下文治理。没有 compact 和预算策略，agent loop 在真实项目中很快会不可用。

### SDK 底座绑定过深

如果业务层直接绑定 Claude Agent SDK 或 pi-agent SDK，后续切换底座会非常困难。必须先建立自己的 `AgentRuntimeProvider` 抽象。

## 总体结论

推荐执行“产品规格化后重写”的方案。

新项目的本质应是：

```text
一个事件驱动、工具可扩展、权限受控、上下文可治理、会话可恢复的 agent runtime。
```

新项目应自研 agent loop 内核，通过 provider adapter、canonical protocol、结构化配置和生命周期系统保留多模型、多入口、多运行模式的演进空间。