# 老项目生命周期、Hooks 与插件系统分析

## 1. 背景

本文件调研 `third-party/claude-code-main` 中与生命周期、hooks 系统和插件模块相关的实现。目标不是复刻旧目录，而是提炼可迁移的产品行为、运行时协议和测试观察点，为 PilotDeck 的 `extension`、`lifecycle`、`hooks`、`plugins` 重写提供输入。

主要参考源：

| 主题 | Legacy 路径 | 说明 |
| --- | --- | --- |
| Hook 事件枚举 | `src/entrypoints/sdk/coreTypes.ts` | `HOOK_EVENTS` 运行时常量 |
| Hook 输入/输出 schema | `src/entrypoints/sdk/coreSchemas.ts`、`src/types/hooks.ts`、`src/schemas/hooks.ts` | SDK serializable protocol 与配置 schema |
| Hook 执行器 | `src/utils/hooks.ts` | command/prompt/http/agent/function hook 的核心执行与聚合 |
| Hook 事件流 | `src/utils/hooks/hookEvents.ts` | started/progress/response 事件广播 |
| 异步 hook 注册表 | `src/utils/hooks/AsyncHookRegistry.ts` | async hook 后台执行、轮询、完成和取消 |
| Session 生命周期 | `src/utils/sessionStart.ts`、`src/main.tsx` | `SessionStart`、`Setup` 触发与插件 hooks 预加载 |
| Stop 生命周期 | `src/query/stopHooks.ts` | 模型停止后运行 Stop/SubagentStop/任务类 hook |
| Tool hooks | `src/services/tools/toolHooks.ts` | PreToolUse/PostToolUse/PostToolUseFailure/PermissionDenied |
| 插件类型 | `src/types/plugin.ts` | `LoadedPlugin`、manifest、component、error 类型 |
| 插件 schema | `src/utils/plugins/schemas.ts` | plugin/marketplace/manifest/hooks/MCP schema |
| 插件发现加载 | `src/utils/plugins/pluginLoader.ts` | marketplace、session plugin、cache、manifest、组件路径 |
| 插件 hook 注册 | `src/utils/plugins/loadPluginHooks.ts` | enabled plugin hooks 转换为 runtime matcher |
| 插件命令 | `src/utils/plugins/loadPluginCommands.ts` | markdown commands/skills 到 slash command 的贡献 |

## 2. 产品能力概览

老项目的扩展系统由三层组成：

- 生命周期事件：在 session、turn、tool、compact、permission、MCP elicitation、配置、工作目录和文件变化等节点触发。
- Hook 运行时：根据 event + matcher + `if` 条件找到 hook，执行 command/prompt/http/agent/callback，解析 JSON 输出并聚合为可观察结果。
- 插件贡献：插件通过 manifest、`commands/`、`agents/`、`skills/`、`hooks/hooks.json`、MCP/LSP/output style 等目录和配置贡献能力。

这三层互相依赖，但边界并不完全分离：`utils/hooks.ts` 既处理配置 hook、插件 hook、SDK callback hook，也负责执行、输出解析、错误转换和部分产品语义。PilotDeck 重写时应拆成更明确的模块。

## 3. 生命周期事件模型

老项目的公开 hook event 由 `HOOK_EVENTS` 定义，覆盖：

```text
PreToolUse
PostToolUse
PostToolUseFailure
Notification
UserPromptSubmit
SessionStart
SessionEnd
Stop
StopFailure
SubagentStart
SubagentStop
PreCompact
PostCompact
PermissionRequest
PermissionDenied
Setup
TeammateIdle
TaskCreated
TaskCompleted
Elicitation
ElicitationResult
ConfigChange
WorktreeCreate
WorktreeRemove
InstructionsLoaded
CwdChanged
FileChanged
```

所有 hook 输入共享基础字段：

```text
session_id
transcript_path
cwd
permission_mode?
agent_id?
agent_type?
```

事件特有字段构成行为契约。例如：

- `PreToolUse`：`tool_name`、`tool_input`、`tool_use_id`。
- `PostToolUse`：包含 `tool_response`，允许 hook 观察工具结果。
- `PostToolUseFailure`：包含 `error`、`is_interrupt`。
- `PermissionRequest`：包含 `permission_suggestions`，允许 hook 自动 allow/deny 并更新权限。
- `SessionStart`：包含 `source: startup | resume | clear | compact`、`agent_type?`、`model?`。
- `Stop` / `SubagentStop`：包含 `stop_hook_active` 与可选 `last_assistant_message`。
- `PreCompact` / `PostCompact`：分别暴露 compact trigger、custom instructions 与 compact summary。
- `Elicitation` / `ElicitationResult`：围绕 MCP server 请求用户输入和用户响应。
- `InstructionsLoaded`、`CwdChanged`、`FileChanged`：把上下文、工作目录和 watch path 变化纳入生命周期。

### 3.1 生命周期触发点

老项目中重要触发点如下：

| 阶段 | 触发点 | 观察行为 |
| --- | --- | --- |
| Setup | init/maintenance 入口 | 可添加 additional context；bare mode 跳过 |
| SessionStart | startup/resume/clear/compact | 先尝试加载插件 hooks；可添加 additional context、initial user message、watch paths |
| UserPromptSubmit | 用户 prompt 被提交后 | 可追加 context，也可阻止继续 |
| PermissionRequest | 工具权限请求时 | hook 可直接 allow/deny，allow 可带 updated input/permission updates |
| PreToolUse | 工具执行前 | 可给出 permission decision、updated input、additional context 或阻止继续 |
| PostToolUse | 工具成功后 | 可追加 context；MCP 工具可被更新输出 |
| PostToolUseFailure | 工具失败后 | 可追加错误上下文、阻止继续或反馈给模型 |
| PermissionDenied | 权限拒绝后 | 可要求 retry |
| Stop/SubagentStop | assistant turn 停止后 | 可阻止 continuation，产生 stop reason 或 summary |
| PreCompact/PostCompact | compact 前后 | 可改写 custom instructions 或显示 compact 结果 |
| SessionEnd | clear/resume/logout/exit 等退出路径 | 并发执行，默认强超时 |

### 3.2 事件可见性

`src/utils/hooks/hookEvents.ts` 把 hook 执行事件分为：

- `started`
- `progress`
- `response`

默认只有 `SessionStart` 和 `Setup` 总是发出。其他 event 只有在 SDK `includeHookEvents` 或 remote mode 打开后才发出。没有 handler 时最多缓存 100 个 pending event。

这说明老项目区分两类可见性：

- 生命周期对 runtime 有效：hook 会运行并影响流程。
- 生命周期对外部观察者可见：hook started/progress/response 是否投影给 SDK/UI。

PilotDeck 需要保留这个区别，不能把 hook 是否执行与是否广播混为一谈。

## 4. Hook 配置模型

`src/schemas/hooks.ts` 定义持久化 hook 配置：

```text
hooks:
  <HookEvent>:
    - matcher?: string
      hooks:
        - type: command | prompt | http | agent
          ...
```

### 4.1 Hook 类型

| 类型 | 关键字段 | 行为 |
| --- | --- | --- |
| `command` | `command`、`shell`、`timeout`、`statusMessage`、`once`、`async`、`asyncRewake` | 执行 shell 命令；stdout 可输出 JSON |
| `prompt` | `prompt`、`model`、`timeout`、`statusMessage`、`once` | 用模型评估 hook prompt |
| `http` | `url`、`headers`、`allowedEnvVars`、`timeout`、`statusMessage`、`once` | POST hook input 到 URL |
| `agent` | `prompt`、`model`、`timeout`、`statusMessage`、`once` | 启动 agentic verifier |
| callback/function | 不持久化 | SDK 或内部注册，用于 REPL context 访问 |

所有持久化 hook 都支持 `if` 条件。`if` 使用 permission rule 语法，如 `Bash(git *)`，在 spawn 前过滤，避免无关 hook 进程启动。

### 4.2 Matcher 语义

老项目存在两层匹配：

- `matcher`：按事件相关值过滤，典型是工具名，如 `Write`。
- hook 内部 `if`：按 permission rule 语法进一步匹配工具名和输入。

插件 hook 通过 `loadPluginHooks.ts` 转换为带 `pluginRoot`、`pluginName`、`pluginId` 的 matcher。session/project/user/settings hook、plugin hook、SDK callback hook 会合并到注册表。

## 5. Hook 输出与聚合语义

Hook stdout 可包含 JSON 输出。`src/types/hooks.ts` 将输出分成同步和异步：

```text
Async:
  { "async": true, "asyncTimeout"?: number }

Sync:
  continue?: boolean
  suppressOutput?: boolean
  stopReason?: string
  decision?: "approve" | "block"
  reason?: string
  systemMessage?: string
  hookSpecificOutput?: ...
```

关键语义：

- `continue: false` 或 blocking decision 会阻止后续流程。
- `suppressOutput` 会隐藏 stdout 对 transcript/用户的可见性，但 debug 仍可能记录。
- `systemMessage` 会作为用户可见 warning 或 system message。
- `additionalContext` 会被收集为 attachment/context，进入后续模型上下文。
- `updatedInput` 可改变工具输入。
- `permissionDecision` 可影响 PreToolUse 权限结果。
- `updatedMCPToolOutput` 只对 MCP 工具结果有效。
- `PermissionRequest` hook 可返回 allow/deny；allow 可附带 updated permissions。
- `SessionStart` hook 可返回 `initialUserMessage` 与 `watchPaths`。
- `PermissionDenied` hook 可返回 `retry`。

聚合结果中的核心字段包括：

```text
message
blockingErrors
preventContinuation
stopReason
permissionBehavior
hookPermissionDecisionReason
additionalContexts
initialUserMessage
updatedInput
updatedMCPToolOutput
permissionRequestResult
retry
```

## 6. 执行、超时与异步语义

### 6.1 同步 hook

同步 hook 会阻塞触发点，直到命令/prompt/http/agent 完成、超时、取消或失败。常见输出：

- exit code 0 + JSON：按 JSON 解析语义处理。
- exit code 2：阻塞错误，通常阻止继续。
- 其他非零：非阻塞错误，转为 attachment/progress，不一定中断主流程。
- 抛错/解析失败：记录错误并返回 hook_error_during_execution 等 attachment。

### 6.2 异步 hook

当 hook 输出 `{ "async": true }` 时，老项目通过 `AsyncHookRegistry` 注册后台 hook：

- 默认 `asyncTimeout` 为 15000ms。
- registry 记录 process id、hook id、hook event、hookName、command、pluginId、toolName、startTime、timeout。
- 后续 `checkForAsyncHookResponses()` 轮询已完成 hook，从 stdout 中找到第一行非 async JSON 作为同步响应。
- 完成后发出 response event，删除 registry 项。
- `finalizePendingAsyncHooks()` 在退出时完成或取消未完成 hook。

`asyncRewake` 是特殊 command hook 语义：后台完成且 exit code 2 时，会把 blocking error 包装为 task notification，唤醒模型或在忙碌时注入 queued command attachment。

### 6.3 SessionEnd 特殊超时

`SessionEnd` hooks 默认超时更短：`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` 可覆盖，默认 1500ms。原因是退出/clear 阶段不能被清理脚本长时间阻塞。

## 7. Tool Hook 语义

`src/services/tools/toolHooks.ts` 把 hooks 挂入工具执行链：

```text
tool call detected
  -> executePreToolHooks
  -> permission / tool execution
  -> executePostToolHooks on success
  -> executePostToolUseFailureHooks on failure
  -> executePermissionDeniedHooks on denied
```

必须保留的观察点：

- PreToolUse 可以修改 input，也可以返回 permission behavior。
- PostToolUse 可以追加 context，MCP 工具可以被更新输出。
- PostToolUse 的 blocking error 会阻止 continuation。
- PostToolUseFailure 可观察 error 和 interrupt 状态。
- hook cancellation 会产生 `hook_cancelled` attachment。
- hook progress 不等于 tool result，通常不进入模型结果块。

## 8. Session 与 Stop 生命周期

### 8.1 SessionStart / Setup

`src/utils/sessionStart.ts` 在执行 `SessionStart` 和 `Setup` 前尝试 `loadPluginHooks()`，但 bare mode 会跳过。加载插件失败不会导致 session 启动失败，而是记录错误并继续执行项目级 hooks。

`SessionStart` 输出的 additional context 会合成 `hook_additional_context` attachment；`watchPaths` 会更新文件变化 watcher；`initialUserMessage` 通过侧通道被消费一次。

### 8.2 Stop / SubagentStop

`src/query/stopHooks.ts` 在 assistant 停止后构造 REPL hook context，包含 messages、system prompt、user/system context、toolUseContext 和 querySource。Stop hooks 可以：

- 产生 progress。
- 产生 blocking error。
- 产生 stop reason。
- 生成 stop hook summary。
- 触发后台 memory、prompt suggestion、auto dream 等非核心工作。

Stop hook 还要处理 `stopHookActive`，避免自身触发导致递归。

## 9. 插件模块

### 9.1 插件结构

`pluginLoader.ts` 注释描述典型插件目录：

```text
my-plugin/
  plugin.json
  commands/
    build.md
    deploy.md
  agents/
    test-runner.md
  hooks/
    hooks.json
```

`LoadedPlugin` 可携带：

```text
commandsPath / commandsPaths
agentsPath / agentsPaths
skillsPath / skillsPaths
outputStylesPath / outputStylesPaths
hooksConfig
mcpServers
lspServers
settings
```

### 9.2 插件来源与缓存

老项目支持：

- marketplace 插件，使用 `plugin@marketplace` 标识。
- session-only 插件，通过 `--plugin-dir` 或 SDK plugins option。
- built-in plugins，source 为 builtin。
- versioned cache：`plugins/cache/{marketplace}/{plugin}/{version}`。
- legacy cache fallback：兼容旧位置。
- seed directories：第一次启动可从 seed cache 探测。

插件加载器负责 marketplace 策略、blocklist、strict known marketplaces、Git/zip/MCPB、manifest 校验、路径安全、重复路径过滤和错误收集。

### 9.3 插件安全策略

`schemas.ts` 包含 marketplace 名称保护：

- 官方名称保留，只允许官方 GitHub 组织来源。
- 阻止 `anthropic`/`claude` 官方冒充模式。
- 阻止非 ASCII 字符，避免 homograph attack。
- 阻止空格、路径分隔符、`..`、`.`。
- `inline` 和 `builtin` 为保留名称。

PilotDeck 需要替换品牌命名，但保留同类防护：官方 marketplace 名称、路径穿越、非 ASCII 冒充、保留 source 名称都必须进入 schema 测试。

### 9.4 插件 hooks 热加载

`loadPluginHooks.ts` 体现了重要产品语义：

- `loadPluginHooks()` memoized，注册 enabled plugin hooks。
- 注册时采用 clear-then-register 的原子替换。
- `clearPluginHookCache()` 只清 memoized cache，不清空当前 registered hooks，避免 Stop hooks 在 reload 前失效。
- `pruneRemovedPluginHooks()` 会立即删除已禁用/卸载插件的 hooks，但新启用插件等待 `/reload-plugins`。
- 热加载比对 `enabledPlugins`、`extraKnownMarketplaces`、`strictKnownMarketplaces`、`blockedMarketplaces`，不只比较 enabled plugins。

这部分是 parity 测试重点：插件变化时旧 hooks 何时仍然生效、何时被移除、何时需要显式 reload。

### 9.5 插件 commands/skills

`loadPluginCommands.ts` 将 markdown 文件转为 command：

- 普通 markdown：命令名由相对路径命名，嵌套目录用 `:` 命名空间。
- `SKILL.md`：命令名使用 skill 目录名；同一目录多个 `SKILL.md` 使用第一个并记录 debug。
- frontmatter 可提供 description、tools、shell、model、argument 等能力。
- content 支持插件变量与用户配置变量替换。

PilotDeck 不应把 commands/skills 当作 hook 特例，而应作为 plugin contributions。

## 10. Legacy 行为分类

| Legacy feature | PilotDeck 归属 | Status | 说明 |
| --- | --- | --- | --- |
| Hook event enum 与 input schema | `src/extension/hooks/protocol` | `compare` | 必须共享场景验证 event 名、基础字段、事件字段 |
| Hooks settings schema | `src/extension/hooks/config` | `compare` | command/prompt/http/agent、matcher、if、timeout、once、async |
| Hook stdout JSON 解析 | `src/extension/hooks/execution` | `compare` | sync/async、continue、decision、additional context、updated input |
| Hook progress/response event | `src/extension/hooks/events` | `compare` | execution events 与 runtime hook effect 分离 |
| SessionStart additional context | `src/lifecycle` + `src/agent` | `compare` | context attachment 与 initial user message |
| Tool hook input mutation | `src/tool` + `src/extension/hooks` | `compare` | PreToolUse 能改变工具输入 |
| PermissionRequest hook | `src/permission` + `src/extension/hooks` | `compare` | 自动 allow/deny 与 permission updates |
| PostToolUse MCP output update | `src/tool/builtin/mcp` + hooks | `deferred` | MCP skeleton 完善后实现 |
| asyncRewake | lifecycle notification/runtime queue | `deferred` | 依赖任务通知队列 |
| Function/callback hooks | SDK adapter | `deferred` | 核心保留接口，具体由 SDK 注入 |
| Plugin marketplace/Git/zip/MCPB install | `src/extension/plugins/marketplace` | `deferred` | 第一阶段可先本地目录和 builtin |
| Plugin hook hot reload | `src/extension/plugins/runtime` | `compare` | enabled/disabled/reload 语义需要固化 |
| Plugin commands/skills discovery | `src/extension/contributions` | `compare` | 目录命名与 markdown frontmatter |
| Legacy telemetry event names | audit/event adapter | `intentional_difference` | 统一改为 PilotDeck 命名 |
| Legacy brand paths `~/.claude` | `src/pilot/paths` | `intentional_difference` | 改为 `~/.pilotdeck` |

## 11. Parity 观察点

后续测试不能只检查类型是否存在，必须比较外部可观察结果：

- 同一 hook event 输入是否包含相同字段和值。
- 同一 hooks config 是否被解析为同样数量、顺序、matcher 和 hook command。
- 同一 PreToolUse hook 输出是否导致相同 permission/input/context 结果。
- 同一 PostToolUse hook 是否产生相同 additional context、blocking error 或 MCP output update。
- 同一 async hook 是否先返回 pending，再在完成后产出 sync response。
- 同一 plugin hooks 变更是否保持旧 hook 到 reload 前仍有效，禁用/卸载后立即移除。
- 同一 plugin command 文件结构是否得到相同 command name、description、allowed tools 和 content。

只有共享场景同时跑 legacy 与 PilotDeck，并比较归一化输出，才能声明 execution parity passed。本文只提出 parity 场景清单和落地约束，不表示当前已经创建测试 fixture 或通过 execution parity。
