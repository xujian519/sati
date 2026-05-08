# PolitDeck 生命周期、Hooks 与插件重写文档

本目录集中管理 PolitDeck 新项目中生命周期、hooks 系统和插件模块的调研、重写与测试文档。

阅读顺序：

1. `01-legacy-lifecycle-hooks-plugin-analysis.md`：老项目生命周期、hooks 和插件系统分析。
2. `02-politdeck-lifecycle-hooks-plugin-rewrite-plan.md`：面向 `src/` 当前新项目结构的重写方案。
3. `03-lifecycle-hooks-plugin-parity-test-plan.md`：行为一致性测试方案与 parity 场景维护规则。

当前实现已在 `src/lifecycle/` 与 `src/extension/` 下落地第一批协议、command hook runtime、固定插件目录解析和本地插件加载骨架；对应基础测试位于 `tests/lifecycle-hooks-plugins/`。双端 legacy parity runner 仍是后续工作，不能据此声明 execution parity passed。

本文档遵循 `docs/rewrite-plan/02-rewrite-project-report.md` 的目标架构：插件、技能、MCP 和 hook 都通过 `extension` contribution 进入 runtime；不能直接侵入 `agent`、`tool`、`permission` 或 `context` 内部状态。
