# PilotDeck 生命周期、Hooks 与插件重写文档

本目录集中管理 PilotDeck 新项目中生命周期、hooks 系统和插件模块的调研、重写与测试文档。

阅读顺序：

1. `01-legacy-lifecycle-hooks-plugin-analysis.md`：老项目生命周期、hooks 和插件系统分析。
2. `02-pilotdeck-lifecycle-hooks-plugin-rewrite-plan.md`：面向 `src/` 当前新项目结构的重写方案。
3. `03-lifecycle-hooks-plugin-parity-test-plan.md`：行为一致性测试方案与 parity 场景维护规则。

当前实现已在 `src/lifecycle/` 与 `src/extension/` 下落地非 context 范围内的基础协议、command/prompt/http/agent/callback hook runtime、async response registry、固定插件目录解析、本地插件加载骨架、Agent/Tool 生命周期接入、SubagentStop/WorktreeCreate hook dispatch、插件 refresh/prune 报告、commands/skills/output-style 读取、MCP/LSP contribution 汇总和 parity manifest/report 骨架；对应基础测试位于 `tests/lifecycle-hooks-plugins/`。真实外部安装器、任务队列 rewake 和双端 legacy execution runner 仍是后续工作，不能据此声明 execution parity passed。

本文档遵循 `docs/rewrite-plan/02-rewrite-project-report.md` 的目标架构：插件、技能、MCP 和 hook 都通过 `extension` contribution 进入 runtime；不能直接侵入 `agent`、`tool`、`permission` 或 `context` 内部状态。
