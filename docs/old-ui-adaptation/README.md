# old_ui 适配 PilotDeck 文档集

本文档集用于管理 `old_ui/` 迁移、改写或重写为 PilotDeck Web UI 的工作。它不直接要求保留旧目录结构，而是把旧 UI 的用户能力、协议、状态和测试边界拆出来，再对齐当前 `src/` 中已经形成的 Gateway、Agent、Session、Config、Cron 与 Always-On 运行时。

阅读顺序：

1. `01-old-ui-current-state/`：先理解 `old_ui/` 的功能、架构、数据模型和运行逻辑。
2. `02-src-adaptation-plan/`：再理解它如何接入当前 `src/`，以及何时应该重写 `old_ui`、何时应该补齐 `src`。
3. `03-web-ui-testing/`：再按测试文档建立 contract、parity、端到端和人工验收闭环。
4. `04-implementation-plan/`：最后看复刻到 `/Users/miwi/PilotDeck/ui` 的实施指南、测试维护表与真实环境 runbook。

## 目录

```text
docs/old-ui-adaptation/
  01-old-ui-current-state/
    README.md
    01-feature-inventory.md
    02-architecture-and-runtime.md
    03-data-protocols-and-state.md
  02-src-adaptation-plan/
    README.md
    01-target-boundaries.md
    02-rewrite-old-ui-plan.md
    03-src-change-plan.md
    04-parity-matrix.md
  03-web-ui-testing/
    README.md
    01-test-strategy.md
    02-contract-and-parity-tests.md
    03-real-environment-runbook.md
  04-implementation-plan/
    01-web-ui-replication-development-guide.md
    02-web-ui-parity-test-guide.md
    03-real-environment-runbook.md
```

## 基本原则

- `src/gateway` 是 Web UI 与新 runtime 的首选边界，不让 React 组件直接依赖 `agent`、`tool`、`model` 或 transcript 内部实现。
- `session.transcript` 是会话事实来源，Web UI 只缓存渲染状态，不拥有事实状态。
- 旧 UI 中可复用的价值主要是用户流程、页面形态、聊天/工具渲染、项目文件/Git/Shell 体验和 Always-On 管理经验，不是 Express 后端的大型耦合结构。
- 适配完成前，不应声称行为一致；只有共享场景同时跑过旧实现和新实现并比较归一化输出，才能称为 parity passed。
