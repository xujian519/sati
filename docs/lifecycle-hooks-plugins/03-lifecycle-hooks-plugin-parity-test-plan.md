# 生命周期、Hooks 与插件行为一致性测试文档

## 1. 目标

本文定义 PolitDeck 生命周期、hooks 与插件系统的测试策略。目标是保证新项目与 `third-party/claude-code-main` 的外部可观察行为一致：

- 相同 lifecycle/hook/plugin 输入得到相同归一化输出。
- 相同配置、插件目录和 hook stdout 产生相同 effects。
- 相同触发点观察到相同事件顺序、阻塞/继续、权限、上下文和 transcript 现象。

遵循 `refactor-with-parity` 规则：

- `Contract parity passed` 只表示 schema、flags、字段、状态分类等契约一致。
- `Execution parity passed` 只在同一 shared scenario 同时运行 legacy 与 PolitDeck，并比较 normalized output 后才能声明。
- `Deferred` 必须有原因。
- `Intentional difference` 必须有原因和风险说明。

## 2. 测试落地状态

第一批基础测试已经放在 `tests/lifecycle-hooks-plugins/` 下：

```text
tests/lifecycle-hooks-plugins/
  protocol.test.ts
  hook-runtime.test.ts
  tool-integration.test.ts
  plugin-loader.test.ts
```

后续实现双端 runner 时，建议再补充：

```text
third-party/claude-code-main/src/politdeck-lifecycle-hooks-plugin-legacy-contract-report.ts
third-party/claude-code-main/src/politdeck-lifecycle-hooks-plugin-legacy-execution-report.ts

tests/helpers/lifecycleHooksPluginContractReport.ts
tests/helpers/lifecycleHooksPluginExecutionReport.ts

tests/lifecycle-hooks-plugins/parity-dual-contract.test.ts
tests/lifecycle-hooks-plugins/parity-dual-execution.test.ts
```

当前测试只覆盖 PolitDeck 新实现的协议、runtime 和本地插件加载骨架，不代表 contract parity passed 或 execution parity passed。

## 3. 测试分层

```text
manifest tests
  -> protocol tests
  -> config parser tests
  -> hook output parser tests
  -> lifecycle dispatch tests
  -> tool/permission integration tests
  -> plugin loader tests
  -> dual parity contract tests
  -> dual parity execution tests
```

### 3.1 Manifest Tests

验证 parity fixture 自身质量：

- scenario id 唯一。
- status 必须是 `compare`、`intentional_difference`、`deferred` 或 `not_applicable`。
- 所有非 compare scenario 必须写 `reason`。
- compare scenario 必须声明 legacy 与 PolitDeck 观察字段。
- 核心事件、hook 输出、插件加载和热加载场景必须覆盖。

### 3.2 Protocol Tests

验证纯协议：

- hook event enum 与 legacy-compatible event 名一致。
- base input 字段完整。
- 每个 event 的必填字段和可选字段一致。
- snake_case JSON 与内部 camelCase 可以稳定互转。
- hook output JSON sync/async union 解析一致。

已落地基础文件：

```text
tests/lifecycle-hooks-plugins/protocol.test.ts
```

### 3.3 Config Parser Tests

验证 hooks/plugin 配置：

- command/prompt/http/agent hook schema。
- matcher。
- `if` 条件。
- `statusMessage`、`once`、`async`、`asyncRewake` 等 legacy 字段识别。
- `timeout` 仅作为 legacy-compatible 字段识别，不改变 PolitDeck 代码常量 timeout。
- http headers 的 env interpolation 白名单。
- 非法 marketplace 名称、路径穿越、非 ASCII 冒充。

已落地一部分基础文件：

```text
tests/lifecycle-hooks-plugins/protocol.test.ts
tests/lifecycle-hooks-plugins/plugin-loader.test.ts
```

### 3.4 Lifecycle Dispatch Tests

验证 dispatch effect：

- `SessionStart` additional context 生成 attachment/context。
- `SessionStart.initialUserMessage` 被消费一次。
- `UserPromptSubmit` blocking 阻止模型请求。
- `Stop` blocking 阻止 continuation 并返回 stop reason。
- `SessionEnd` 使用短超时并并发执行。

已落地基础文件：

```text
tests/lifecycle-hooks-plugins/hook-runtime.test.ts
```

### 3.5 Tool/Permission Integration Tests

验证 hook 嵌入工具和权限链路：

- `PreToolUse.updatedInput` 重新校验后执行。
- `PreToolUse.permissionDecision=deny` 阻止执行。
- `PermissionRequest` hook 自动 allow/deny。
- `PostToolUse.additionalContext` 进入后续模型上下文。
- `PostToolUse.updatedMCPToolOutput` 只作用于 MCP 工具。
- `PostToolUseFailure` 接收 error/isInterrupt。
- `PermissionDenied.retry` 最多触发一次 retry。

已落地基础文件：

```text
tests/lifecycle-hooks-plugins/tool-hook-integration.test.ts
tests/lifecycle-hooks-plugins/tool-integration.test.ts
```

### 3.6 Plugin Loader Tests

验证插件贡献：

- builtin/global/project plugin discovery。
- manifest validation。
- hooks config 转 matcher。
- plugin hook atomic reload。
- disabled/removed plugin hook prune。
- commands/skills markdown 命名。
- duplicate path 处理。

已落地基础文件：

```text
tests/lifecycle-hooks-plugins/plugin-loader.test.ts
```

## 4. Dual Parity Harness

### 4.1 Shared Scenarios

共享场景必须只描述输入、状态和期望比较字段，不 import 任一实现：

```ts
export type LifecycleHookPluginContractScenario = {
  id: string;
  status: "compare" | "intentional_difference" | "deferred" | "not_applicable";
  feature: string;
  legacy: { eventName?: string; pluginShape?: string; input?: Record<string, unknown> };
  politdeck: { eventName?: string; pluginShape?: string; input?: Record<string, unknown> };
  compareFields: string[];
  reason?: string;
};
```

### 4.2 Legacy Runner

Legacy runner 位于 `third-party/claude-code-main/src/`，读取同一套 scenario，输出 normalized JSON。

原则：

- 优先做 focused probe，不跑整个 vendored 项目构建。
- 只 import 与 hook/plugin 行为直接相关的 legacy 文件。
- 对绝对路径、session id、transcript path、时间、pid 做归一化。
- 不把 debug/telemetry 私有字段作为比较目标。

### 4.3 PolitDeck Runner

后续 PolitDeck runner 建议位于 `tests/helpers/`，调用新实现输出同样 schema。

第一阶段新实现还不存在时，不应伪造 runner 或一致性结果；只在文档中维护场景清单和通过标准。

### 4.4 Root Parity Test

root parity test 必须：

- 确保 scenario id 唯一。
- 确保 legacy 与 PolitDeck report statuses 完全一致。
- 对 `status: "compare"` 的场景 deepEqual normalized values。
- 对非 compare 场景要求 reason。
- 输出失败 id，便于逐项修复。

## 5. Normalization Rules

允许归一化：

- 绝对路径 -> `<workspace>`、`<home>`、`<pluginRoot>`。
- `session_id`、`tool_use_id`、`hookId` -> 稳定占位符。
- 时间、duration、pid -> 省略或占位符。
- stdout/stderr 行尾差异 -> `\n` 标准化。
- JSON 字段顺序 -> object deep equal。
- debug/telemetry 字段 -> 省略。

不允许归一化：

- success vs blocking vs non-blocking error。
- exit code 0/2/其他非零。
- permission allow/deny/ask/passthrough。
- updated input 的实际内容。
- additional context 是否进入模型上下文。
- suppressOutput 是否影响 transcript/用户可见输出。
- plugin hook 在 reload/prune 前后是否仍会触发。
- SessionEnd timeout 是否取消未完成 hook。

## 6. 必测场景清单

### 6.1 Contract Scenarios

必须覆盖：

- hook event enum。
- base input fields。
- tool hook input fields。
- session hook input fields。
- compact hook input fields。
- permission hook output。
- sync hook output。
- async hook output。
- command hook schema。
- prompt/http/agent hook schema。
- plugin manifest contributions。
- plugin marketplace source policy。
- plugin hook reload/prune policy。
- plugin command/skill naming。

### 6.2 Execution Scenarios

必须覆盖：

- command hook success with JSON additional context。
- command hook exit 2 blocks continuation。
- command hook exit 1 is non-blocking error。
- async hook returns pending then later sync response。该场景仍 deferred；第一批实现只识别 async 输出，不执行后台轮询。
- PreToolUse updates input before permission and execution。
- PermissionRequest auto allow with updated permissions。
- PostToolUse blocks continuation after successful tool run。
- PostToolUse updates MCP output。
- SessionStart returns initial user message once。
- Stop hook blocks continuation with stop reason。
- disabled plugin hook pruned immediately。
- new plugin hook waits for reload before activation。

## 7. Legacy Probe 触发建议

必要时对原项目进行 focused test：

```bash
cd third-party/claude-code-main
bun test <focused-probe.test.ts>
bun run src/politdeck-lifecycle-hooks-plugin-legacy-contract-report.ts
bun run src/politdeck-lifecycle-hooks-plugin-legacy-execution-report.ts
```

不要依赖整个 vendored project build，因为 third-party 子树可能不完整。探针应尽量只 import：

- `src/entrypoints/sdk/coreTypes.ts`
- `src/entrypoints/sdk/coreSchemas.ts`
- `src/schemas/hooks.ts`
- `src/types/hooks.ts`
- `src/utils/hooks/AsyncHookRegistry.ts`
- `src/utils/plugins/loadPluginHooks.ts`
- `src/utils/plugins/loadPluginCommands.ts`
- `src/utils/plugins/schemas.ts`

## 8. 通过标准

### 第一阶段基础实现状态

- 文档列出测试分层、场景清单、归一化规则和通过标准。
- 文档列出所有 deferred 与 intentional difference。
- PolitDeck 新实现的基础协议、command hook runtime、tool integration 和本地插件加载测试通过。

结论只能写：

```text
PolitDeck basic lifecycle/hooks/plugin tests passed.
Contract/execution parity is not claimed yet.
```

### Contract Parity Passed

满足：

- legacy contract runner 生成 report。
- PolitDeck contract runner 生成 report。
- root contract test 对 compare scenario deepEqual。
- 非 compare 均有 reason。

### Execution Parity Passed

满足：

- legacy execution runner 真实执行 scenario。
- PolitDeck execution runner 真实执行 scenario。
- root execution test 对 compare scenario deepEqual normalized output。
- 对所有差异要么修复，要么更新为 intentional_difference/deferred 并写原因。

## 9. 维护规则

- 新增 hook event、plugin contribution 或 lifecycle trigger 时，必须先更新本文档中的场景清单。
- 实现从 deferred 变 compare 时，必须补 runner 和 parity test。
- 修改 output parser 时，必须更新 sync/async/blocking/non-blocking 场景说明。
- 修改 plugin reload 策略时，必须覆盖 plugin hook reload/prune 场景。
- 修改 permission runtime 时，必须覆盖 PreToolUse、PermissionRequest、PermissionDenied 场景。
- 等测试代码落地后，文档、fixture、runner 和实现必须同步更新。
