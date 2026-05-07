# PolitDeck Tool 重构代码开发文档

本文用于指导将 `third-party/claude-code-main` 中的 tool 能力重构为 PolitDeck 自有实现。目标不是逐文件搬运旧实现，而是提炼旧项目已经验证过的行为协议，并用 PolitDeck 的模块边界、命名、配置和测试方式重新实现。

## 1. 背景与目标

PolitDeck 新架构以 `agent` 为中心：

```text
agent
  -> model
  -> context
  -> tool
  -> permission
  -> session
  -> extension
```

其中 `model` 已经在 `src/model/` 下建立 canonical protocol。`tool` 重构必须对齐这些 canonical 类型，尤其是：

- `CanonicalToolSchema`
- `CanonicalToolCall`
- `CanonicalToolResultBlock`
- `CanonicalModelEvent`

本阶段的主要目标：

- 建立 PolitDeck 自有 `tool` / `permission` 运行时。
- 把模型返回的 tool call 稳定转换为 tool execution。
- 所有工具执行前都必须经过 permission runtime。
- 所有结果都必须回填为统一 `tool_result`。
- 所有拟新增代码、配置、事件和错误命名统一使用 `PolitDeck` / `politdeck`。
- 保留旧项目核心语义，但避免继承旧项目 UI、实验功能、telemetry、swarm、远端会话等复杂耦合。

## 2. 命名迁移规则

重构后的代码中禁止把旧项目品牌名作为业务类型、事件名、配置名或错误码前缀。只允许在文档中引用旧源码路径。

| 旧语义 | PolitDeck 命名 |
| --- | --- |
| Claude Code tool | PolitDeck tool |
| Claude / claude | PolitDeck / politdeck |
| tengu event | politdeck event |
| Claude session | PolitDeck session |
| Claude permission | PolitDeck permission |
| Claude tool result | PolitDeck tool result |
| CLAUDE.md memory | PolitDeck memory file，后续另行定义 |
| `~/.claude` | `~/.politdeck` |
| `claude.json` | `politdeck.json` 或 `politdeck.yaml` |
| `CLAUDE_*` env | `POLITDECK_*` env |

示例：

```ts
export type PolitDeckToolDefinition = {
  name: string;
  description: string;
  inputSchema: PolitDeckToolInputSchema;
};
```

不要写旧项目前缀：

```ts
export type LegacyToolDefinition = {};
```

事件名也必须统一：

```text
politdeck_tool_started
politdeck_tool_permission_decided
politdeck_tool_completed
politdeck_tool_failed
politdeck_tool_result_truncated
```

## 3. 旧工具系统能力总览

旧项目的 tool 系统主要由以下能力组成：

- Tool contract：统一描述工具名、schema、执行函数、权限函数、渲染函数、并发属性和结果映射。
- Tool registry：内置工具、MCP 工具、动态工具按场景合并。
- Tool execution：解析 tool call，校验输入，跑 pre hook，权限判断，执行工具，处理结果，跑 post hook。
- Permission runtime：根据 mode、规则、工具自定义权限、分类器、交互 UI 得出 allow / deny / ask。
- Result mapping：工具内部输出映射为模型可消费的 `tool_result`。
- Progress：工具和 hook 都可以产出 progress message，但 progress 不进入模型上下文。
- MCP adapter：动态把 MCP server 暴露的工具包装为普通 tool。
- Builtin tools：文件读写、搜索、shell、Web、MCP、任务、技能、计划、worktree、cron、agent delegation 等。

PolitDeck 第一版必须保留：

- 类型协议。
- registry。
- 输入 schema 校验。
- permission 决策。
- tool execution。
- sequential scheduler。
- audit record。
- read / glob / grep / bash / edit / write 的第一版实现。

PolitDeck 第一版可以先做骨架：

- MCP tool。
- MCP resource。
- ask user question。
- web fetch / web search。
- structured output。
- plan mode enter / exit。

PolitDeck 第一版暂缓：

- subagent / team / swarm。
- cron daemon。
- always-on discovery。
- memory tools。
- skill manager。
- remote trigger。
- worktree 完整生命周期。
- classifier auto mode。
- bridge / remote permission callback。
- hooks plugin system。
- UI 渲染层。

### 3.1 third-party 子树完整性说明

`third-party/claude-code-main` 是重构参考源，不应被当作当前仓库可直接编译、完整发布的上游源码快照。复核时需要注意：

- `src/tools.ts` 中有一些 feature-gated / ant-only / Kairos-only 工具，在当前 vendored 子树中没有完整实现目录。
- `WorkflowTool`、`SleepTool` 等在当前子树中可能只有 constants 或 prompt 片段。
- `MonitorTool`、`SubscribePRTool`、`PushNotificationTool`、`SendUserFileTool`、`OverflowTestTool`、`VerifyPlanExecutionTool`、`TerminalCaptureTool`、`CtxInspectTool`、`ListPeersTool`、`SuggestBackgroundPRTool`、`SnipTool` 等可能只存在于特定构建或未收录源码中。
- PolitDeck 文档中的迁移矩阵以“行为能力”作为依据，不保证每一项都能在当前 vendored 子树中找到完整实现文件。

因此后续实现时不要直接依赖 `third-party/claude-code-main` 的 import 路径。需要从旧源码提炼行为协议，再在 `src/tool/` 和 `src/permission/` 下实现 PolitDeck 自有版本。

## 4. 目标目录结构

建议新增目录如下：

```text
src/tool/
  index.ts

  protocol/
    types.ts
    errors.ts
    result.ts
    schema.ts

  registry/
    ToolRegistry.ts
    createBuiltinRegistry.ts

  execution/
    ToolRuntime.ts
    executeToolCall.ts
    validateToolInput.ts
    normalizeToolError.ts

  scheduler/
    SequentialToolScheduler.ts
    ToolScheduler.ts

  builtin/
    readFile.ts
    glob.ts
    grep.ts
    bash.ts
    editFile.ts
    writeFile.ts
    askUserQuestion.ts
    webFetch.ts
    webSearch.ts
    mcpTool.ts
    listMcpResources.ts
    readMcpResource.ts
    structuredOutput.ts

  audit/
    ToolAuditRecorder.ts

src/permission/
  index.ts

  protocol/
    types.ts
    errors.ts

  policy/
    rules.ts
    matchPermissionRule.ts
    defaultPolicy.ts

  decision/
    PermissionRuntime.ts
    decideToolPermission.ts

  audit/
    PermissionAuditRecorder.ts
```

测试目录：

```text
tests/tool/
  registry.test.ts
  input-validation.test.ts
  runtime.test.ts
  scheduler.test.ts
  result.test.ts
  builtin-read-file.test.ts
  builtin-glob.test.ts
  builtin-grep.test.ts
  builtin-bash.test.ts
  builtin-edit-write.test.ts

tests/permission/
  permission-runtime.test.ts
  permission-rules.test.ts
  permission-audit.test.ts
```

## 5. 核心类型设计

### 5.1 ToolDefinition

PolitDeck 不直接复制旧项目 `Tool` 接口。旧接口包含 UI、telemetry、React、MCP、session state、progress、rendering 等大量耦合。PolitDeck 第一版应把运行时协议压缩为稳定内核。

```ts
import type { CanonicalToolCall, CanonicalToolSchema } from "../../model/index.js";
import type { PermissionResult } from "../../permission/index.js";

export type PolitDeckToolInputSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export type PolitDeckToolKind =
  | "filesystem"
  | "shell"
  | "network"
  | "mcp"
  | "session"
  | "agent"
  | "structured_output"
  | "custom";

export type PolitDeckToolDefinition<Input = unknown, Output = unknown> = {
  name: string;
  aliases?: string[];
  title?: string;
  description: string;
  kind: PolitDeckToolKind;
  inputSchema: PolitDeckToolInputSchema;
  outputSchema?: Record<string, unknown>;
  maxResultBytes?: number;
  isReadOnly(input: Input): boolean;
  isConcurrencySafe(input: Input): boolean;
  isDestructive?(input: Input): boolean;
  requiresUserInteraction?(input: Input): boolean;
  isOpenWorld?(input: Input): boolean;
  validateInput?(input: Input, context: PolitDeckToolRuntimeContext): Promise<PolitDeckToolValidationResult>;
  checkPermissions?(input: Input, context: PolitDeckToolRuntimeContext): Promise<PermissionResult>;
  execute(input: Input, context: PolitDeckToolRuntimeContext): Promise<PolitDeckToolExecutionOutput<Output>>;
};

export type PolitDeckToolCall = CanonicalToolCall;
```

设计要点：

- `name` 是 wire name，必须稳定。
- `aliases` 仅用于兼容历史 transcript，不用于新模型请求。
- `kind` 用于权限默认策略和审计。
- `isReadOnly` 必须基于输入动态判断，例如 `bash` 中 `pwd` 可以是只读，`rm -rf` 不是。
- `requiresUserInteraction` 用于 ask-user-question 或 OAuth 类工具。
- `isOpenWorld` 标记是否访问外部世界，例如 shell、network、MCP。
- `execute` 不负责权限；权限统一由 `ToolRuntime` 调用。

### 5.2 ToolRuntimeContext

第一版 context 保持纯运行时，不引入 UI。

```ts
export type PolitDeckToolRuntimeContext = {
  sessionId: string;
  turnId: string;
  cwd: string;
  abortSignal?: AbortSignal;
  permissionMode: PermissionMode;
  permissionContext: PermissionContext;
  auditRecorder?: PolitDeckToolAuditRecorder;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
};
```

后续可以扩展：

- transcript store。
- progress sink。
- hook runtime。
- MCP client manager。
- virtual file system。
- sandbox runtime。

第一版不要把 UI state、React setter、terminal renderer、telemetry SDK 放进 context。

### 5.3 ToolResult

Tool result 需要同时服务三层：

- executor 内部判断是否成功。
- agent loop 回填给 model。
- transcript / audit 存储。

```ts
export type PolitDeckToolResult =
  | PolitDeckToolSuccessResult
  | PolitDeckToolErrorResult;

export type PolitDeckToolSuccessResult = {
  type: "success";
  toolCallId: string;
  toolName: string;
  content: PolitDeckToolResultContent[];
  data?: unknown;
  metadata?: Record<string, unknown>;
  startedAt: string;
  completedAt: string;
};

export type PolitDeckToolErrorResult = {
  type: "error";
  toolCallId: string;
  toolName: string;
  error: PolitDeckToolError;
  content: PolitDeckToolResultContent[];
  metadata?: Record<string, unknown>;
  startedAt: string;
  completedAt: string;
};

export type PolitDeckToolResultContent =
  | { type: "text"; text: string }
  | { type: "json"; value: unknown }
  | { type: "image"; mimeType: string; data: string }
  | { type: "file"; path: string; mimeType?: string; description?: string };
```

工具 `execute()` 不应直接构造最终 `PolitDeckToolResult`，否则容易绕过 runtime 的时间戳、错误归一化、audit 和 result size 限制。建议工具只返回执行输出：

```ts
export type PolitDeckToolExecutionOutput<Output = unknown> = {
  content: PolitDeckToolResultContent[];
  data?: Output;
  metadata?: Record<string, unknown>;
};
```

`ToolRuntime` 负责把 `PolitDeckToolExecutionOutput` 包装为 `PolitDeckToolSuccessResult`。

映射到 canonical model block：

```ts
export function toCanonicalToolResultBlock(result: PolitDeckToolResult): CanonicalToolResultBlock {
  return {
    type: "tool_result",
    toolCallId: result.toolCallId,
    isError: result.type === "error",
    content: result.content.map((item) => ({
      type: "text",
      text: item.type === "text" ? item.text : JSON.stringify(item),
    })),
    raw: result,
  };
}
```

第一版可以只回填 text content。图片、文件、大结果持久化后续再扩展。

### 5.4 Result Size 与截断策略

旧项目会对过大的 tool result 做持久化和预览，避免 tool 输出撑爆上下文。PolitDeck 第一版不必实现完整持久化，但必须固定大小策略，否则 `grep`、`bash`、`read_file` 很容易破坏 agent loop。

建议第一版策略：

- 每个工具可以声明 `maxResultBytes`。
- runtime 使用 `config.tool.maxResultBytes` 作为默认上限。
- 超限时优先截断 text content，并在 metadata 中记录 `truncated=true`、`originalBytes`、`returnedBytes`。
- 超限但不能安全截断的内容返回 `result_too_large`。
- 后续接入 `session` 后，再把完整结果写入 transcript artifact 或缓存文件。

建议元数据：

```ts
export type PolitDeckToolResultSizeMetadata = {
  truncated?: boolean;
  originalBytes?: number;
  returnedBytes?: number;
  persistedPath?: string;
};
```

第一版所有可能产生大量输出的工具都必须设置或继承上限：

- `read_file`
- `grep`
- `bash`
- `web_fetch`
- `web_search`
- `mcp__*`

### 5.5 ToolError

错误必须结构化，不允许只返回随意字符串。

```ts
export type PolitDeckToolErrorCode =
  | "tool_not_found"
  | "invalid_tool_input"
  | "permission_denied"
  | "permission_cancelled"
  | "permission_required"
  | "tool_execution_failed"
  | "tool_aborted"
  | "tool_timeout"
  | "result_too_large"
  | "path_not_allowed"
  | "file_not_found"
  | "file_conflict"
  | "unsupported_tool";

export type PolitDeckToolError = {
  code: PolitDeckToolErrorCode;
  message: string;
  cause?: unknown;
  details?: Record<string, unknown>;
};
```

标准错误结果要求：

- tool 不存在：`tool_not_found`。
- schema 校验失败：`invalid_tool_input`。
- permission deny：`permission_denied`。
- permission ask 但当前 runtime 无 UI：`permission_required`。
- abort signal：`tool_aborted`。
- timeout：`tool_timeout`。
- execute throw：`tool_execution_failed`。

## 6. Permission 类型设计

### 6.1 PermissionMode

PolitDeck 第一版至少支持：

```ts
export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions"
  | "dontAsk";
```

旧项目中的 `auto`、`bubble`、classifier 相关模式先暂缓。

语义：

- `default`：只读工具默认允许；写入、shell、网络、MCP 可按规则 ask。
- `plan`：默认倾向只读和无副作用；写入、shell 副作用、网络副作用默认 deny 或 ask。后续如果引入 plan 文件写入或 `plan + bypassAvailable` 特例，必须单独列出允许路径和测试。
- `acceptEdits`：编辑类工具可自动允许，shell 等仍按 default。该语义应优先体现在具体工具的 `checkPermissions()` 中，而不是只靠全局 runtime 后置判断。
- `bypassPermissions`：跳过普通 ask，但不能绕过 safety deny。
- `dontAsk`：对 permission runtime 主路径最终仍为 `ask` 的决策转为 `deny`。如果未来 hook 或 adapter 传入强制 ask，PolitDeck 必须明确是否仍套用 `dontAsk`，避免出现不同路径语义不一致。

### 6.2 PermissionDecision

```ts
export type PermissionDecision =
  | {
      type: "allow";
      reason: PermissionDecisionReason;
      updatedInput?: unknown;
    }
  | {
      type: "deny";
      reason: PermissionDecisionReason;
      message: string;
    }
  | {
      type: "ask";
      reason: PermissionDecisionReason;
      request: PermissionRequest;
    }
  | {
      type: "cancel";
      reason: PermissionDecisionReason;
      message: string;
    };
```

`ask` decision 必须携带可序列化的 request，不能包含 UI callback 或 React state。

```ts
export type PermissionRequest = {
  toolCallId: string;
  toolName: string;
  inputSummary: string;
  reason: PermissionDecisionReason;
  options: PermissionRequestOption[];
  metadata?: Record<string, unknown>;
};

export type PermissionRequestOption =
  | { id: "allow_once"; label: string }
  | { id: "allow_session"; label: string; rules?: PermissionRule[] }
  | { id: "deny"; label: string }
  | { id: "cancel"; label: string };
```

第一版 `ToolRuntime` 可以在 `context.permissionContext.canPrompt=false` 时把 `ask` 转成 `permission_required`。后续 CLI/TUI/SDK adapter 支持交互时，由 agent loop 或 adapter 消费 `PermissionRequest`，再恢复执行，不要让 permission runtime 直接调用 UI。

说明：PolitDeck 的 `PermissionRequest` 是新的宿主/UI 协议，不要求字面兼容旧项目的 permission ask 结构。旧项目中 ask 更接近 `message + suggestions + metadata + pendingClassifierCheck`，并由不同 UI/SDK handler 继续处理。PolitDeck 选择集中成可序列化 request，是为了让 CLI/TUI/SDK adapter 有统一入口。

### 6.3 PermissionResult

工具自己的 `checkPermissions` 可以返回 `passthrough`，表示工具没有明确意见，交给全局策略决定。

```ts
export type PermissionResult =
  | PermissionDecision
  | {
      type: "passthrough";
      reason?: PermissionDecisionReason;
    };
```

### 6.4 PermissionDecisionReason

```ts
export type PermissionDecisionReason =
  | { type: "mode"; mode: PermissionMode; message: string }
  | { type: "rule"; behavior: PermissionRuleBehavior; rule: PermissionRule; message: string }
  | { type: "tool"; toolName: string; message: string }
  | { type: "safety"; message: string }
  | { type: "runtime"; message: string };
```

### 6.5 PermissionContext

```ts
export type PermissionContext = {
  mode: PermissionMode;
  rules: PermissionRuleSet;
  cwd: string;
  additionalWorkingDirectories: string[];
  canPrompt: boolean;
  bypassAvailable: boolean;
};

export type PermissionRuleBehavior = "allow" | "deny" | "ask";

export type PermissionRule = {
  source: "user" | "project" | "session" | "policy" | "cli";
  behavior: PermissionRuleBehavior;
  toolName: string;
  pattern?: string;
};

export type PermissionRuleSet = {
  allow: PermissionRule[];
  deny: PermissionRule[];
  ask: PermissionRule[];
};
```

与旧项目 `ToolPermissionContext` 的字段映射：

| 旧字段 | PolitDeck 字段 / 策略 |
| --- | --- |
| `mode` | `PermissionContext.mode` |
| `alwaysAllowRules` | `PermissionRuleSet.allow` |
| `alwaysDenyRules` | `PermissionRuleSet.deny` |
| `alwaysAskRules` | `PermissionRuleSet.ask` |
| `additionalWorkingDirectories` | `PermissionContext.additionalWorkingDirectories` |
| `isBypassPermissionsModeAvailable` | `PermissionContext.bypassAvailable` |
| `shouldAvoidPermissionPrompts` | `canPrompt=false` |
| `prePlanMode` | 第一版暂缓，plan mode 完整状态机时再加 |
| `awaitAutomatedChecksBeforeDialog` | 第一版暂缓，classifier/coordinator 时再加 |
| `strippedDangerousRules` | 第一版暂缓，auto mode 时再加 |

## 7. Permission 决策顺序

PolitDeck 应保留旧项目最关键的不变量：hook 或 bypass 不能绕过明确 deny 和 safety。

第一版决策顺序：

```text
1. 如果全局 deny rule 命中 -> deny
2. 如果全局 ask rule 命中 -> ask
3. 调用 tool.checkPermissions(input, context)
   3.1 deny -> deny
   3.2 ask 且 reason 是 safety -> ask 或 deny，不能被 bypass
   3.3 allow -> 继续
   3.4 passthrough -> 继续
4. 如果 mode 是 bypassPermissions 且没有 safety 阻断 -> allow
5. 如果 mode 是 dontAsk 且当前需要 ask -> deny
6. 如果 mode 是 plan：
   6.1 readOnly -> allow
   6.2 非 readOnly -> ask 或 deny
7. 如果 mode 是 acceptEdits：
   7.1 edit/write 工具 -> allow
   7.2 其他工具 -> default 策略
8. 如果全局 allow rule 命中 -> allow
9. default 策略：
   9.1 readOnly -> allow
   9.2 destructive/openWorld/requiresUserInteraction -> ask
   9.3 其他 -> ask
10. 如果 canPrompt=false 且结果是 ask -> deny(permission_required)
```

注意：

- `bypassPermissions` 不应该绕过路径越界、危险命令、策略 deny。
- `dontAsk` 不应该神奇允许工具，它只是把 ask 转成 deny。
- `plan` 应尽量保证无副作用。
- `acceptEdits` 只放宽文件编辑类工具，不放宽 shell / network。实现时优先让编辑工具在 `checkPermissions()` 中识别该模式。

该顺序是 PolitDeck 的简化目标语义。对照旧项目时还需要注意：

- 旧项目的完整路径包含 `PreToolUse` hook。hook 结果会先进入 `resolveHookPermissionDecision`，再决定是否走完整 permission runtime。
- hook `allow` 不等价于完全跳过权限；至少要重放 deny rule、显式 ask rule、tool safety check 和 path boundary。
- hook `ask` 在旧项目中可作为 force decision 进入交互层，可能不再经过完整 runtime。PolitDeck 后续实现 hook 时应明确是否允许这种收窄路径。
- 全局 allow rule 与 `passthrough -> ask` 的相对顺序必须在实现中固定并测试。不要让 allow rule 意外覆盖 deny、ask 或 safety。
- `plan + bypassAvailable`、plan 文件写入、auto/classifier 等旧项目特例第一版不实现，但如果后续恢复，必须在本节补充明确顺序。

## 8. ToolRegistry 设计

```ts
export class PolitDeckToolRegistry {
  private readonly toolsByName = new Map<string, PolitDeckToolDefinition>();
  private readonly aliases = new Map<string, string>();

  register(tool: PolitDeckToolDefinition): void;
  get(name: string): PolitDeckToolDefinition | undefined;
  has(name: string): boolean;
  list(): PolitDeckToolDefinition[];
  toCanonicalSchemas(): CanonicalToolSchema[];
}
```

规则：

- `register` 遇到重复 `name` 必须 throw。
- `aliases` 不能覆盖已有真实工具名。
- `list()` 返回按 name 排序的稳定顺序，避免模型 prompt cache 抖动。
- `toCanonicalSchemas()` 输出 `CanonicalToolSchema[]`，供 model request 使用。

### 8.1 工具池组装规范

旧项目并不是简单把所有工具全量排序后塞给模型，而是区分内置工具、MCP 工具和特殊动态工具。PolitDeck 后续接入 MCP / structured output / deferred tools 时必须保留这类稳定性约束。

建议规则：

- 内置工具池和 MCP 工具池分别排序。
- 合并时内置工具优先，MCP 工具后置。
- 同名冲突时内置工具优先，MCP 或动态工具必须被拒绝或重命名。
- 不要把 MCP 工具插入内置工具排序中间，否则会让 system prompt 中的工具 schema 顺序随 MCP 配置波动，影响 prompt cache。
- `registry.list()` 可以返回所有已注册工具；`registry.toCanonicalSchemas()` 应接受当前 permission context / tool pool context，以便过滤不可见工具。
- `structured_output`、MCP resource 工具、测试工具等可以通过独立工具池阶段注入，不一定属于基础 builtin registry。

建议拆分：

```ts
export type PolitDeckToolPool = {
  builtin: PolitDeckToolDefinition[];
  mcp: PolitDeckToolDefinition[];
  dynamic: PolitDeckToolDefinition[];
};

export function assemblePolitDeckToolPool(pool: PolitDeckToolPool): PolitDeckToolDefinition[];
```

### 8.2 Deny 规则的两层效果

Permission deny 有两层含义：

1. **执行时拒绝**：模型已经发起 tool call，runtime 返回 `permission_denied`。
2. **模型可见性过滤**：在把 tool schema 发送给 model 前，直接把被 blanket deny 的工具从 schema 列表中移除。

旧项目对整工具 deny、MCP server 前缀 deny 等场景会提前过滤工具。PolitDeck 应保留这个能力：

- `deny` 规则命中整个工具时，默认不向模型暴露该工具 schema。
- `deny` 规则命中 `mcp__server` 前缀时，可以移除该 server 下全部 MCP 工具。
- 如果模型通过历史上下文或 alias 仍调用了被隐藏工具，runtime 仍必须返回标准 `permission_denied` 或 `tool_not_found`，具体策略要固定。

测试时要区分：

- 工具 schema 是否出现在 model request 中。
- tool call 执行后是否被 permission 拒绝。

### 8.3 Deferred Tools 与 ToolSearch

旧项目中很多工具不是一开始就把完整 schema 发送给模型，而是通过 ToolSearch / deferred tool 机制按需发现。PolitDeck 第一版可以暂缓 `tool_search`，但需要保留协议位置。

关键语义：

- MCP 工具默认适合 deferred，避免大量 schema 撑爆 prompt。
- 大型或低频内置工具也可以 `shouldDefer=true`。
- 少数必须首轮可见的工具可以 `alwaysLoad=true`。
- 如果 schema 没有下发，模型可能仍尝试调用工具并给出错误形状的 input；runtime 的 schema 错误应提供清晰提示。

建议扩展字段：

```ts
export type PolitDeckToolDefinition<Input = unknown, Output = unknown> = {
  // ...existing fields
  shouldDefer?: boolean;
  alwaysLoad?: boolean;
  searchHint?: string;
};
```

`ToolSearch` 后续实现时需要维护“本 turn 已发现工具集合”，只把已发现 deferred tool 的 schema 加入后续 model request。`list_mcp_resources`、`read_mcp_resource` 和多数 MCP 工具也应纳入该生态。

## 9. 输入 schema 校验

当前根项目没有 `zod` / `ajv`，第一版建议实现轻量 JSON schema validator。

必须支持：

- object root。
- required。
- additionalProperties。
- string。
- number。
- integer。
- boolean。
- array。
- object。
- enum。
- nullable 可通过 `type: ["string", "null"]` 后续再支持。

错误格式：

```ts
export type PolitDeckToolValidationIssue = {
  path: string;
  code:
    | "required"
    | "unknown_property"
    | "invalid_type"
    | "invalid_enum"
    | "invalid_schema";
  message: string;
};

export type PolitDeckToolValidationResult =
  | { ok: true; input: unknown }
  | { ok: false; issues: PolitDeckToolValidationIssue[] };
```

第一版不支持：

- oneOf / anyOf / allOf。
- patternProperties。
- $ref。
- format。
- complex numeric constraints。

如果后续引入 `ajv`，必须把 validator 封装在 `validateToolInput.ts` 内，不允许工具直接依赖第三方 validator。

## 9.1 文件路径安全

文件路径安全是 read/search/edit/write/bash 权限一致性的核心。不要把路径判断散落在各个工具里，应提供统一 helper。

建议新增：

```text
src/tool/builtin/filesystem/
  pathSafety.ts
  readTextFile.ts
  writeTextFile.ts
```

核心接口：

```ts
export type PolitDeckPathSafetyResult =
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; error: PolitDeckToolError };

export function resolvePolitDeckWorkspacePath(
  inputPath: string,
  context: PolitDeckToolRuntimeContext,
): PolitDeckPathSafetyResult;
```

规则：

- 相对路径以 `context.cwd` 为根。
- 绝对路径必须落在 `context.cwd` 或 `additionalWorkingDirectories` 内。
- 路径规范化后再判断，防止 `../` 绕过。
- symlink 第一版建议 resolve realpath 后再判断。
- 默认拒绝写入 `.git/`、`node_modules/`、`dist/`，除非后续 config 明确允许。
- 文件不存在时，read 返回 `file_not_found`，write create 可以继续。
- 目录被当作文件读取时返回 `invalid_tool_input` 或更具体的 `file_conflict`。

权限规则中涉及路径时，统一使用规范化后的相对路径做 pattern match，避免同一文件因绝对/相对路径写法不同而绕过规则。

## 10. ToolRuntime 执行链路

```ts
export class PolitDeckToolRuntime {
  constructor(
    private readonly registry: PolitDeckToolRegistry,
    private readonly permissionRuntime: PermissionRuntime,
  ) {}

  async execute(call: PolitDeckToolCall, context: PolitDeckToolRuntimeContext): Promise<PolitDeckToolResult> {
    // 1. lookup
    // 2. schema validation
    // 3. tool validateInput
    // 4. permission decision
    // 5. audit permission
    // 6. execute if allow
    // 7. normalize result
    // 8. audit result
  }
}
```

详细步骤：

```text
receive CanonicalToolCall
  -> find tool by name or alias
  -> if missing return tool_not_found result
  -> validate input with tool.inputSchema
  -> if invalid return invalid_tool_input result
  -> call tool.validateInput if defined
  -> if invalid return invalid_tool_input result
  -> permissionRuntime.decide(tool, input, context)
  -> record permission audit
  -> if deny return permission_denied result
  -> if cancel return permission_cancelled result
  -> if ask return permission_required result, unless caller supports interactive ask
  -> execute tool with abort signal
  -> normalize success output
  -> catch and normalize errors
  -> record tool audit
```

`ToolRuntime` 不能：

- 跳过 permission。
- 直接处理 UI prompt。
- 让工具返回 provider-specific SDK block。
- 把异常泄漏到 agent loop。
- 让工具自己决定是否写 audit。
- 让工具自己决定 result 是否截断。

## 11. Scheduler 设计

第一版只实现顺序调度器。

```ts
export type PolitDeckToolScheduler = {
  executeAll(
    calls: PolitDeckToolCall[],
    context: PolitDeckToolRuntimeContext,
  ): Promise<PolitDeckToolResult[]>;
};

export class SequentialToolScheduler implements PolitDeckToolScheduler {
  constructor(private readonly runtime: PolitDeckToolRuntime) {}

  async executeAll(calls: PolitDeckToolCall[], context: PolitDeckToolRuntimeContext): Promise<PolitDeckToolResult[]> {
    const results: PolitDeckToolResult[] = [];
    for (const call of calls) {
      results.push(await this.runtime.execute(call, context));
    }
    return results;
  }
}
```

后续并发调度时再引入：

- `isConcurrencySafe` 分组。
- sibling abort。
- progress stream。
- long-running background task。

### 11.1 后续并发调度对标

旧项目支持同一 assistant message 中多个 tool call 的分区执行：

- 连续且 `isConcurrencySafe(input)=true` 的只读工具可以并行。
- 非 concurrency-safe 工具必须串行。
- 并行批次结束后再进入后续串行工具。
- 默认并发上限来自环境或 runtime config。
- 如果工具返回 context modifier，必须在结果收集后按原始 tool call 顺序应用，避免并发写入导致状态乱序。

PolitDeck 第一版只做顺序调度，但类型设计必须保留动态 `isConcurrencySafe(input)`。后续实现并发时可采用：

```text
partition tool calls into batches
  -> run concurrency-safe read-only batch in parallel
  -> run unsafe tools serially
  -> preserve output order
  -> apply context modifiers in original order
```

## 11.2 Progress、Hooks 与 Background 的预留边界

旧项目里 tool progress、pre/post hook、background task 都和执行链路交织很深。PolitDeck 第一版明确暂缓完整实现，但需要预留边界，避免未来加功能时重写 runtime。

### Progress

第一版 `ToolRuntime.execute()` 返回 `Promise<PolitDeckToolResult>`，不做 streaming progress。但可以预留可选 sink：

```ts
export type PolitDeckToolProgressEvent = {
  type: "tool_progress";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type PolitDeckToolProgressSink = (event: PolitDeckToolProgressEvent) => void | Promise<void>;
```

第一版工具可以不发 progress。即使未来发 progress，也必须满足：

- progress 不进入 model messages。
- progress 不替代最终 `tool_result`。
- progress event 可以丢失，不能影响工具正确性。

### Hooks

第一版不实现 plugin hook runtime，但 `ToolRuntime` 的步骤必须保留插入点：

```text
validate input
  -> preToolUse hook insertion point
  -> permission decision
  -> execute tool
  -> postToolUse hook insertion point
  -> postToolUseFailure hook insertion point
```

未来 hook allow 不能覆盖：

- deny rule。
- ask rule。
- safety deny。
- path boundary。

未来 hook runtime 至少要定义三条分支：

- hook `deny`：直接拒绝。
- hook `ask`：作为强制 ask 进入 adapter / UI 层，或继续走完整 permission runtime；二者只能选一种并测试。
- hook `allow`：仍必须重放 rule / safety / path 检查，不能直接执行工具。

### Background Task

第一版 `bash.allowBackground=false`。如果后续支持 background task，必须先引入独立 `task` runtime，不要把 task 状态塞进 `ToolResult`。

预留 result metadata：

```ts
export type PolitDeckBackgroundTaskMetadata = {
  taskId: string;
  outputPath?: string;
  status: "running" | "completed" | "failed" | "cancelled";
};
```

后续如果兼容旧项目 background shell，需要补齐最小 task 协议：

- `run_in_background`。
- `task_id`。
- `task_output` 的 `block` / `timeout` / `retrieval_status`。
- `task_stop` 的 `task_id` 和历史别名 `KillShell`。
- task 输出文件或 artifact 路径。

Task 状态不应塞进普通 `ToolResult` 正文，应该由独立 task runtime 管理，tool result 只返回 task handle 和摘要。

## 12. Audit 设计

第一版 audit 只记录结构，不一定写入持久化文件。

```ts
export type PolitDeckPermissionAuditRecord = {
  type: "permission";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  mode: PermissionMode;
  decision: PermissionDecision["type"];
  reason: PermissionDecisionReason;
  createdAt: string;
};

export type PolitDeckToolAuditRecord = {
  type: "tool";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  status: "success" | "error";
  errorCode?: PolitDeckToolErrorCode;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};
```

事件命名：

```text
politdeck_tool_started
politdeck_tool_input_invalid
politdeck_tool_permission_decided
politdeck_tool_completed
politdeck_tool_failed
politdeck_tool_aborted
```

## 13. Builtin Tool 功能设计

### 13.1 ReadFile

名称：

```text
read_file
```

功能：

- 读取文本文件。
- 支持 `offset` / `limit`。
- 支持路径必须在 cwd 或 allowed directories 内。
- 第一版只读文本，不处理图片、PDF、notebook。

输入：

```ts
{
  filePath: string;
  offset?: number;
  limit?: number;
}
```

权限：

- `isReadOnly` true。
- default allow。
- plan allow。
- 路径越界 deny。

结果：

```ts
{
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
}
```

后续扩展：

- image。
- PDF text。
- notebook cell。
- unchanged cache。
- binary detection。

### 13.2 Glob

名称：

```text
glob
```

功能：

- 按 glob pattern 返回文件路径。
- 默认从 cwd 搜索。
- 自动忽略 `.git`、`node_modules`、`dist` 可配置。

输入：

```ts
{
  pattern: string;
  path?: string;
  limit?: number;
}
```

权限：

- read-only。
- default / plan allow。
- path 越界 deny。

结果：

```ts
{
  files: string[];
  count: number;
  truncated: boolean;
}
```

### 13.3 Grep

名称：

```text
grep
```

功能：

- 内容搜索。
- 第一版可以调用内部 `ripgrep` wrapper 或 Node 实现。
- 支持 content / files_with_matches / count。

输入：

```ts
{
  pattern: string;
  path?: string;
  glob?: string;
  outputMode?: "content" | "files_with_matches" | "count";
  before?: number;
  after?: number;
  context?: number;
  caseInsensitive?: boolean;
  headLimit?: number;
  offset?: number;
  multiline?: boolean;
}
```

权限：

- read-only。
- default / plan allow。
- path 越界 deny。

结果：

```ts
{
  mode: "content" | "files_with_matches" | "count";
  files: string[];
  content?: string;
  count: number;
  truncated: boolean;
}
```

### 13.4 Bash

名称：

```text
bash
```

功能：

- 执行 shell command。
- 支持 timeout。
- 支持 description。
- 第一版不做 background task。
- 第一版不做 classifier。

输入：

```ts
{
  command: string;
  timeoutMs?: number;
  description?: string;
}
```

为了让单测和真实执行解耦，`bash` 必须通过可注入 runner 执行命令：

```ts
export type PolitDeckCommandRunner = {
  run(command: string, options: PolitDeckCommandOptions): Promise<PolitDeckCommandResult>;
};

export type PolitDeckCommandOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type PolitDeckCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};
```

单测默认使用 fake runner；只有明确标记为 safe command 的测试可以使用真实 runner。

权限：

- 动态判断 read-only。
- `pwd`、`ls`、`git status`、`npm test` 可视为低风险，但仍建议第一版默认 ask。
- `rm`、`mv`、`chmod`、`curl | sh`、`sudo`、`git push`、`git reset` 等危险命令 deny 或 ask。
- `bypassPermissions` 可允许普通命令，但 safety deny 不可绕过。
- `plan` 默认 deny 非只读命令。

第一版安全规则：

```text
deny:
  rm -rf /
  sudo
  chmod -R 777
  chown -R
  git reset --hard
  git clean -fd
  curl ... | sh
  wget ... | sh
  dd if=

ask:
  rm
  mv
  cp over existing
  git push
  git commit
  npm install
  pnpm install
  bun install
  network commands

allow:
  pwd
  ls
  git status
  git diff
  git log
```

结果：

```ts
{
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}
```

### 13.5 EditFile

名称：

```text
edit_file
```

功能：

- 用 `oldString` / `newString` 做精确替换。
- 默认只允许替换一次。
- `replaceAll` 可选。
- 要求 `oldString` 唯一，除非 `replaceAll=true`。

输入：

```ts
{
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}
```

权限：

- 非 read-only。
- `acceptEdits` allow。
- `default` ask。
- `plan` deny。
- path 越界 deny。

结果：

```ts
{
  filePath: string;
  replacements: number;
  changed: boolean;
}
```

### 13.6 WriteFile

名称：

```text
write_file
```

功能：

- 新建或覆盖文件。
- 第一版建议只允许创建新文件；覆盖必须显式 `allowOverwrite=true`。

输入：

```ts
{
  filePath: string;
  content: string;
  allowOverwrite?: boolean;
}
```

权限：

- 非 read-only。
- destructive when overwrite。
- `acceptEdits` allow for normal workspace files。
- `default` ask。
- `plan` deny。

结果：

```ts
{
  filePath: string;
  action: "created" | "overwritten";
  bytesWritten: number;
}
```

### 13.7 AskUserQuestion

名称：

```text
ask_user_question
```

功能：

- 向宿主 UI 请求结构化选择。
- 第一版没有 UI 时返回 `permission_required` 或 `unsupported_tool`。

输入：

```ts
{
  questions: Array<{
    id: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
    allowMultiple?: boolean;
  }>;
}
```

权限：

- read-only。
- requires user interaction。
- canPrompt=false 时不可执行。

### 13.8 WebFetch

名称：

```text
web_fetch
```

功能：

- 获取 URL 内容。
- 第一版只 fetch markdown/text，不做模型二次摘要。

权限：

- read-only 但 open-world。
- default ask 或按 domain allow。
- plan 可 ask。
- dontAsk deny。

### 13.9 WebSearch

名称：

```text
web_search
```

功能：

- 搜索互联网。
- 第一版可留接口，不接具体 provider。

权限：

- read-only 但 open-world。
- default ask 或按配置 allow。

### 13.10 MCP Tool

名称：

```text
mcp__<server>__<tool>
```

功能：

- 将 MCP server 的 tool schema 包装为 PolitDeck tool。

权限：

- 默认 passthrough。
- 由 MCP tool metadata、server trust level、permission rules 决定。
- PolitDeck 建议按 open-world 处理，因为 MCP server 能力来自外部进程或远端服务。旧项目的 `isOpenWorld()` 字段默认可能为 false，但权限仍通过 passthrough 和规则管线控制；这是字段语义差异，不是权限放宽。

第一版只定义 adapter interface：

```ts
export type PolitDeckMcpToolAdapter = {
  listTools(serverId: string): Promise<PolitDeckToolDefinition[]>;
  callTool(serverId: string, toolName: string, input: unknown): Promise<unknown>;
};
```

MCP tool name 必须稳定且可逆：

- wire name 格式固定为 `mcp__<normalizedServerId>__<normalizedToolName>`。
- normalized name 只能包含 ASCII 字母、数字和下划线。
- adapter metadata 必须保留原始 `serverId` 和 `toolName`，不要只存 normalized name。
- 权限规则匹配 wire name，audit 同时记录 wire name 和原始 MCP 名称。
- 如果两个 MCP tool 归一化后冲突，registry 必须拒绝注册并返回清晰错误。
- 不要通过字符串反解析作为唯一真相；旧项目的 `mcp__server__tool` 格式在 server 或 tool 名包含 `__` 时会有歧义。PolitDeck 必须以 metadata 中的原始名称为准。

后续 MCP adapter 还需要预留：

- `mcp__<server>__authenticate` 伪工具，用于 OAuth / auth URL 引导。
- URL elicitation callback，用于 MCP 调用返回需要用户打开 URL 或补充认证的场景。
- stdio / HTTP / SSE transport 差异。
- MCP server 级别 deny 时，从模型工具 schema 中移除该 server 下全部工具。

### 13.11 ListMcpResources / ReadMcpResource

名称：

```text
list_mcp_resources
read_mcp_resource
```

第一版骨架：

- 输入 schema。
- permission。
- adapter interface。
- fake tests。

### 13.12 StructuredOutput

名称：

```text
structured_output
```

功能：

- 非交互 SDK 场景中让模型给出最终 JSON。
- 第一版暂不进入普通 agent loop tool 列表。

## 14. 旧工具功能迁移矩阵

| 旧工具能力 | 旧 wire 名 | PolitDeck 工具名 | 第一阶段策略 | 备注 |
| --- | --- | --- | --- | --- |
| Agent delegation | `Agent`，历史别名 `Task` | `agent` | 暂缓 | 等 agent loop 稳定后实现；旧项目内置 subagent type 不是顶层 tool 名 |
| TaskOutput | `TaskOutput` | `task_output` | 暂缓 | 依赖后台任务系统 |
| Bash | `Bash` | `bash` | 实现 | 不做 background/classifier |
| Glob | `Glob` | `glob` | 实现 | 只读；旧项目在 embedded search 场景可能不暴露独立工具 |
| Grep | `Grep` | `grep` | 实现 | 只读；旧项目在 embedded search 场景可能不暴露独立工具 |
| Read | `Read` | `read_file` | 实现 | 第一版文本；旧项目入参偏绝对路径，PolitDeck 改为 workspace path |
| Edit | `Edit` | `edit_file` | 实现 | 精确替换 |
| Write | `Write` | `write_file` | 实现 | 创建/覆盖 |
| NotebookEdit | `NotebookEdit` | `edit_notebook` | 暂缓 | 后续扩展 |
| WebFetch | `WebFetch` | `web_fetch` | 骨架 | 网络权限先保守 |
| WebSearch | `web_search` | `web_search` | 骨架 | provider 后接 |
| TodoWrite | `TodoWrite` | `todo_write` | 暂缓 | session UI 功能 |
| Memory tools | `memory_overview` / `memory_list` / `memory_search` / `memory_get` / `memory_flush` / `memory_dream` | `memory_*` | 暂缓 | 依赖 memory subsystem |
| AlwaysOnDiscoveryPlan | `AlwaysOnDiscoveryPlan` | `always_on_discovery_plan` | 暂缓 | 产品专有 |
| ExitPlanMode | `ExitPlanMode` | `exit_plan_mode` | 骨架 | plan 模式后续完善 |
| EnterPlanMode | `EnterPlanMode` | `enter_plan_mode` | 骨架 | mode switch |
| TaskStop | `TaskStop`，历史别名 `KillShell` | `task_stop` | 骨架 | 依赖 background task |
| AskUserQuestion | `AskUserQuestion` | `ask_user_question` | 骨架 | 依赖 UI elicitation |
| Send user visible message | `SendUserMessage`，历史别名 `Brief` | `send_user_message` | 暂缓 | Kairos / 用户可见消息通道，非普通 assistant 文本 |
| Skill | `Skill` | `skill` | 暂缓 | 依赖 extension |
| SkillManage | `SkillManage` | `skill_manage` | 暂缓 | 依赖 skill 文件规范 |
| Config | `Config` | `config` | 暂缓 | 归属 `polit/config` |
| Task v2 CRUD | `TaskCreate` / `TaskGet` / `TaskUpdate` / `TaskList` | `task_*` | 暂缓 | 产品功能；in-process teammate 允许集与普通 agent 不同 |
| LSP | `LSP` | `lsp` | 骨架 | 依赖 LSP manager |
| Worktree | `EnterWorktree` / `ExitWorktree` | `worktree_*` | 暂缓 | 依赖 git/worktree runtime |
| SendMessage / Team | `SendMessage` / `TeamCreate` / `TeamDelete` | `team_*` | 暂缓 | swarm 专有 |
| PowerShell | `PowerShell` | `powershell` | 暂缓 | Windows 后续 |
| Cron | `CronCreate` / `CronDelete` / `CronList` | `cron_*` | 暂缓 | daemon 后续 |
| RemoteTrigger | `RemoteTrigger` | `remote_trigger` | 暂缓 | 远端会话后续 |
| ToolSearch | `ToolSearch` | `tool_search` | 暂缓 | deferred tools 多后再实现 |
| MCP tools | `mcp__<server>__<tool>`，另有通用占位 `mcp` | `mcp__*` | 骨架 | adapter 优先 |
| MCP resources | `ListMcpResourcesTool` / `ReadMcpResourceTool` | `list_mcp_resources` / `read_mcp_resource` | 骨架 | 旧项目属于特殊/延迟注册路径 |
| MCP auth | `mcp__<server>__authenticate` | `mcp__*__authenticate` | 暂缓 | OAuth 后续 |
| Structured output | `StructuredOutput` | `structured_output` | 骨架 | 旧项目通常由非交互会话动态挂载，不一定在 base tools |
| Sleep | `Sleep` | `sleep` | 暂缓 | 特性构建片段，非核心 tool runtime 能力 |
| REPL | `REPL` | `repl` | 暂缓 | 宿主内嵌 REPL 专用，不等价于 `bash` |
| Workflow | `Workflow` | `workflow` | 暂缓 | 特性构建片段，当前 third-party 子树不完整 |
| Tungsten | `tungsten` | `tungsten` | 不实现 | internal stub |
| TestingPermission | `TestingPermission` | `testing_permission` | 仅测试 | 不进生产 |

## 15. Model 集成方式

Tool registry 向 model 暴露 schema：

```ts
const tools = registry.toCanonicalSchemas();

const request: CanonicalModelRequest = {
  provider,
  model,
  messages,
  tools,
  toolChoice: "auto",
};
```

模型返回 tool call 后：

```ts
const results = await scheduler.executeAll(toolCalls, toolContext);
const resultBlocks = results.map(toCanonicalToolResultBlock);
```

再交给 context runtime：

```ts
turnState = await contextRuntime.applyToolResults(resultBlocks, turnState);
```

重要边界：

- `model` 不知道工具如何执行。
- `tool` 不知道 provider SDK。
- `permission` 不知道 UI。
- `agent` 只编排调用顺序。

## 16. Config 集成方式

后续全局配置建议放在：

```text
~/.politdeck/politdeck.yaml
```

建议配置结构：

```yaml
tool:
  enabled:
    - read_file
    - glob
    - grep
    - bash
    - edit_file
    - write_file
  disabled: []
  maxResultBytes: 200000
  filesystem:
    additionalWorkingDirectories: []
    ignore:
      - .git
      - node_modules
      - dist
  bash:
    defaultTimeoutMs: 30000
    maxTimeoutMs: 600000
    allowBackground: false

permission:
  defaultMode: default
  bypassAvailable: false
  rules:
    allow: []
    deny: []
    ask: []
```

配置读取归属：

- `polit/config` 读取 YAML。
- `tool` 消费 `config.tool`。
- `permission` 消费 `config.permission`。

## 17. 测试计划

### 17.1 Registry 测试

必须覆盖：

- 注册工具。
- 重复 name 报错。
- alias 查找。
- alias 与真实 name 冲突报错。
- `list()` 顺序稳定。
- `toCanonicalSchemas()` 输出正确。

### 17.2 Input Validation 测试

必须覆盖：

- required 缺失。
- unknown property。
- type mismatch。
- enum mismatch。
- nested object。
- array item type。
- valid input pass。

### 17.3 Permission 测试

必须覆盖：

- default + read-only -> allow。
- default + write -> ask。
- plan + read-only -> allow。
- plan + write -> deny 或 ask。
- acceptEdits + edit/write -> allow。
- bypassPermissions + normal ask -> allow。
- bypassPermissions + safety deny -> deny。
- dontAsk + ask -> deny。
- deny rule 优先于 allow rule。
- ask rule 不被 bypass 覆盖。

### 17.4 Runtime 测试

必须覆盖：

- tool not found -> error result。
- invalid schema -> error result。
- validateInput fail -> error result。
- permission deny -> error result。
- permission ask without UI -> error result。
- execute success -> success result。
- execute throw -> normalized error result。
- abort signal -> aborted result。
- result too large -> truncated 或 `result_too_large`。
- audit recorder called。

### 17.5 Scheduler 测试

必须覆盖：

- 顺序执行多个 call。
- 前一个失败不阻断后一个。
- 返回顺序与输入顺序一致。

### 17.6 Builtin 测试

ReadFile：

- 读存在文件。
- offset / limit。
- 文件不存在。
- 目录路径报错。
- 路径越界 deny。
- 大结果截断。
- symlink / `../` 不能绕过 workspace。

Glob：

- 匹配文件。
- limit truncation。
- path 越界。

Grep：

- content mode。
- files_with_matches。
- count。
- headLimit / offset。
- case insensitive。

Bash：

- allow read-only command。
- dangerous command deny。
- timeout。
- non-zero exit code 不等于 runtime throw。
- fake command runner 覆盖危险命令，不真实执行危险操作。

EditFile：

- 单次替换。
- oldString 不存在。
- oldString 多处但 replaceAll=false。
- replaceAll。

WriteFile：

- create new file。
- overwrite denied unless allowOverwrite。

## 18. 分阶段开发计划

### Phase 1：协议和内核

交付：

- `src/tool/protocol/*`
- `src/permission/protocol/*`
- `ToolRegistry`
- `validateToolInput`
- `PermissionRuntime`
- `ToolRuntime`
- `SequentialToolScheduler`
- result mapping。
- audit record。

验收：

- 所有 protocol / runtime 测试通过。
- 无 builtin 也能用 fake tool 完成完整链路。

### Phase 2：文件和搜索工具

交付：

- `read_file`
- `glob`
- `grep`
- 文件路径 permission helper。

验收：

- read/search 工具在 default 和 plan 下可执行。
- 路径越界被 deny。

### Phase 3：编辑工具

交付：

- `edit_file`
- `write_file`
- acceptEdits mode。

验收：

- default 下编辑需要 ask。
- acceptEdits 下编辑 allow。
- plan 下编辑 deny。

### Phase 4：Shell

交付：

- `bash`
- 命令分类最小规则。
- timeout。

验收：

- 安全命令可执行。
- 危险命令不可被 bypass 绕过 safety deny。
- 非零 exit code 被包装为 success output 或 controlled error，策略需固定。

建议：非零 exit code 仍返回 `success`，因为 shell 命令执行成功完成，只是进程失败；只有 spawn 失败、timeout、abort 才是 tool runtime error。

### Phase 5：骨架工具

交付：

- `ask_user_question`
- `web_fetch`
- `web_search`
- `mcp__*`
- `list_mcp_resources`
- `read_mcp_resource`
- `structured_output`
- `enter_plan_mode`
- `exit_plan_mode`

验收：

- schema 稳定。
- unsupported implementation 返回标准错误。
- permission 行为明确。

## 19. 不变量

开发时必须遵守：

- 所有工具执行必须经过 `PermissionRuntime`。
- 所有工具输入必须经过 schema 校验。
- 所有 tool result 必须能转换成 canonical `tool_result`。
- 工具不得依赖 Anthropic/OpenAI SDK 类型。
- permission 不得依赖 React/Ink/UI。
- builtin tool 不得直接写 transcript。
- shell 非零退出码不得导致 agent loop 崩溃。
- path safety deny 不得被 `bypassPermissions` 绕过。
- `dontAsk` 只会更保守，不会更宽松。
- `plan` 模式默认无副作用。
- 旧项目名称不得进入 PolitDeck 新代码命名。

## 20. 代码风格约定

当前仓库使用：

- TypeScript。
- ESM。
- `moduleResolution: NodeNext`。
- 原生 `node:test`。
- `npm run build` 执行 `tsc`。
- `npm test` 先 build，再跑 `dist/tests/**/*.test.js`。

新增代码必须：

- import 带 `.js` 后缀。
- 使用 `type` import。
- 不引入未必要依赖。
- 错误码用 snake_case。
- 类型名用 `PolitDeck*` 前缀只用于公共协议，内部类可用短名如 `ToolRegistry`。
- 文件名保持清晰，不需要全部加 `PolitDeck` 前缀。

示例：

```ts
import type { CanonicalToolCall } from "../../model/index.js";
```

不要写：

```ts
import type { CanonicalToolCall } from "../../model";
```

## 21. 开发验收清单

第一轮 PR 合入前必须满足：

- `src/tool/index.ts` 导出公共类型和 runtime。
- `src/permission/index.ts` 导出公共类型和 runtime。
- fake tool 能完整走 lookup -> validation -> permission -> execute -> result。
- 至少一个 read-only 工具测试通过。
- 至少一个 write 工具权限测试通过。
- 标准错误 `tool_not_found`、`invalid_tool_input`、`permission_denied` 覆盖到。
- `npm run build` 通过。
- `npm test` 通过。

第二轮 PR 合入前必须满足：

- `read_file`、`glob`、`grep` 可用。
- 路径安全规则有测试。
- result block 映射有测试。

第三轮 PR 合入前必须满足：

- `edit_file`、`write_file` 可用。
- `acceptEdits` 模式有测试。
- overwrite 和 oldString 唯一性有测试。

第四轮 PR 合入前必须满足：

- `bash` 可用。
- timeout 有测试。
- 危险命令 deny 有测试。
- shell result 标准化有测试。

## 22. 需要暂不实现的旧能力

以下能力必须避免在第一版中混入，否则会拖慢 tool runtime 稳定：

- React/Ink UI 渲染函数。
- tool progress message streaming。
- post-tool result UI。
- telemetry SDK。
- classifier auto mode。
- speculative shell classifier。
- feature flag / GrowthBook。
- swarm mailbox。
- team create/delete。
- background subagent。
- remote session。
- cron daemon。
- managed policy loader。
- OAuth MCP auth。
- hooks plugin runtime。
- skill marketplace。
- memory dream / flush。
- notebook / PDF / image read。

如果需要保留扩展点，只定义 interface，不实现产品逻辑。

## 23. 推荐首批文件实现顺序

建议按这个提交顺序开发：

```text
1. src/permission/protocol/types.ts
2. src/tool/protocol/types.ts
3. src/tool/protocol/errors.ts
4. src/tool/protocol/result.ts
5. src/tool/registry/ToolRegistry.ts
6. src/tool/execution/validateToolInput.ts
7. src/permission/decision/PermissionRuntime.ts
8. src/tool/execution/ToolRuntime.ts
9. src/tool/scheduler/SequentialToolScheduler.ts
10. src/tool/builtin/readFile.ts
11. src/tool/builtin/glob.ts
12. src/tool/builtin/grep.ts
13. src/tool/builtin/editFile.ts
14. src/tool/builtin/writeFile.ts
15. src/tool/builtin/bash.ts
16. src/tool/registry/createBuiltinRegistry.ts
17. src/tool/index.ts
18. src/permission/index.ts
```

对应测试跟随实现文件同步添加。

## 24. 文档维护要求

本文件是 PolitDeck tool 重构的开发规范。后续如果实现策略发生变化，必须同步更新：

- 新增工具名。
- 工具 permission 策略。
- 错误码。
- result block 格式。
- config key。
- 阶段验收标准。

不要让代码和本文档在以下方面分叉：

- tool wire name。
- permission mode。
- error code。
- audit event。
- public type name。

