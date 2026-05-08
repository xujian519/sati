# PolitDeck 生命周期、Hooks 与插件重写文档

本目录集中管理 PolitDeck 新项目中生命周期、hooks 系统和插件模块的调研、重写与测试文档。

阅读顺序：

1. `01-legacy-lifecycle-hooks-plugin-analysis.md`：老项目生命周期、hooks 和插件系统分析。
2. `02-politdeck-lifecycle-hooks-plugin-rewrite-plan.md`：面向 `src/` 当前新项目结构的重写方案。
3. `03-lifecycle-hooks-plugin-parity-test-plan.md`：行为一致性测试方案与 parity 场景维护规则。

本目录只维护文档方案，不包含实际测试代码。测试目录、fixture 和 runner 的命名仅在测试文档中作为后续落地建议描述。

本文档遵循 `docs/rewrite-plan/02-rewrite-project-report.md` 的目标架构：插件、技能、MCP 和 hook 都通过 `extension` contribution 进入 runtime；不能直接侵入 `agent`、`tool`、`permission` 或 `context` 内部状态。
