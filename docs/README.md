# Agent Loop 文档集

本文档集分为以下部分：

- `[current-agent-loop-analysis/](./current-agent-loop-analysis/)`：基于原项目 `~/Codes/work/modelbest/PolitDeck/third-party/claude-code-main/src` 的 agent loop 功能分析，只描述现状、模块职责和运行机制。
- `[rewrite-plan/](./rewrite-plan/)`：面向新项目的产品文档、重写建议和总体方案。
- `[polit-config/](./polit-config/)`：重写方案中 `polit/config` 模块的专项设计，包括总配置、配置来源、热重载、模块集成和运维诊断。
- `[model/](./model/)`：重写方案中 `model` 模块的专项设计，包括模型协议适配、配置和测试。
- `[politdeck-agent-refactor-development-guide.md](./politdeck-agent-refactor-development-guide.md)` / `[politdeck-agent-test-maintenance-guide.md](./politdeck-agent-test-maintenance-guide.md)`：重写方案中 `agent` 模块的重构开发文档和 parity 测试维护文档。
- `[politdeck-session-refactor-development-guide.md](./politdeck-session-refactor-development-guide.md)`：重写方案中 `session` 模块的重构开发文档（transcript / storage / resume / metadata / lite reader / list）。
- `[politdeck-context-refactor-development-guide.md](./politdeck-context-refactor-development-guide.md)`：重写方案中 `context` 模块的重构开发文档（prompt / projection / budget / memory / EdgeClaw 替换评估）。
- `[politdeck-adapter-refactor-development-guide.md](./politdeck-adapter-refactor-development-guide.md)` / `[politdeck-adapter-test-maintenance-guide.md](./politdeck-adapter-test-maintenance-guide.md)`：重写方案中 `gateway` + `adapters/` 两层的重构开发文档与测试维护文档（含 `politdeck server` 入口、CLI/TUI/Web/Feishu channel 形态、WS 帧协议）。
- `[always-on/](./always-on/)`：重写方案中 Always-On 模块的文档集，包括旧项目产品/功能 PRD、PolitDeck gateway-native 重写方案、测试用例与新旧双边 parity 方案。

## 阅读顺序

1. 先阅读 `[current-agent-loop-analysis/README.md](./current-agent-loop-analysis/README.md)`，理解当前项目 agent loop 的内核、工具权限运行时、上下文与会话运行时。
2. 再阅读 `[rewrite-plan/README.md](./rewrite-plan/README.md)`，查看新项目的产品规格和重写总方案。
3. 如需实现全局配置、路径和热重载，阅读 `[polit-config/README.md](./polit-config/README.md)`。
4. 如需实现模型连接和协议转换，阅读 `[model/README.md](./model/README.md)`。
5. 如需实现 agent runtime，阅读 `[politdeck-agent-refactor-development-guide.md](./politdeck-agent-refactor-development-guide.md)` 和 `[politdeck-agent-test-maintenance-guide.md](./politdeck-agent-test-maintenance-guide.md)`。
6. 如需实现 session 持久化与 resume，阅读 `[politdeck-session-refactor-development-guide.md](./politdeck-session-refactor-development-guide.md)`。
7. 如需实现上下文治理与 memory 集成，阅读 `[politdeck-context-refactor-development-guide.md](./politdeck-context-refactor-development-guide.md)`。
8. 如需实现 `politdeck server` 入口、CLI / TUI / Web / 飞书 channel 与 WS gateway 协议，阅读 `[politdeck-adapter-refactor-development-guide.md](./politdeck-adapter-refactor-development-guide.md)` 和 `[politdeck-adapter-test-maintenance-guide.md](./politdeck-adapter-test-maintenance-guide.md)`。
9. 如需实现 Always-On 主动发现、discovery plan、cron 调度或相关 parity 测试，阅读 `[always-on/README.md](./always-on/README.md)`。

## 目录原则

当前项目分析和新项目方案分开维护，避免把“现状分析”和“重写建议”混在同一类文档里。