# PilotDeck 生命周期、Hooks 与插件重写方案

## 1. 目标

本文基于 `01-legacy-lifecycle-hooks-plugin-analysis.md`，结合当前 `src/` 新项目结构，定义 PilotDeck 生命周期、hooks 与插件系统的重写方案。

当前仓库已经具备：

- `src/agent/`：`AgentSession`、`TurnRunner`、`AgentLoop`、agent events、transcript、resume、context runtime。
- `src/model/`：canonical message、tool call、tool result、stream event 与 provider adapter。
- `src/tool/`：tool definition、registry、runtime、scheduler、audit、内置工具骨架和部分实现。
- `src/permission/`：permission mode、rules、decision runtime。
- `src/pilot/config/`：配置加载、合并、诊断和热更新分类，但当前 `PilotConfig` 只包含 `model`。

目标是在不破坏现有 agent/tool/permission 边界的前提下新增：

```text
src/lifecycle/
src/extension/
  hooks/
  plugins/
  contributions/
```

`agent` 负责在固定生命周期点调用 lifecycle runtime；`extension` 负责提供 hooks/plugins/contributions；`tool` 和 `permission` 只通过接口接收 hook effects，不能直接读取插件目录或全局注册表。

## 2. 设计原则

- 行为优先：保留 legacy 生命周期、hook 输入/输出和插件贡献的外部可观察行为，不迁移旧文件结构。
- 分层明确：lifecycle 只定义事件与调度，hooks 只执行扩展逻辑，plugins 只发现/加载贡献。
- Provider-neutral：hook payload 使用 PilotDeck canonical 类型，不暴露 Anthropic 或 legacy SDK message object。
- 默认安全：插件来源、路径、marketplace 名称、环境变量插值、HTTP hook headers 都必须 schema 校验。
- 可测试：每个 legacy feature 必须分类为 `compare`、`deferred`、`intentional_difference` 或 `not_applicable`。
- 不提前宣称一致：只有 shared scenario 同时运行 legacy 和 PilotDeck 并比较 normalized output，才能写 execution parity passed。

## 3. 目标模块结构

建议新增：

```text
src/lifecycle/
  index.ts
  protocol/
    events.ts
    payloads.ts
    effects.ts
    errors.ts
  runtime/
    LifecycleRuntime.ts
    LifecycleDispatcher.ts
    LifecycleObserver.ts

src/extension/
  index.ts
  protocol/
    contribution.ts
    source.ts
    errors.ts

  hooks/
    protocol/
      events.ts
      input.ts
      output.ts
      settings.ts
    config/
      parseHooksConfig.ts
      matchHook.ts
      matchHookCondition.ts
    execution/
      HookRuntime.ts
      HookExecutor.ts
      CommandHookExecutor.ts
      PromptHookExecutor.ts
      HttpHookExecutor.ts
      AgentHookExecutor.ts
      AsyncHookRegistry.ts
      parseHookOutput.ts
      aggregateHookResults.ts
    events/
      HookExecutionEventBus.ts

  plugins/
    protocol/
      manifest.ts
      plugin.ts
      marketplace.ts
      errors.ts
    config/
      parsePluginManifest.ts
      validatePluginSource.ts
      validateMarketplaceName.ts
    discovery/
      PluginDirectoryResolver.ts
      discoverLocalPlugins.ts
      discoverBuiltinPlugins.ts
    loading/
      PluginLoader.ts
      PluginHookLoader.ts
      PluginCommandLoader.ts
      PluginContributionLoader.ts
    runtime/
      PluginRuntime.ts
      PluginReloadPolicy.ts
      PluginRegistry.ts

  contributions/
    CommandContribution.ts
    HookContribution.ts
    ToolContribution.ts
    PromptContribution.ts
    McpContribution.ts
    PermissionRuleContribution.ts
```

第一批基础测试已按以下目录命名落地。双端 legacy parity runner 仍是后续工作：

```text
tests/lifecycle-hooks-plugins/
  agent-lifecycle.test.ts
  protocol.test.ts
  hook-runtime.test.ts
  tool-integration.test.ts
  plugin-loader.test.ts
```

## 4. 公共协议

### 4.1 Lifecycle event

PilotDeck 内部 lifecycle event 建议分两层：

1. legacy-compatible hook event：用于 parity 和插件 hook 配置。
2. PilotDeck-native lifecycle event：用于 agent/tool/permission/context 内部调度。

第一阶段保留 legacy-compatible 事件名：

```text
PreToolUse
PostToolUse
PostToolUseFailure
Notification
UserPromptSubmit
PreModelRequest
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
ConfigChange
InstructionsLoaded
CwdChanged
FileChanged
WorktreeCreate
WorktreeRemove
Elicitation
ElicitationResult
```

`TeammateIdle`、`TaskCreated`、`TaskCompleted` 属于 legacy team/task daemon 能力，PilotDeck 新项目不迁移，状态应标记为 `not_applicable`，不进入第一阶段协议、runtime 或测试分类。

### 4.2 Hook input

基础输入：

```ts
export type PilotDeckHookBaseInput = {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  permissionMode?: string;
  agentId?: string;
  agentType?: string;
};
```

legacy JSON 输出必须用 snake_case 兼容层生成；内部 TypeScript 可使用 camelCase：

```text
session_id <-> sessionId
transcript_path <-> transcriptPath
hook_event_name <-> hookEventName
tool_name <-> toolName
tool_input <-> toolInput
tool_use_id <-> toolUseId
```

这样可以同时满足：

- 插件 hook 与旧项目输入字段 parity。
- PilotDeck 内部代码命名统一。

### 4.3 Hook output

PilotDeck 内部输出建议：

```ts
export type PilotDeckHookOutput =
  | { type: "async" }
  | {
      type: "sync";
      continue?: boolean;
      suppressOutput?: boolean;
      stopReason?: string;
      decision?: "approve" | "block";
      reason?: string;
      systemMessage?: string;
      specific?: PilotDeckHookSpecificOutput;
    };
```

legacy-compatible JSON 仍支持：

```json
{ "async": true, "asyncTimeout": 15000 }
```

以及 legacy sync 字段。解析时归一化到内部输出，不把 raw JSON 透传到 agent loop。`asyncTimeout` 仅作为 legacy-compatible 字段被识别，不改变 PilotDeck 的代码常量 timeout。

### 4.4 Hook effect

Hook 不直接修改 agent/tool 状态，而是返回 effect：

```ts
export type PilotDeckHookEffect =
  | { type: "additional_context"; content: string; source: string }
  | { type: "system_message"; content: string }
  | { type: "block"; reason: string; stopReason?: string }
  | { type: "permission_decision"; behavior: PilotDeckHookPermissionBehavior; reason?: string }
  | { type: "updated_tool_input"; input: Record<string, unknown> }
  | { type: "updated_mcp_tool_output"; output: unknown }
  | { type: "permission_request_result"; result: PilotDeckPermissionRequestResult }
  | { type: "initial_user_message"; message: string }
  | { type: "watch_paths"; paths: string[] }
  | { type: "worktree_path"; path: string }
  | { type: "retry_permission_denied" };
```

`LifecycleRuntime.dispatch()` 返回：

```ts
export type LifecycleDispatchResult = {
  effects: PilotDeckHookEffect[];
  messages: CanonicalMessage[];
  events: unknown[];
  blockingErrors: PilotDeckLifecycleError[];
  nonBlockingErrors: PilotDeckLifecycleError[];
};
```

## 5. Agent 集成点

当前 `AgentEvent` 已定义的完整事件流（`src/agent/protocol/events.ts`）：

```text
session_started / session_ended / session_aborted
turn_started / turn_continued / turn_completed / turn_failed
input_accepted / user_prompt_submitted / setup_completed
model_request_started / model_event / instructions_loaded
assistant_message / tool_calls_detected
pre_tool_execute / post_tool_execute
permission_requested / permission_denied
tool_result / tool_results_projected
mode_change_requested / stop_requested / stop_failure
compact_started / compact_completed
subagent_started / subagent_completed
elicitation_requested / elicitation_resolved
```

当前已接入的 lifecycle dispatch 点：

| Agent/Turn 点 | Hook event | 调用位置 | 行为 |
| --- | --- | --- | --- |
| session 创建后 | `SessionStart` | `AgentSession` | 收集 additional context、initial user message、watch paths |
| resume 后 | `SessionStart(source=resume)` | `AgentSession` | 与 startup 同协议，source 不同 |
| session 初始化 | `Setup` | `AgentSession` | 可添加 additional context；bare mode 跳过 |
| input accepted 后 | `UserPromptSubmit` | `TurnRunner` | 追加 additional context；blocking 则不调用 model |
| 模型请求前 | `PreModelRequest` | `AgentLoop` | 可注入 context 或阻止模型请求 |
| 系统指令加载后 | `InstructionsLoaded` | `AgentLoop` | 可追加 context |
| model 无 tool 且将完成时 | `Stop` | `AgentLoop` | 可阻止 continuation 或追加 stop hook summary |
| turn error | `StopFailure` | `AgentLoop` | 可观察模型/loop 错误 |
| 子 agent 启动 | `SubagentStart` | `AgentLoop` | 可追加 context |
| 子 agent 停止 | `SubagentStop` | `AgentLoop` | 可追加 context |
| 工具执行前 | `PreToolUse` | `ToolRuntime` | 修改 input、决定权限、追加 context |
| 权限请求 ask | `PermissionRequest` | `ToolRuntime` | hook 自动 allow/deny |
| 工具成功后 | `PostToolUse` | `ToolRuntime` | 追加 context、更新 MCP 输出 |
| 工具失败后 | `PostToolUseFailure` | `ToolRuntime` | 观察 error |
| 权限拒绝后 | `PermissionDenied` | `ToolRuntime` | 可要求 retry |
| 压缩前 | `PreCompact` | `CompactionEngine` | 可改写 custom instructions |
| 压缩后 | `PostCompact` | `CompactionEngine` | 可追加 context |
| 配置变化 | `ConfigChange` | `createLocalGateway` | sessionId 为空，进程/项目级 |
| Elicitation 请求 | `Elicitation` | `GatewayElicitationChannel` | MCP server 请求用户输入 |
| Elicitation 回应 | `ElicitationResult` | `GatewayElicitationChannel` | 用户回应 |
| session abort/end | `SessionEnd` | `AgentSession` | 并发执行，强超时 |

`AgentSession`/`TurnRunner`/`AgentLoop` 通过 `AgentRuntimeDependencies` 注入 lifecycle：

```ts
type AgentRuntimeDependencies = {
  lifecycle?: LifecycleRuntime;
  ...
};
```

不建议 `AgentLoop` 自己加载插件。它只调用已注入的 lifecycle runtime。Gateway 层通过 `createGatewayPermissionHook`（callback hook）和 `GatewayElicitationChannel` 桥接 host 交互回 lifecycle dispatch。

## 6. Tool 与 Permission 集成点

当前 `ToolRuntime.execute()` 链路：

```text
lookup
  -> validate schema
  -> tool.validateInput
  -> permissionRuntime.decide
  -> tool.execute
  -> audit
```

重写后链路：

```text
lookup
  -> validate schema
  -> tool.validateInput
  -> lifecycle.dispatch(PreToolUse)
  -> apply updated input / permission effect
  -> permissionRuntime.decide
  -> lifecycle.dispatch(PermissionRequest) when ask is produced
  -> tool.execute
  -> lifecycle.dispatch(PostToolUse)
  -> lifecycle.dispatch(PostToolUseFailure) on error
  -> lifecycle.dispatch(PermissionDenied) on deny
  -> audit
```

关键规则：

- `PreToolUse` 发生在 permission decision 前。
- `PreToolUse.updatedInput` 必须重新走 tool-specific validation，避免 hook 注入非法 input。
- `PreToolUse.permissionDecision` 不能绕过 tool safety deny。若 tool 自身返回 hard deny，仍应拒绝。
- `PermissionRequest` hook 只处理 ask 场景；返回 allow 可带 updated input 和 updated permissions。
- `PostToolUse.updatedMCPToolOutput` 只允许 MCP tool adapter 应用。
- PostToolUse blocking 会影响 agent continuation，但不应让 tool execution 被记录为成功后又消失。
- PermissionDenied retry 由 agent/tool runtime 明确处理，必须有最大次数或单次 retry 限制。

## 7. Context 与 Compact 集成点

当前 `src/agent/context/NullContextRuntime.ts` 是轻量 context runtime。后续 compact 进入 context 模块后：

```text
before compact -> PreCompact
compact        -> ContextRuntime.compact()
after compact  -> PostCompact
```

`PreCompact` 可以返回 new custom instructions；`PostCompact` 可以返回 user display message 或 additional context。PilotDeck 第一阶段先固化 protocol 和测试 fixture，不急于实现高级 compact。

## 8. 插件重写方案

### 8.1 Manifest

第一阶段 manifest 建议：

```json
{
  "name": "example",
  "version": "1.0.0",
  "description": "Example plugin",
  "commands": "./commands",
  "agents": "./agents",
  "skills": "./skills",
  "hooks": "./hooks/hooks.json",
  "mcpServers": {},
  "settings": {}
}
```

兼容 legacy 的贡献点：

- `commands`/`commandsPaths`
- `agents`/`agentsPaths`
- `skills`/`skillsPaths`
- `hooksConfig`
- `mcpServers`
- `outputStyles` 可先 deferred
- `lspServers` 可先 deferred

### 8.2 插件来源

PilotDeck 不提供用户自定义扩展总目录，也不支持 session-only 插件。插件和技能目录按全局与具体工作区两个固定粒度解析：

```text
全局目录：
  PilotHome = ~/.pilotdeck
  ~/.pilotdeck/plugins/
  ~/.pilotdeck/skills/

工作区目录：
  <projectRoot>/.pilotdeck/
  <projectRoot>/.pilotdeck/plugins/
  <projectRoot>/.pilotdeck/skills/
```

第一阶段建议支持：

- builtin plugin：代码内声明，默认可启用/禁用。
- global plugin：从 `~/.pilotdeck/plugins/` 加载。
- project plugin：从 `<projectRoot>/.pilotdeck/plugins/` 加载。
- global/project skills：分别从 `~/.pilotdeck/skills/` 与 `<projectRoot>/.pilotdeck/skills/` 加载，并作为插件贡献模型的一部分处理。

延后：

- marketplace。
- Git clone / pull。
- zip cache。
- MCPB/DXT 下载与解包。
- install counts、official marketplace GCS。

即使 marketplace 延后，schema 中仍要保留安全规则，防止后续接入时没有测试基线。

明确不迁移：

- session-only plugin / inline session plugin。
- 用户自定义 `extensionDirs` 或任意扩展根目录。

### 8.3 插件加载流程

```text
PluginRuntime.refresh()
  -> resolve configured sources
  -> discover builtin/global/project plugins
  -> validate manifest
  -> load contributions
      -> hooks
      -> commands
      -> agents/skills
      -> mcp servers
      -> permission rules
  -> produce ExtensionSnapshot
  -> atomically swap PluginRegistry
  -> emit plugin_reload event
```

`ExtensionSnapshot` 应不可变，供一个 turn 固定使用。配置热更新只能影响后续 turn，除非明确标记 runtime-live。

### 8.4 Plugin hooks hot reload

必须保留 legacy 的关键语义：

- 清 hook loader cache 不应清掉当前已注册 hooks。
- full reload 使用原子 clear-then-register。
- 已禁用/卸载插件的 hooks 应立即 prune。
- 新启用插件等待显式 reload 或下一个 refresh policy 触发。
- 变化检测不只看 enabled plugins，也看 marketplace/blocklist/policy 类设置。

PilotDeck 可通过 `PluginReloadPolicy` 表达：

```ts
export type PluginReloadPolicy = {
  pruneRemovedImmediately: boolean;
  activateNewPlugins: "nextReload" | "nextTurn" | "immediate";
  keepOldHooksUntilSwap: boolean;
};
```

默认选择：

```text
pruneRemovedImmediately = true
activateNewPlugins = nextReload
keepOldHooksUntilSwap = true
```

## 9. Config 扩展

当前 `PilotConfig` 只含 model。需要新增：

```ts
export type PilotExtensionConfig = {
  builtinPluginsEnabled: Record<string, boolean>;
  includeHookEvents: boolean;
};

export type PilotConfig = {
  model: ModelConfig;
  extension: PilotExtensionConfig;
};
```

扩展目录不进入用户配置，由 `src/pilot/paths` 或等价模块按 `PilotHome` 和 `projectRoot` 固定解析：

```ts
export type PilotExtensionPaths = {
  globalPluginsDir: string; // ~/.pilotdeck/plugins
  globalSkillsDir: string; // ~/.pilotdeck/skills
  projectPluginsDir: string; // <projectRoot>/.pilotdeck/plugins
  projectSkillsDir: string; // <projectRoot>/.pilotdeck/skills
};
```

Hook timeout 也不进入用户配置或环境变量。PilotDeck 使用代码常量，例如：

```ts
export const PILOTDECK_HOOK_TIMEOUT_MS = 10 * 60 * 1000;
export const PILOTDECK_SESSION_END_HOOK_TIMEOUT_MS = 1500;
```

持久化 hook 配置中的 `timeout` 字段不作为 PilotDeck 第一阶段能力迁移；如果为了读取 legacy 配置而保留 parser，应将其标记为 recognized-but-ignored 或 schema 诊断项，避免用户误以为可配置统一超时。

Hook 失败行为不通过 `hookFailurePolicy` 配置控制，而是按 hook 输出和退出码决定：

| 观察结果 | 行为 |
| --- | --- |
| exit code `0` 且无 blocking JSON | 成功，继续执行 |
| exit code `2` | blocking feedback，按事件语义阻止工具、turn continuation 或返回 stop reason |
| 其他非零 exit code | non-blocking error，记录/展示，但默认不阻断主流程 |
| JSON `continue: false` | 阻止后续流程，并使用 `stopReason` 或默认原因 |
| JSON `decision: "block"` | blocking decision |
| JSON `suppressOutput: true` | 隐藏 stdout 对 transcript/用户的可见输出，但不改变失败类别 |

热更新分类：

| Config key | Change class | 说明 |
| --- | --- | --- |
| `extension.builtinPluginsEnabled` | `next-runtime` | 需要 refresh plugin registry |
| `extension.includeHookEvents` | `runtime-live` | 只影响观察者事件投影 |

## 10. 实施阶段

### Phase 1：协议与测试骨架

- 新增 lifecycle/hook/plugin protocol 类型。
- 新增 hook input/output 解析器。
- 在文档中定义 contract scenarios 与 execution scenarios 的形态，等实现开始时再落地为 tests fixture。
- 文档明确每个 legacy feature 状态。

完成标准：

- 文档中的协议、场景分类和测试计划自洽。
- 不能声明 execution parity passed。

### Phase 2：Hook runtime 最小实现

- 支持 command hook。
- 支持 matcher 与 `if` 条件。
- 支持 stdout JSON sync 输出解析。
- 支持 blocking/additional context/updated input/permission decision。
- 支持 hook execution event bus。

完成标准：

- PreToolUse、PostToolUse、SessionStart、UserPromptSubmit contract parity passed。
- command hook execution parity 至少覆盖 success、blocking、non-blocking error、代码常量 timeout / cancellation。

### Phase 3：Agent/Tool/Permission 接入

- `AgentSession` 接 SessionStart/SessionEnd/UserPromptSubmit/Stop。
- `ToolRuntime` 接 PreToolUse/PostToolUse/PostToolUseFailure。
- `PermissionRuntime` 或 ToolRuntime 接 PermissionRequest/PermissionDenied。
- transcript 记录 hook effect 与 additional context。

当前落地状态：

- `AgentSession` 已接 `SessionStart`、`Setup` 和 `SessionEnd`。
- `TurnRunner` 已接 `UserPromptSubmit`。
- `AgentLoop` 已接 `PreModelRequest`、`Stop`、`StopFailure`、`InstructionsLoaded`、`SubagentStart`、`SubagentStop`。
- `ToolRuntime` 已接 `PreToolUse`、`PermissionRequest`、`PermissionDenied`、`PostToolUse`、`PostToolUseFailure`。
- `CompactionEngine` 已接 `PreCompact`、`PostCompact`。
- `PostToolUse` blocking 作为 `tool_result.metadata.lifecycle` 进入 AgentLoop，可停止后续模型请求。
- `createLocalGateway` 已接 `ConfigChange`（进程级，sessionId 为空）。
- `GatewayElicitationChannel` 已桥接 `Elicitation`/`ElicitationResult` 到 lifecycle dispatch。
- `createGatewayPermissionHook` 已通过 callback hook 注册桥接 Gateway permission_request 事件。

完成标准：

- 同一工具调用场景下，hook 修改 input、阻止执行、追加 context 的 normalized output 与 legacy 一致。
- permission ask 被 PermissionRequest hook 自动 allow/deny 的行为一致。

### Phase 4：Plugin runtime 本地化实现

- 支持 builtin、global 和 project plugins。
- 支持 manifest hooks/commands/skills 基本贡献。
- 支持 plugin hook atomic reload 与 prune removed。
- 支持 plugin command markdown 命名和 frontmatter。

当前落地状态：

- `PluginRuntime.refresh()` 已从 builtin/global/project 插件源生成 snapshot。
- `PluginRuntime.refreshWithReport()` 已返回 previous/next/added/removed，支持删除插件后的 prune 观察。
- builtin plugin 可通过 `builtinPluginsEnabled` 禁用。
- `PluginLoader` 已读取 `plugin.json` 与 `hooks/hooks.json`。
- `PluginCommandLoader` 已读取 markdown commands 与 `SKILL.md`，并解析简单 frontmatter。
- `PluginLoader` 已收集 manifest 中的 `mcpServers`，`PluginRuntime.mcpServers()` 可汇总当前 snapshot 的 MCP server contributions。

完成标准：

- 插件 hooks hot reload contract parity passed。
- 插件 command 命名/发现 contract parity passed。

### Phase 5：异步、HTTP、Prompt、Agent hooks

- `AsyncHookRegistry`。
- `http` hook。
- `prompt` hook。
- `agent` hook。
- asyncRewake 可继续 deferred，直到任务通知队列存在。

当前落地状态：

- `prompt` hook 支持注入 `PromptHookEvaluator`，由外部模型 adapter 提供实际评估。
- `http` hook 使用 `fetch` POST hook input JSON，并按 `allowedEnvVars` 解析 header 环境变量。
- `agent` hook 支持注入 `AgentHookRunner`，由外部 agent adapter 提供实际执行。
- `callback` hook 支持运行时注册回调，不从持久化配置加载。
- `AsyncHookRegistry` 已支持 pending async hook 注册、同步响应收集、delivered response 清理，以及 asyncRewake 标记；真实任务通知队列唤醒仍 deferred。

完成标准：

- async hook pending/completion normalized output 一致。
- HTTP headers env interpolation 安全规则有测试。

### Phase 6：Marketplace/MCPB/高级贡献

- marketplace/Git/zip/MCPB。
- MCP server contributions。
- LSP/output style。
- Worktree hook 事件。

当前落地状态：

- MCP server contributions 已从插件 manifest 读取，并可通过 `PluginRuntime.mcpServers()` 汇总当前 snapshot。
- LSP server contributions 已从插件 manifest 读取，并可通过 `PluginRuntime.lspServers()` 汇总当前 snapshot。
- output style markdown 已按插件命名规则读取。
- `WorktreeCreate` 与 `WorktreeRemove` 已可通过 lifecycle runtime dispatch，hook effect 支持 `worktree_path`。
- `SubagentStart` 与 `SubagentStop` 已在 `AgentLoop` 中 dispatch。
- marketplace reference 已能解析并区分 local metadata 与 Git/zip/MCPB installer deferred 状态。
- 技能管理已提供完整 CRUD：`skillsList`/`skillRead`/`skillWrite`/`skillCreate`/`skillDelete`/`skillImport`/`skillValidate`/`skillScan`，通过 Gateway 接口暴露。
- Git/zip/MCPB 真实下载安装、任务队列 asyncRewake 和完整 Subagent runtime 仍未实现。

完成标准：

- 所有 deferred 项重新分类。
- marketplace 安全和 cache fallback 有 execution parity 或 intentional difference 说明。

## 11. Legacy Feature Matrix

| Legacy feature | New module | Phase | Status |
| --- | --- | --- | --- |
| Hook event enum | `extension/hooks/protocol/events.ts` | 1 | compare |
| Base hook input | `extension/hooks/protocol/input.ts` | 1 | compare |
| Hook settings schema | `extension/hooks/config/parseHooksConfig.ts` | 1 | compare |
| `if` permission rule matcher | `extension/hooks/config/matchHookCondition.ts` | 2 | compare |
| command hook | `CommandHookExecutor` | 2 | compare |
| prompt hook | `PromptHookExecutor` | 5 | compare |
| http hook | `HttpHookExecutor` | 5 | compare |
| agent hook | `AgentHookExecutor` | 5 | compare |
| callback/function hook | `CallbackHookExecutor` + gateway bridge | 5 | compare |
| sync JSON output | `parseHookOutput.ts` | 2 | compare |
| async hook response registry | `AsyncHookRegistry.ts` | 5 | compare |
| async hook background polling | `AsyncHookRegistry.ts` | 5 | deferred |
| asyncRewake marker | `AsyncHookRegistry.ts` | 5 | compare |
| asyncRewake task queue | notification/task runtime | 6 | deferred |
| SessionStart | `AgentSession` + lifecycle | 3 | compare |
| Setup | `AgentSession` + lifecycle | 3 | compare |
| UserPromptSubmit | `TurnRunner` + lifecycle | 3 | compare |
| PreModelRequest | `AgentLoop` + lifecycle | 3 | compare |
| InstructionsLoaded | `AgentLoop` + lifecycle | 3 | compare |
| PreToolUse | `ToolRuntime` + lifecycle | 3 | compare |
| PermissionRequest | `ToolRuntime` + lifecycle | 3 | compare |
| PostToolUse | `ToolRuntime` + lifecycle | 3 | compare |
| PostToolUseFailure | `ToolRuntime` + lifecycle | 3 | compare |
| PermissionDenied retry | `ToolRuntime` + lifecycle | 3 | compare |
| Stop | `AgentLoop` + lifecycle | 3 | compare |
| StopFailure | `AgentLoop` + lifecycle | 3 | compare |
| SubagentStart dispatch | `AgentLoop` + lifecycle | 3 | compare |
| SubagentStop dispatch | `AgentLoop` + lifecycle | 3 | compare |
| Subagent runtime | subagent runtime | 6 | deferred |
| PreCompact/PostCompact | `CompactionEngine` + lifecycle | 3 | compare |
| ConfigChange (process-level) | `createLocalGateway` + lifecycle | 3 | compare |
| Elicitation / ElicitationResult | `GatewayElicitationChannel` + lifecycle | 3 | compare |
| WorktreeCreate / WorktreeRemove dispatch | lifecycle runtime | 6 | compare |
| worktree_path hook effect | `effects.ts` | 6 | compare |
| Plugin global/project/builtin loading | `PluginLoader` | 4 | compare |
| Plugin marketplace reference | plugin marketplace | 6 | compare |
| Plugin marketplace installers | plugin marketplace | 6 | deferred |
| Plugin hooks hot reload | `PluginHookLoader` | 4 | compare |
| Plugin commands/skills | `PluginCommandLoader` | 4 | compare |
| Plugin MCP server contributions | `PluginRuntime.mcpServers()` | 6 | compare |
| Plugin LSP server contributions | `PluginRuntime.lspServers()` | 6 | compare |
| Plugin output styles | `PluginCommandLoader` | 6 | compare |
| Skill CRUD (create/read/write/delete/import/scan) | `extension/skills` + Gateway | 6 | compare |
| Gateway permission callback hook | `createGatewayPermissionHook` | 3 | compare |
| HookExecutionEventBus | `extension/hooks/events` | 2 | compare |
| nonBlockingErrors in dispatch result | `lifecycle/protocol/payloads.ts` | 1 | compare |
| session-only / inline session plugin | 不迁移 | - | not_applicable |
| TeammateIdle / TaskCreated / TaskCompleted | 不迁移 | - | not_applicable |
| CwdChanged | 待 Always-On workspace 切换支持 | - | deferred |
| FileChanged | 待 ToolRuntime dispatch 接入 | - | deferred |
| Notification (user-facing) | 待 Always-On/Feishu 成熟 | - | deferred |
| Legacy telemetry names | audit/event adapter | 2 | intentional_difference |
| `~/.claude` plugin path | `src/pilot/paths` | 4 | intentional_difference |

## 12. 风险

- 老项目 hook 执行语义过于集中，拆分时容易遗漏阻塞/非阻塞错误、additional context 和 transcript 可见性。
- hook 允许修改工具 input，若不重新校验会扩大安全风险。
- async hook 和 asyncRewake 依赖任务通知/queued command，不能只实现注册表。
- 插件 hot reload 的“清 cache 不清注册表”是重要行为，若重写成简单 reset，会导致 Stop hooks 消失。
- command/prompt/http/agent hook 都可能运行不可信代码，必须使用代码常量 timeout、env 插值白名单和 plugin source policy。

## 13. 代码入口（当前实现）

以下是已落地的核心接口：

```ts
// src/lifecycle/runtime/LifecycleRuntime.ts
export class LifecycleRuntime {
  constructor(private readonly hooks = new HookRuntime());
  async dispatch(input: LifecycleDispatchInput): Promise<LifecycleDispatchResult>;
}

// src/extension/hooks/execution/HookRuntime.ts
// HookRuntime 接收 PilotDeckHooksSettings，执行匹配的 hooks，
// 通过 CommandHookExecutor / PromptHookExecutor / HttpHookExecutor /
// AgentHookExecutor / CallbackHookExecutor 运行，返回 effects + errors。
// 内部持有 HookExecutionEventBus 和 AsyncHookRegistry。

// src/extension/plugins/runtime/PluginRuntime.ts
// PluginRuntime.refresh() 发现 builtin/global/project 插件，
// 返回 ExtensionSnapshot（hooks + commands + skills + mcpServers + lspServers）。
// PluginRuntime.refreshWithReport() 返回 added/removed 报告。
// PluginRuntime.snapshotContributions() 返回当前快照的聚合贡献。

// src/extension/hooks/execution/CallbackHookExecutor.ts
// 注册/注销内部 callback hook handler。
// 典型用途：createGatewayPermissionHook 桥接 host permission 回 lifecycle。

// src/extension/hooks/events/HookExecutionEventBus.ts
// subscribe / emit hook 执行事件（started / response）。
```

lifecycle 通过 `AgentRuntimeDependencies` 注入 `AgentSession`/`TurnRunner`/`AgentLoop`/`ToolRuntime`/`CompactionEngine`。agent/tool 不直接读取 plugin registry。Gateway 层通过 callback hook 和 elicitation channel 桥接 host 交互。
