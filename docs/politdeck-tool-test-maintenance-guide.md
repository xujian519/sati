# PolitDeck Tool 单测维护与行为一致性文档

本文用于维护 PolitDeck tool 重构相关单元测试和回归测试。目标是让 `src/tool/` 与 `src/permission/` 重构完成后，在核心行为上与 `third-party/claude-code-main` 已验证的 tool 系统保持一致，同时避免把旧项目 UI、telemetry、实验开关和产品特例原样搬入 PolitDeck。

配套开发设计见：

- `docs/politdeck-tool-refactor-development-guide.md`

## 1. 测试目标

Tool 测试必须保证以下四件事：

- PolitDeck tool 协议稳定，模型侧只看到 canonical tool schema 和 canonical tool result。
- Tool 执行链路稳定，任何 tool call 都固定经过 lookup、input validation、permission decision、execution、result mapping。
- Permission 行为稳定，尤其是 `default`、`plan`、`acceptEdits`、`bypassPermissions`、`dontAsk` 的差异。
- 重构后的核心工具行为与旧项目一致，包括 read/search/edit/write/shell 的成功、失败、权限、路径安全和错误语义。

本文中的“行为一致”不是指逐字节复制旧 UI 文案，而是指以下外部可观察行为一致：

- 同样的 tool call 是否允许执行。
- 同样的非法输入是否被拒绝。
- 同样的错误场景是否返回标准 error tool result。
- 同样的 shell 非零退出是否不让 agent loop 崩溃。
- 同样的路径越界或危险操作是否不可被普通 bypass 绕过。
- 同样的 tool result 是否能被模型作为 `tool_result` 消费。

## 2. 测试命名规则

测试中所有新代码、fixture、helper、事件名、错误码都必须使用 PolitDeck 命名。

允许出现旧项目名称的位置：

- 源码路径引用，例如 `third-party/claude-code-main/src/Tool.ts`。
- 旧行为说明，例如“旧项目行为基线”。
- fixture 文件夹名称中的 `legacy`，表示旧行为快照，不表示品牌名。

禁止出现：

- 新类型名使用旧项目前缀。
- 新事件名使用旧项目前缀。
- 新配置 key 使用旧项目前缀。
- 新测试 helper 使用旧项目前缀。

推荐命名：

```text
tests/tool/
tests/permission/
tests/fixtures/tool/
tests/fixtures/tool/legacy-behavior/
```

推荐 helper 名：

```ts
createPolitDeckTestTool()
createPolitDeckToolRuntime()
createPolitDeckPermissionContext()
assertPolitDeckToolError()
assertCanonicalToolResult()
```

## 3. 测试分层

PolitDeck tool 测试分为六层。越底层越快，越上层越接近真实 agent loop。

```text
protocol tests
  -> registry tests
  -> permission policy tests
  -> runtime tests
  -> builtin tool tests
  -> behavior parity tests
```

### 3.1 Protocol Tests

验证纯类型和结构转换：

- `PolitDeckToolResult` 能转换为 `CanonicalToolResultBlock`。
- success result 的 `isError` 为空或 false。
- error result 的 `isError` 为 true。
- JSON / file / image content 在第一版能安全降级为 text。
- tool error code 稳定。

建议文件：

```text
tests/tool/protocol-result.test.ts
tests/tool/protocol-errors.test.ts
```

### 3.2 Registry Tests

验证 tool 注册和 canonical schema 输出：

- register。
- duplicate name。
- alias lookup。
- alias conflict。
- stable sorted list。
- `toCanonicalSchemas()`。

建议文件：

```text
tests/tool/registry.test.ts
```

### 3.3 Permission Policy Tests

验证 permission 决策顺序和 mode 语义：

- deny rule 优先。
- ask rule 优先于 bypass。
- tool safety deny 不可被 bypass。
- plan 模式只允许 read-only。
- acceptEdits 只放宽 edit/write。
- dontAsk 把 ask 变成 deny。

建议文件：

```text
tests/permission/permission-runtime.test.ts
tests/permission/permission-rules.test.ts
```

### 3.4 Runtime Tests

验证 `ToolRuntime.execute()` 完整链路：

- unknown tool。
- invalid schema。
- tool-specific validation fail。
- permission deny。
- permission ask without UI。
- execute success。
- execute throw。
- abort。
- audit。

建议文件：

```text
tests/tool/runtime.test.ts
tests/tool/scheduler.test.ts
```

### 3.5 Builtin Tool Tests

验证每个内置工具的业务行为：

```text
tests/tool/builtin-read-file.test.ts
tests/tool/builtin-glob.test.ts
tests/tool/builtin-grep.test.ts
tests/tool/builtin-bash.test.ts
tests/tool/builtin-edit-file.test.ts
tests/tool/builtin-write-file.test.ts
```

### 3.6 Behavior Parity Tests

验证从旧项目提炼出的行为基线：

```text
tests/tool/parity-filesystem.test.ts
tests/tool/parity-permission.test.ts
tests/tool/parity-bash.test.ts
tests/tool/parity-result.test.ts
```

Parity test 不应该 import 旧项目源码。它们应该读取 PolitDeck 自己维护的 fixture 和 scenario，作为重构后的稳定契约。

## 4. 行为基线维护方式

旧项目 tool 行为来源主要有：

- `third-party/claude-code-main/src/Tool.ts`
- `third-party/claude-code-main/src/tools.ts`
- `third-party/claude-code-main/src/services/tools/toolExecution.ts`
- `third-party/claude-code-main/src/services/tools/toolOrchestration.ts`
- `third-party/claude-code-main/src/services/tools/StreamingToolExecutor.ts`
- `third-party/claude-code-main/src/utils/permissions/permissions.ts`
- `third-party/claude-code-main/src/hooks/useCanUseTool.tsx`
- `third-party/claude-code-main/src/tools/*`

维护基线时不要把旧源码当 runtime dependency。正确方式是把旧行为整理成 scenario：

```ts
export type PolitDeckToolBehaviorScenario = {
  name: string;
  toolName: string;
  input: unknown;
  permissionMode: PermissionMode;
  expectedDecision?: "allow" | "deny" | "ask" | "cancel";
  expectedResultType?: "success" | "error";
  expectedErrorCode?: PolitDeckToolErrorCode;
  notes?: string;
};
```

fixture 建议放在：

```text
tests/fixtures/tool/legacy-behavior/
  filesystem.scenarios.ts
  permission.scenarios.ts
  bash.scenarios.ts
  result.scenarios.ts
```

每个 scenario 必须说明对应旧行为来源：

```ts
{
  name: "plan mode denies write_file",
  toolName: "write_file",
  input: { filePath: "src/example.ts", content: "x" },
  permissionMode: "plan",
  expectedDecision: "deny",
  expectedResultType: "error",
  expectedErrorCode: "permission_denied",
  notes: "Derived from old plan mode behavior: plan should avoid side effects.",
}
```

## 4.1 Parity Pass 执行流程

Parity pass 是重构完成度的最终确认流程。它不是简单跑现有单测，而是把旧项目可观察行为逐项转成 PolitDeck 的长期测试资产。

每轮 parity pass 按以下顺序执行：

1. 选定范围：例如 `Read`、`Grep`、`Bash`、permission runtime 或 MCP tool。
2. 查旧源码：读取对应旧工具实现、prompt、permission、runtime result mapping 和相关测试。
3. 提取行为点：把成功、失败、权限、输入校验、输出格式、边界条件列成清单。
4. 分类行为：标记为 `must_match`、`intentional_difference`、`deferred` 或 `not_applicable`。
5. 写 scenario：把 `must_match` 和重要 `intentional_difference` 写入 `tests/fixtures/tool/legacy-behavior/`。
6. 写 parity test：用 PolitDeck runtime 跑 scenario，不 import 旧源码。
7. 修实现：所有 `must_match` 必须通过；`intentional_difference` 必须有明确断言和说明。
8. 更新文档：如果差异是产品选择，必须同步更新开发文档和本文档。

Parity pass 结束时，需要在 PR 描述或变更说明里给出：

```text
Parity scope:
- Read
- Glob/Grep
- Bash permission

Must-match scenarios:
- total: 42
- passing: 42

Intentional differences:
- Read image/PDF unsupported in Phase 1
- Bash background tasks deferred

Deferred:
- ToolSearch
- MCP OAuth
```

## 4.2 Scenario 分类标准

每个 legacy behavior scenario 必须带 `parity` 分类。

```ts
export type PolitDeckToolParityStatus =
  | "must_match"
  | "intentional_difference"
  | "deferred"
  | "not_applicable";

export type PolitDeckToolBehaviorScenario = {
  name: string;
  legacyToolName: string;
  politdeckToolName: string;
  input: unknown;
  permissionMode: PermissionMode;
  parity: PolitDeckToolParityStatus;
  source: LegacyBehaviorSource[];
  expectedDecision?: "allow" | "deny" | "ask" | "cancel";
  expectedResultType?: "success" | "error";
  expectedErrorCode?: PolitDeckToolErrorCode;
  expectedContentIncludes?: string[];
  expectedData?: unknown;
  intentionalDifferenceReason?: string;
  deferredUntil?: string;
  notes?: string;
};

export type LegacyBehaviorSource = {
  path: string;
  symbol?: string;
  summary: string;
};
```

分类含义：

- `must_match`：PolitDeck 必须匹配旧行为。测试失败就是实现问题。
- `intentional_difference`：PolitDeck 明确选择不同。必须断言 PolitDeck 新行为，并写清原因。
- `deferred`：旧行为重要，但当前阶段暂缓。必须写 `deferredUntil`，例如 `tool-search-phase`。
- `not_applicable`：旧行为依赖旧项目专有产品线，PolitDeck 不迁移。

`intentional_difference` 只能用于以下情况：

- PolitDeck 更保守，例如危险 shell 命令从 ask 改为 deny。
- PolitDeck 第一版范围缩小，例如 read 只支持文本。
- 旧行为依赖 UI、telemetry、classifier、swarm、remote bridge。
- 旧行为是历史兼容路径，PolitDeck 不需要支持。

不能标为 intentional difference 的情况：

- invalid input 进入 execute。
- 路径越界变成 allow。
- safety deny 被 bypass。
- tool throw 逃逸 agent loop。
- canonical `tool_result` 结构不稳定。

## 4.3 Legacy 行为提取模板

每次从旧源码提取行为时，先写 extraction note。建议放在 scenario 文件顶部注释中。

```ts
/**
 * Legacy extraction: Read tool
 *
 * Sources:
 * - third-party/claude-code-main/src/tools/FileReadTool/FileReadTool.ts
 * - third-party/claude-code-main/src/tools/FileReadTool/prompt.ts
 * - third-party/claude-code-main/src/utils/permissions/filesystem.ts
 *
 * Observed behavior:
 * - Read is read-only.
 * - Missing files return controlled tool error.
 * - File path must stay within allowed roots.
 * - Old implementation supports images/PDF/notebooks; PolitDeck Phase 1 only supports UTF-8 text.
 *
 * Intentional differences:
 * - PolitDeck accepts workspace-relative paths; old prompt prefers absolute file_path.
 */
```

提取时必须同时看四类文件：

- 工具定义：schema、name、alias、read-only、destructive、concurrency。
- 权限逻辑：`checkPermissions`、filesystem/shell permission helper。
- 执行链路：输入校验、hook、permission、result mapping、error normalization。
- prompt / constants：wire name、参数命名、模型可见说明。

## 4.4 Parity Scenario 文件组织

推荐把 scenario 按行为域拆分，而不是按 PolitDeck 文件名拆分：

```text
tests/fixtures/tool/legacy-behavior/
  registry.scenarios.ts
  permission-modes.scenarios.ts
  permission-rules.scenarios.ts
  result-mapping.scenarios.ts
  filesystem-read.scenarios.ts
  filesystem-search.scenarios.ts
  filesystem-edit-write.scenarios.ts
  bash-execution.scenarios.ts
  bash-permission.scenarios.ts
  mcp.scenarios.ts
  deferred-tools.scenarios.ts
  skeleton-tools.scenarios.ts
```

对应 parity tests：

```text
tests/tool/parity-registry.test.ts
tests/tool/parity-permission.test.ts
tests/tool/parity-result.test.ts
tests/tool/parity-filesystem.test.ts
tests/tool/parity-bash.test.ts
tests/tool/parity-mcp.test.ts
tests/tool/parity-deferred.test.ts
```

Parity tests 应该做两件事：

- 跑所有 `must_match` scenario。
- 跑 `intentional_difference` scenario，确认 PolitDeck 行为就是文档声明的新行为。

默认不执行 `deferred` 和 `not_applicable`，但要统计数量，避免被遗忘。

## 4.5 Parity Pass 覆盖清单

每个工具都要按下面维度过一遍。没有覆盖的维度必须写原因。

### Tool Contract

- 旧 wire name。
- PolitDeck tool name。
- aliases。
- input schema。
- output shape。
- read-only。
- destructive。
- concurrency-safe。
- open-world。
- deferred / always-load。
- max result size。

### Permission

- default mode。
- plan mode。
- acceptEdits。
- bypassPermissions。
- dontAsk。
- deny rule。
- ask rule。
- allow rule。
- safety deny。
- path boundary。
- no prompt / non-interactive。

### Execution

- success。
- invalid input。
- missing resource。
- permission denied。
- permission required。
- cancellation。
- abort。
- timeout。
- thrown error normalization。
- non-zero process exit, if shell-like。

### Result Mapping

- canonical `tool_result` shape。
- `isError`。
- empty output placeholder。
- JSON content lowering。
- file/image fallback。
- truncation metadata。
- raw result retention。

### Agent Loop Interaction

- multiple tool calls order。
- sequential vs concurrency-safe behavior。
- whether progress is excluded from model messages。
- whether background task returns a handle rather than blocking.
- whether hidden/deferred tool schema is absent from model request.

## 4.6 Must-Match Gates

以下 gates 没过时，不能宣称和重构前行为一致：

- `Read` / `read_file` parity：文本读取、missing file、directory path、path boundary、large result truncation。
- `Glob` / `glob` parity：pattern matching、ignore directories、limit、path boundary。
- `Grep` / `grep` parity：files mode、content mode、count mode、case-insensitive、context、limit/offset、no matches。
- `Edit` / `edit_file` parity：exact replacement、missing old string、ambiguous old string、replace all、plan deny、acceptEdits allow。
- `Write` / `write_file` parity：create、overwrite denied、overwrite allowed、path boundary、plan deny。
- `Bash` / `bash` parity：safe command, dangerous deny, timeout, non-zero exit, bypass safety deny, plan side-effect deny。
- Permission parity：deny > ask > tool safety > bypass/default allow 的优先级。
- Result parity：所有失败都返回 error `tool_result`，不 throw 出 agent loop。

如果某项当前阶段没有实现，必须是 `deferred`，不能算通过。

## 4.7 Intentional Differences Register

所有 intentional differences 必须集中登记。建议新增：

```text
tests/fixtures/tool/legacy-behavior/intentional-differences.ts
```

格式：

```ts
export type PolitDeckIntentionalDifference = {
  id: string;
  legacyBehavior: string;
  politdeckBehavior: string;
  reason: string;
  risk: "lower" | "same" | "higher";
  reviewRequiredBeforeRelease: boolean;
};
```

示例：

```ts
{
  id: "read-relative-paths",
  legacyBehavior: "Read prompt prefers absolute file_path.",
  politdeckBehavior: "read_file accepts workspace-relative paths and normalizes them against cwd.",
  reason: "PolitDeck uses workspace-scoped runtime context.",
  risk: "same",
  reviewRequiredBeforeRelease: false,
}
```

风险规则：

- `lower`：PolitDeck 更保守，例如 dangerous command 直接 deny。
- `same`：行为不同但安全边界等价。
- `higher`：PolitDeck 更宽松。必须专门 review，不能静默合并。

## 4.8 Parity Pass 完成定义

只有满足以下条件，才能说“本范围已与重构前行为一致”：

- 范围内所有旧工具能力都被列入 scenario。
- 所有 `must_match` scenario 测试通过。
- 所有 `intentional_difference` 都有 register entry。
- 所有 `deferred` 都有明确阶段归属。
- 没有 `higher` risk intentional difference 未 review。
- `npm run build` 通过。
- 对应 parity tests 通过。
- 全量 `npm test` 通过。

如果只是 core tests 通过，只能说：

```text
当前实现符合 PolitDeck 文档定义的第一版行为。
```

不能说：

```text
当前实现和重构前行为完全一致。
```

## 5. 测试目录规范

推荐最终目录：

```text
tests/
  helpers/
    tool.ts
    permission.ts
    filesystem.ts
    assertions.ts

  fixtures/
    tool/
      files/
        basic/
        nested/
        binary/
      legacy-behavior/
        intentional-differences.ts
        registry.scenarios.ts
        permission-modes.scenarios.ts
        permission-rules.scenarios.ts
        result-mapping.scenarios.ts
        filesystem.scenarios.ts
        filesystem-read.scenarios.ts
        filesystem-search.scenarios.ts
        filesystem-edit-write.scenarios.ts
        permission.scenarios.ts
        bash.scenarios.ts
        bash-execution.scenarios.ts
        bash-permission.scenarios.ts
        mcp.scenarios.ts
        deferred-tools.scenarios.ts
        skeleton-tools.scenarios.ts
        result.scenarios.ts

  tool/
    protocol-result.test.ts
    protocol-errors.test.ts
    registry.test.ts
    input-validation.test.ts
    runtime.test.ts
    scheduler.test.ts
    builtin-read-file.test.ts
    builtin-glob.test.ts
    builtin-grep.test.ts
    builtin-bash.test.ts
    builtin-edit-file.test.ts
    builtin-write-file.test.ts
    parity-registry.test.ts
    parity-filesystem.test.ts
    parity-permission.test.ts
    parity-bash.test.ts
    parity-mcp.test.ts
    parity-deferred.test.ts
    parity-result.test.ts

  permission/
    permission-runtime.test.ts
    permission-rules.test.ts
    permission-audit.test.ts
```

当前仓库使用原生 `node:test`，所以测试文件保持：

```ts
import test from "node:test";
import assert from "node:assert/strict";
```

不要引入测试框架，除非项目统一决定迁移。

## 6. Test Helper 规范

### 6.1 Runtime Helper

推荐 helper：

```ts
export function createPolitDeckToolRuntimeFixture(options?: {
  tools?: PolitDeckToolDefinition[];
  permissionMode?: PermissionMode;
  canPrompt?: boolean;
}): {
  registry: ToolRegistry;
  permissionRuntime: PermissionRuntime;
  toolRuntime: ToolRuntime;
  context: PolitDeckToolRuntimeContext;
};
```

要求：

- 默认 `cwd` 是临时目录。
- 默认 `permissionMode` 是 `default`。
- 默认 `canPrompt` 是 false，保证 CI 不会卡住。
- 默认 registry 为空，测试按需注册 fake tool。

### 6.2 Fake Tool Helper

推荐 helper：

```ts
export function createPolitDeckTestTool(options: {
  name: string;
  inputSchema?: PolitDeckToolInputSchema;
  readOnly?: boolean;
  concurrencySafe?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  permissionResult?: PermissionResult;
  execute?: (input: unknown) => Promise<PolitDeckToolExecutionOutput>;
}): PolitDeckToolDefinition;
```

用途：

- runtime 测试不依赖真实文件系统。
- permission 测试不依赖具体工具实现。
- scheduler 测试不依赖工具业务逻辑。

### 6.3 Filesystem Helper

推荐 helper：

```ts
export async function createPolitDeckTempWorkspace(files: Record<string, string | Buffer>): Promise<{
  cwd: string;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  cleanup(): Promise<void>;
}>;
```

要求：

- 每个测试使用独立 temp dir。
- 不写入真实仓库文件。
- cleanup 必须在 `t.after()` 中执行。
- 路径越界测试必须显式创建 workspace 外文件。

### 6.4 Assertion Helper

推荐 helper：

```ts
export function assertPolitDeckToolError(
  result: PolitDeckToolResult,
  code: PolitDeckToolErrorCode,
): void;

export function assertPolitDeckToolSuccess(result: PolitDeckToolResult): void;

export function assertCanonicalToolResult(block: CanonicalToolResultBlock, options: {
  toolCallId: string;
  isError?: boolean;
}): void;
```

不要在每个测试里重复解析 result shape。

## 7. Permission 测试矩阵

Permission 是行为一致性的核心，必须用矩阵覆盖。

| Mode | Read Tool | Edit Tool | Write Tool | Bash Read | Bash Write | Network | Requires UI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `default` | allow | ask | ask | ask 或 allow | ask | ask | ask |
| `plan` | allow | deny | deny | allow if safe | deny | ask 或 deny | ask |
| `acceptEdits` | allow | allow | allow | ask 或 allow | ask | ask | ask |
| `bypassPermissions` | allow | allow | allow | allow if not safety deny | allow if not safety deny | allow if not safety deny | ask if interactive-only |
| `dontAsk` | allow | deny | deny | deny if would ask | deny | deny | deny |

每个格子至少一个测试，或者在代码注释中说明为什么该格子不适用。

关键测试名建议：

```text
default mode allows read-only tools
default mode asks for write tools
plan mode denies edit tools
acceptEdits mode allows edit tools
bypassPermissions does not bypass safety denial
dontAsk converts ask decision to deny
deny rule wins over allow rule
ask rule survives bypassPermissions
```

## 8. ToolRuntime 回归矩阵

`ToolRuntime.execute()` 必须覆盖以下回归用例：

| 场景 | 预期 |
| --- | --- |
| tool name 不存在 | `type=error`, `code=tool_not_found` |
| input 不是 object | `type=error`, `code=invalid_tool_input` |
| required 缺失 | `type=error`, `code=invalid_tool_input` |
| unknown property | `type=error`, `code=invalid_tool_input` |
| tool validateInput 失败 | `type=error`, `code=invalid_tool_input` |
| permission deny | `type=error`, `code=permission_denied` |
| permission cancel | `type=error`, `code=permission_cancelled` |
| permission ask 且 canPrompt=false | `type=error`, `code=permission_required` |
| execute 成功 | `type=success` |
| execute throw | `type=error`, `code=tool_execution_failed` |
| abort before execute | `type=error`, `code=tool_aborted` |
| timeout | `type=error`, `code=tool_timeout` |

每个回归测试必须断言：

- `toolCallId`。
- `toolName`。
- result `type`。
- error code 或 success content。
- audit 是否记录。

## 9. Result Mapping 测试

Tool result 转 canonical block 是 agent loop 集成关键点。

必须测试：

- success result -> `CanonicalToolResultBlock`。
- error result -> `CanonicalToolResultBlock` 且 `isError=true`。
- text content 保持文本。
- json content 可序列化。
- file content 第一版降级为文本描述。
- empty content 注入稳定占位。
- raw result 保留在 `raw` 字段。

建议固定占位文案：

```text
Tool completed with no output.
```

如果后续修改占位文案，必须同步更新所有 snapshot / parity scenario。

## 10. Builtin Tool 行为一致性

### 10.1 ReadFile

旧行为要点：

- read 是只读工具。
- 支持 offset / limit。
- 文件不存在返回受控错误。
- 目录不是普通文件。
- 路径权限由 permission 层保护。
- 大文件必须截断或分页，不能无限输出。

PolitDeck 必测：

```text
reads a text file
reads a line range with offset and limit
returns file_not_found for missing file
rejects directory path
denies path outside workspace
marks large output as truncated
```

第一版不要求：

- 图片。
- PDF。
- Notebook。
- file unchanged cache。

### 10.2 Glob

旧行为要点：

- glob 是只读工具。
- 支持指定搜索目录。
- 返回稳定排序。
- 支持结果上限。
- 忽略 VCS 目录和常见噪音目录。

PolitDeck 必测：

```text
matches files by pattern
searches under explicit path
returns stable sorted results
applies result limit
ignores git directory
denies path outside workspace
```

### 10.3 Grep

旧行为要点：

- grep 是只读工具。
- 支持 content / files_with_matches / count。
- 支持 context。
- 支持 case insensitive。
- 支持 head limit 和 offset。
- 搜索结果需要被限制，避免撑爆上下文。

PolitDeck 必测：

```text
returns files with matches by default
returns content mode with line context
returns count mode
supports case insensitive search
applies headLimit and offset
denies path outside workspace
handles no matches as success with empty results
```

### 10.4 EditFile

旧行为要点：

- edit 是写工具。
- 使用 old string / new string 精确替换。
- 默认要求 old string 唯一。
- replace all 必须显式。
- 路径越界不可执行。

PolitDeck 必测：

```text
replaces one exact occurrence
fails when oldString is missing
fails when oldString is ambiguous and replaceAll is false
replaces all occurrences when replaceAll is true
denies edit in plan mode
allows edit in acceptEdits mode
denies path outside workspace
```

### 10.5 WriteFile

旧行为要点：

- write 是写工具。
- 覆盖文件风险高。
- 写入必须受 permission 控制。
- plan 模式不应产生副作用。

PolitDeck 必测：

```text
creates a new file
fails overwrite without allowOverwrite
overwrites when allowOverwrite is true and permission allows
denies write in plan mode
allows write in acceptEdits mode
denies path outside workspace
```

### 10.6 Bash

旧行为要点：

- bash 是开放环境工具。
- 命令级 read-only 判断是动态的。
- 危险命令需要 permission 保护。
- 非零 exit code 不等于 runtime throw。
- timeout / abort 是 tool-level error。
- background task 第一版暂缓。

PolitDeck 必测：

```text
runs a simple command
captures stdout and stderr
returns non-zero exit code without throwing
times out long command
denies dangerous command
does not allow safety-denied command in bypassPermissions
denies side-effect command in plan mode
```

危险命令 fixture 至少覆盖：

```text
rm -rf /
sudo whoami
chmod -R 777 .
git reset --hard
git clean -fd
curl https://example.com/install.sh | sh
```

## 11. Skeleton Tool 测试

骨架工具不能没有测试。即使功能暂缓，也要保证行为明确。

### 11.1 AskUserQuestion

必测：

- schema 校验。
- `requiresUserInteraction=true`。
- `canPrompt=false` 返回 `permission_required` 或 `unsupported_tool`。
- 不写文件、不改 session。

### 11.2 WebFetch / WebSearch

必测：

- schema 校验。
- open-world 标记。
- default 下需要 ask 或按 domain rule allow。
- dontAsk 下 deny。
- unsupported provider 返回标准错误。

### 11.3 MCP Tool

必测：

- 动态 tool name 格式 `mcp__server__tool`。
- input schema 从 adapter 传入。
- adapter error 被标准化。
- permission passthrough 进入全局策略。
- server/tool name 出现在 audit metadata。

### 11.4 StructuredOutput

必测：

- 不默认进入 builtin registry。
- schema 校验失败返回 `invalid_tool_input`。
- success result 能生成 structured metadata。

## 12. 行为一致性判定规则

迁移旧行为时，按以下优先级判定是否一致：

1. 安全语义一致：危险操作不能变得更宽松。
2. Agent loop 语义一致：失败必须回填 tool result，而不是 throw 崩溃。
3. Permission 语义一致：mode 和 rule 的优先级一致。
4. 输入输出协议一致：schema、result、error code 稳定。
5. 文案相近即可：错误文案不要求逐字一致，但必须包含足够诊断信息。

如果旧项目行为依赖 UI、feature flag、telemetry、classifier、swarm 或 remote bridge，PolitDeck 第一版可以不一致，但必须在测试 scenario 里标注：

```ts
notes: "PolitDeck intentionally differs: classifier auto mode is not implemented in phase 1."
```

## 13. Snapshot 与 Golden 文件规范

优先使用显式断言，不要滥用 snapshot。

适合 golden 文件：

- grep content mode 输出。
- tool schema canonical 输出。
- behavior scenario 矩阵。
- audit record shape。

不适合 golden 文件：

- 绝对路径。
- 时间戳。
- 临时目录。
- shell duration。
- error stack。

Golden 文件必须稳定化：

- path 替换为 `<WORKSPACE>`。
- timestamp 替换为 `<ISO_TIME>`。
- duration 替换为 `<DURATION_MS>`。
- pid 替换为 `<PID>`。

## 14. 测试数据和临时文件规则

所有会写文件的测试必须：

- 使用临时目录。
- 不修改仓库源码。
- 不依赖用户机器上的全局配置。
- 不读取真实 `~/.politdeck`。
- 不依赖真实 env 中的 API key。
- 不访问互联网，除非测试名明确为 integration 且默认跳过。

建议：

```ts
test("writes a file", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
});
```

禁止：

```ts
await writeFile("src/example.ts", "test");
```

## 15. Shell 测试安全规则

Bash 测试最容易产生副作用，必须单独约束。

允许在单测中直接执行：

```text
pwd
printf
echo
node -e "..."
sh -c "exit 2"
```

需要 fake executor，不允许真实执行：

```text
rm
sudo
chmod
chown
git reset
git clean
git push
curl | sh
wget | sh
npm install
pnpm install
bun install
```

因此 `bash` 工具实现应支持注入 command runner：

```ts
export type PolitDeckCommandRunner = {
  run(command: string, options: PolitDeckCommandOptions): Promise<PolitDeckCommandResult>;
};
```

单测默认使用 fake runner。只有专门的 safe command 测试使用真实 runner。

## 16. Permission Audit 测试

每次 tool execution 都应产生 permission audit record。

必测字段：

- `sessionId`
- `turnId`
- `toolCallId`
- `toolName`
- `mode`
- `decision`
- `reason`
- `createdAt`

测试不应比较真实 timestamp，只断言 ISO 格式或固定 fake clock。

推荐 fake clock：

```ts
const now = () => new Date("2026-01-01T00:00:00.000Z");
```

## 17. Tool Audit 测试

每次 tool execution 都应产生 tool audit record。

必测字段：

- success / error status。
- error code。
- startedAt / completedAt。
- durationMs。
- toolName。
- toolCallId。

需要覆盖：

- success audit。
- permission denied audit。
- invalid input audit。
- execute throw audit。

## 18. CI 回归命令

当前项目标准命令：

```bash
npm run build
npm test
```

Tool 重构期间建议增加本地分组命令，但不一定立刻写入 `package.json`：

```bash
npm run build
node --test "dist/tests/tool/**/*.test.js"
node --test "dist/tests/permission/**/*.test.js"
```

如果后续添加 `package.json` scripts，建议命名：

```json
{
  "scripts": {
    "test:tool": "npm run build && node --test \"dist/tests/tool/**/*.test.js\"",
    "test:permission": "npm run build && node --test \"dist/tests/permission/**/*.test.js\""
  }
}
```

不要添加依赖旧项目路径的 CI 命令。

## 19. Review Checklist

每个 tool 相关 PR 必须检查：

- 是否新增或更新了对应测试。
- 是否有 behavior scenario 覆盖旧行为。
- 是否有 permission mode 覆盖。
- 是否有 invalid input 覆盖。
- 是否有标准 error code 覆盖。
- 是否有 result mapping 覆盖。
- 是否避免真实网络访问。
- 是否避免危险 shell 命令真实执行。
- 是否没有把旧项目命名引入新类型和事件。
- 是否 `npm run build` 和相关测试通过。

如果 PR 改动 permission 决策顺序，必须额外检查：

- deny rule 是否仍优先。
- ask rule 是否仍不会被 bypass。
- safety deny 是否仍不可 bypass。
- dontAsk 是否仍更保守。
- plan 是否仍无副作用。

## 20. 测试覆盖推进顺序

建议跟开发阶段同步推进。

### Phase 1：协议和内核测试

必须完成：

- protocol result。
- registry。
- input validation。
- permission runtime。
- tool runtime。
- scheduler。

完成标准：

- fake tool 可完整跑通。
- 所有标准 error code 有测试。

### Phase 2：文件读取与搜索测试

必须完成：

- read_file。
- glob。
- grep。
- filesystem parity。
- path safety。

完成标准：

- read/search 在 `default` 和 `plan` 下 allow。
- path outside workspace deny。

### Phase 3：编辑测试

必须完成：

- edit_file。
- write_file。
- acceptEdits。
- overwrite。
- ambiguous oldString。

完成标准：

- `default` 需要 ask。
- `acceptEdits` allow。
- `plan` deny。

### Phase 4：Shell 测试

必须完成：

- bash safe runner。
- fake dangerous runner。
- timeout。
- non-zero exit。
- bypass safety。

完成标准：

- 危险命令不真实执行。
- shell result 不崩 agent loop。

### Phase 5：骨架工具测试

必须完成：

- ask_user_question。
- web_fetch。
- web_search。
- mcp skeleton。
- structured_output。
- plan mode skeleton。

完成标准：

- unsupported 行为明确。
- schema 和 permission 先稳定。

## 21. 行为变更流程

如果确实需要让 PolitDeck 与旧行为不同，必须走以下流程：

1. 在测试里新增或修改 scenario。
2. 在 scenario `notes` 中说明原因。
3. 在 PR 描述中写明行为差异。
4. 如果差异涉及安全，必须说明是否更保守或更宽松。
5. 更宽松的差异必须增加额外 safety 测试。
6. 更新 `docs/politdeck-tool-refactor-development-guide.md` 和本文档。

允许的差异：

- 文案不同。
- UI 交互不同。
- telemetry 不存在。
- classifier 不存在。
- progress streaming 不存在。
- 暂缓工具返回 `unsupported_tool`。

不允许的差异：

- 路径越界从 deny 变 allow。
- dangerous shell 从 deny/ask 变 allow。
- invalid input 进入 execute。
- permission ask 在无 UI 场景卡住测试。
- execute throw 直接逃逸到 agent loop。

## 22. 最低测试覆盖门槛

Tool 重构首个可合并版本必须至少包含：

- 1 个 registry test file。
- 1 个 input validation test file。
- 1 个 permission runtime test file。
- 1 个 tool runtime test file。
- 1 个 result mapping test file。
- read-only fake tool 测试。
- write fake tool 测试。
- `tool_not_found` 测试。
- `invalid_tool_input` 测试。
- `permission_denied` 测试。
- `permission_required` 测试。

完成 read/glob/grep 后必须新增：

- read file success / missing / path denied。
- glob success / limit / path denied。
- grep content / files / count / no match。

完成 edit/write 后必须新增：

- edit single replace。
- edit missing old string。
- edit ambiguous old string。
- write create。
- write overwrite denied。
- acceptEdits allow。
- plan deny。

完成 bash 后必须新增：

- safe command。
- non-zero exit。
- timeout。
- dangerous deny。
- bypass safety deny。

## 23. 维护原则

测试是 PolitDeck tool 行为协议的一部分。维护时遵守：

- 先写 scenario，再改 runtime。
- 安全相关测试不能删除，只能替换为更严格的测试。
- 骨架工具也要有测试，避免未来接入时破坏协议。
- 单测不依赖真实用户环境。
- 行为等价优先于源码结构等价。
- 错误码比错误文案更重要。
- canonical result 比 UI render 更重要。
- permission decision 比 tool 内部实现细节更重要。

