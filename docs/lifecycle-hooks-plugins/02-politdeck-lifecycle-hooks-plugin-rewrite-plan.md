# PolitDeck 生命周期、Hooks 与插件重写方案

## 1. 目标

本文基于 `01-legacy-lifecycle-hooks-plugin-analysis.md`，结合当前 `src/` 新项目结构，定义 PolitDeck 生命周期、hooks 与插件系统的重写方案。

当前仓库已经具备：

- `src/agent/`：`AgentSession`、`TurnRunner`、`AgentLoop`、agent events、transcript、resume、context runtime。
- `src/model/`：canonical message、tool call、tool result、stream event 与 provider adapter。
- `src/tool/`：tool definition、registry、runtime、scheduler、audit、内置工具骨架和部分实现。
- `src/permission/`：permission mode、rules、decision runtime。
- `src/polit/config/`：配置加载、合并、诊断和热更新分类，但当前 `PolitConfig` 只包含 `model`。

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
- Provider-neutral：hook payload 使用 PolitDeck canonical 类型，不暴露 Anthropic 或 legacy SDK message object。
- 默认安全：插件来源、路径、marketplace 名称、环境变量插值、HTTP hook headers 都必须 schema 校验。
- 可测试：每个 legacy feature 必须分类为 `compare`、`deferred`、`intentional_difference` 或 `not_applicable`。
- 不提前宣称一致：只有 shared scenario 同时运行 legacy 和 PolitDeck 并比较 normalized output，才能写 execution parity passed。

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

后续实现测试时，建议采用以下目录命名。本文档不表示这些测试文件当前已经存在：

```text
tests/lifecycle-hooks-plugins/
  parity-manifest.test.ts

tests/fixtures/lifecycle-hooks-plugins/dual-parity/
  contractScenarios.ts
  executionScenarios.ts
```

## 4. 公共协议

### 4.1 Lifecycle event

PolitDeck 内部 lifecycle event 建议分两层：

1. legacy-compatible hook event：用于 parity 和插件 hook 配置。
2. PolitDeck-native lifecycle event：用于 agent/tool/permission/context 内部调度。

第一阶段保留 legacy-compatible 事件名：

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
ConfigChange
InstructionsLoaded
CwdChanged
FileChanged
WorktreeCreate
WorktreeRemove
Elicitation
ElicitationResult
```

`TeammateIdle`、`TaskCreated`、`TaskCompleted` 属于 legacy team/task daemon 能力，PolitDeck 新项目不迁移，状态应标记为 `not_applicable`，不进入第一阶段协议、runtime 或测试分类。

### 4.2 Hook input

基础输入：

```ts
export type PolitDeckHookBaseInput = {
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
- PolitDeck 内部代码命名统一。

### 4.3 Hook output

PolitDeck 内部输出建议：

```ts
export type PolitDeckHookOutput =
  | { type: "async" }
  | {
      type: "sync";
      continue?: boolean;
      suppressOutput?: boolean;
      stopReason?: string;
      decision?: "approve" | "block";
      reason?: string;
      systemMessage?: string;
      specific?: PolitDeckHookSpecificOutput;
    };
```

legacy-compatible JSON 仍支持：

```json
{ "async": true, "asyncTimeout": 15000 }
```

以及 legacy sync 字段。解析时归一化到内部输出，不把 raw JSON 透传到 agent loop。`asyncTimeout` 仅作为 legacy-compatible 字段被识别，不改变 PolitDeck 的代码常量 timeout。

### 4.4 Hook effect

Hook 不直接修改 agent/tool 状态，而是返回 effect：

```ts
export type PolitDeckHookEffect =
  | { type: "additional_context"; content: string; source: string }
  | { type: "system_message"; content: string }
  | { type: "block"; reason: string; stopReason?: string }
  | { type: "permission_decision"; behavior: "allow" | "deny" | "ask" | "passthrough"; reason?: string }
  | { type: "updated_tool_input"; input: Record<string, unknown> }
  | { type: "updated_mcp_tool_output"; output: unknown }
  | { type: "permission_request_result"; result: PermissionRequestResult }
  | { type: "initial_user_message"; message: string }
  | { type: "watch_paths"; paths: string[] }
  | { type: "retry_permission_denied" };
```

`LifecycleRuntime.dispatch()` 返回：

```ts
export type LifecycleDispatchResult = {
  effects: PolitDeckHookEffect[];
  messages: CanonicalMessage[];
  events: PolitDeckHookExecutionEvent[];
  blockingErrors: PolitDeckLifecycleError[];
};
```

## 5. Agent 集成点

当前 `AgentLoop.run()` 已发出：

```text
model_request_started
model_event
assistant_message
tool_calls_detected
tool_result
tool_results_projected
turn_continued
turn_completed
turn_failed
```

第一阶段集成点：

| Agent/Turn 点 | Hook event | 行为 |
| --- | --- | --- |
| session 创建后 | `SessionStart` | 收集 additional context、initial user message、watch paths |
| resume 后 | `SessionStart(source=resume)` | 与 startup 同协议，source 不同 |
| input accepted 后 | `UserPromptSubmit` | 追加 additional context；blocking 则不调用 model |
| model 无 tool 且将完成时 | `Stop` | 可阻止 continuation 或追加 stop hook summary |
| turn error | `StopFailure` | 可观察模型/loop 错误 |
| session abort/end | `SessionEnd` | 并发执行，强超时 |

`AgentSession`/`TurnRunner` 应注入：

```ts
type AgentRuntimeDependencies = {
  lifecycle?: LifecycleRuntime;
  extensions?: ExtensionRuntime;
  ...
};
```

不建议 `AgentLoop` 自己加载插件。它只调用已注入的 lifecycle runtime。

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

`PreCompact` 可以返回 new custom instructions；`PostCompact` 可以返回 user display message 或 additional context。PolitDeck 第一阶段先固化 protocol 和测试 fixture，不急于实现高级 compact。

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

PolitDeck 不提供用户自定义扩展总目录，也不支持 session-only 插件。插件和技能目录按全局与具体工作区两个固定粒度解析：

```text
全局目录：
  PolitHome = ~/.politdeck
  ~/.politdeck/plugins/
  ~/.politdeck/skills/

工作区目录：
  <projectRoot>/.politdeck/
  <projectRoot>/.politdeck/plugins/
  <projectRoot>/.politdeck/skills/
```

第一阶段建议支持：

- builtin plugin：代码内声明，默认可启用/禁用。
- global plugin：从 `~/.politdeck/plugins/` 加载。
- project plugin：从 `<projectRoot>/.politdeck/plugins/` 加载。
- global/project skills：分别从 `~/.politdeck/skills/` 与 `<projectRoot>/.politdeck/skills/` 加载，并作为插件贡献模型的一部分处理。

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

PolitDeck 可通过 `PluginReloadPolicy` 表达：

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

当前 `PolitConfig` 只含 model。需要新增：

```ts
export type PolitExtensionConfig = {
  builtinPluginsEnabled: Record<string, boolean>;
  includeHookEvents: boolean;
};

export type PolitConfig = {
  model: ModelConfig;
  extension: PolitExtensionConfig;
};
```

扩展目录不进入用户配置，由 `src/polit/paths` 或等价模块按 `PolitHome` 和 `projectRoot` 固定解析：

```ts
export type PolitExtensionPaths = {
  globalPluginsDir: string; // ~/.politdeck/plugins
  globalSkillsDir: string; // ~/.politdeck/skills
  projectPluginsDir: string; // <projectRoot>/.politdeck/plugins
  projectSkillsDir: string; // <projectRoot>/.politdeck/skills
};
```

Hook timeout 也不进入用户配置或环境变量。PolitDeck 使用代码常量，例如：

```ts
export const POLITDECK_HOOK_TIMEOUT_MS = 10 * 60 * 1000;
export const POLITDECK_SESSION_END_HOOK_TIMEOUT_MS = 1500;
```

持久化 hook 配置中的 `timeout` 字段不作为 PolitDeck 第一阶段能力迁移；如果为了读取 legacy 配置而保留 parser，应将其标记为 recognized-but-ignored 或 schema 诊断项，避免用户误以为可配置统一超时。

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

完成标准：

- 同一工具调用场景下，hook 修改 input、阻止执行、追加 context 的 normalized output 与 legacy 一致。
- permission ask 被 PermissionRequest hook 自动 allow/deny 的行为一致。

### Phase 4：Plugin runtime 本地化实现

- 支持 builtin、global 和 project plugins。
- 支持 manifest hooks/commands/skills 基本贡献。
- 支持 plugin hook atomic reload 与 prune removed。
- 支持 plugin command markdown 命名和 frontmatter。

完成标准：

- 插件 hooks hot reload contract parity passed。
- 插件 command 命名/发现 contract parity passed。

### Phase 5：异步、HTTP、Prompt、Agent hooks

- `AsyncHookRegistry`。
- `http` hook。
- `prompt` hook。
- `agent` hook。
- asyncRewake 可继续 deferred，直到任务通知队列存在。

完成标准：

- async hook pending/completion normalized output 一致。
- HTTP headers env interpolation 安全规则有测试。

### Phase 6：Marketplace/MCPB/高级贡献

- marketplace/Git/zip/MCPB。
- MCP server contributions。
- LSP/output style。
- Worktree hook 事件。

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
| prompt hook | `PromptHookExecutor` | 5 | deferred |
| http hook | `HttpHookExecutor` | 5 | deferred |
| agent hook | `AgentHookExecutor` | 5 | deferred |
| callback/function hook | SDK adapter | 5 | deferred |
| sync JSON output | `parseHookOutput.ts` | 2 | compare |
| async hook | `AsyncHookRegistry.ts` | 5 | deferred |
| asyncRewake | notification/task runtime | 6 | deferred |
| SessionStart | `AgentSession` + lifecycle | 3 | compare |
| Setup | adapter/init lifecycle | 3 | compare |
| UserPromptSubmit | `TurnRunner` + lifecycle | 3 | compare |
| PreToolUse | `ToolRuntime` + lifecycle | 3 | compare |
| PermissionRequest | `ToolRuntime`/`PermissionRuntime` + lifecycle | 3 | compare |
| PostToolUse | `ToolRuntime` + lifecycle | 3 | compare |
| PostToolUseFailure | `ToolRuntime` + lifecycle | 3 | compare |
| PermissionDenied retry | `ToolRuntime` + lifecycle | 3 | compare |
| Stop/SubagentStop | `AgentLoop`/subagent runtime | 3/6 | partial/deferred |
| PreCompact/PostCompact | context runtime | 6 | deferred |
| Plugin global/project/builtin loading | `PluginLoader` | 4 | compare |
| Plugin marketplace install | plugin marketplace | 6 | deferred |
| Plugin hooks hot reload | `PluginHookLoader` | 4 | compare |
| Plugin commands/skills | `PluginCommandLoader` | 4 | compare |
| session-only / inline session plugin | 不迁移 | - | not_applicable |
| TeammateIdle / TaskCreated / TaskCompleted | 不迁移 | - | not_applicable |
| Legacy telemetry names | audit/event adapter | 2 | intentional_difference |
| `~/.claude` plugin path | `src/polit/paths` | 4 | intentional_difference |

## 12. 风险

- 老项目 hook 执行语义过于集中，拆分时容易遗漏阻塞/非阻塞错误、additional context 和 transcript 可见性。
- hook 允许修改工具 input，若不重新校验会扩大安全风险。
- async hook 和 asyncRewake 依赖任务通知/queued command，不能只实现注册表。
- 插件 hot reload 的“清 cache 不清注册表”是重要行为，若重写成简单 reset，会导致 Stop hooks 消失。
- command/prompt/http/agent hook 都可能运行不可信代码，必须使用代码常量 timeout、env 插值白名单和 plugin source policy。

## 13. 第一批代码入口建议

实现时优先从这些最小接口开始：

```ts
export interface LifecycleRuntime {
  dispatch(input: LifecycleDispatchInput): Promise<LifecycleDispatchResult>;
}

export interface HookRuntime {
  run(event: PolitDeckHookEvent, input: PolitDeckHookInput): AsyncIterable<PolitDeckHookRuntimeEvent>;
}

export interface ExtensionRuntime {
  snapshot(): ExtensionSnapshot;
  refresh(reason: ExtensionRefreshReason): Promise<ExtensionSnapshot>;
}
```

随后只把接口注入现有 `AgentRuntimeDependencies` 和 `ToolRuntime`，不要让 agent/tool 直接读取 plugin registry。
