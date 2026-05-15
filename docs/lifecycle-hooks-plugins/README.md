# PilotDeck 生命周期、Hooks 与插件重写文档

本目录集中管理 PilotDeck 新项目中生命周期、hooks 系统和插件模块的调研、重写与测试文档。

阅读顺序：

1. `01-legacy-lifecycle-hooks-plugin-analysis.md`：老项目生命周期、hooks 和插件系统分析。
2. `02-pilotdeck-lifecycle-hooks-plugin-rewrite-plan.md`：面向 `src/` 当前新项目结构的重写方案。
3. `03-lifecycle-hooks-plugin-parity-test-plan.md`：行为一致性测试方案与 parity 场景维护规则。

当前实现已在 `src/lifecycle/` 与 `src/extension/` 下落地：

- 基础协议：`PilotDeckHookEvent`（含 `PreModelRequest`）、`PilotDeckHookEffect`（含 `worktree_path`）、`LifecycleDispatchResult`（含 `nonBlockingErrors`）。
- Hook runtime：command/prompt/http/agent/callback 五种执行器、`HookExecutionEventBus`、`AsyncHookRegistry`（含 `asyncRewake` marker）。
- Agent 生命周期接入：`AgentSession`（SessionStart/Setup/SessionEnd）、`TurnRunner`（UserPromptSubmit）、`AgentLoop`（PreModelRequest/Stop/StopFailure/InstructionsLoaded/SubagentStart/SubagentStop）。
- Tool 生命周期接入：`ToolRuntime`（PreToolUse/PermissionRequest/PermissionDenied/PostToolUse/PostToolUseFailure）。
- Compaction 生命周期接入：`CompactionEngine`（PreCompact/PostCompact）。
- Gateway 桥接：`createGatewayPermissionHook`（callback hook → permission_request）、`GatewayElicitationChannel`（Elicitation/ElicitationResult → lifecycle dispatch）、ConfigChange 进程级 dispatch。
- 插件系统：固定插件目录解析、本地插件加载、manifest hooks/commands/skills/output-style 读取、MCP/LSP contribution 汇总、refresh/prune 报告、marketplace reference 解析。
- 对应基础测试位于 `tests/lifecycle-hooks-plugins/`。

真实外部安装器（Git/zip/MCPB）、任务队列 rewake 和双端 legacy execution runner 仍是后续工作，不能据此声明 execution parity passed。

本文档遵循 `docs/rewrite-plan/02-rewrite-project-report.md` 的目标架构：插件、技能、MCP 和 hook 都通过 `extension` contribution 进入 runtime；不能直接侵入 `agent`、`tool`、`permission` 或 `context` 内部状态。
