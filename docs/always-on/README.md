# Always-On 文档集

本文档集用于管理 PolitDeck 重写 Always-On 模块时需要参考的产品、架构和测试资料。Always-On 在旧项目中不是单一源码目录，而是由 `/ao` 命令、cron daemon、discovery scheduler、heartbeat、discovery plan 工具、项目内状态文件和运行历史共同构成。

## 文档列表

1. `[01-legacy-always-on-prd.md](./01-legacy-always-on-prd.md)`
   - 对照 `third-party/claude-code-main` 中的旧实现，整理 Always-On 的产品目标、用户功能、配置、运行机制、数据文件和可观察行为。
2. `[02-politdeck-always-on-rewrite-plan.md](./02-politdeck-always-on-rewrite-plan.md)`
   - 结合旧实现与 PolitDeck 当前 `src/gateway`、`politdeck server`、`SessionRouter`，给出新项目重写 Always-On 的模块边界、分阶段方案和实现顺序。
3. `[03-always-on-test-plan.md](./03-always-on-test-plan.md)`
   - 定义 Always-On 的单测、集成测试、传输一致性测试和新旧双边 parity 测试方案，明确何时可以声称 contract parity 或 execution parity passed。

## 阅读顺序

先读旧功能 PRD，明确旧系统真实行为；再读重写方案，理解哪些旧行为进入第一阶段、哪些是 deferred 或 intentional difference；最后读测试方案，用共享场景和归一化报告验证新实现。

## 术语

- `Always-On discovery`：旧项目的主动发现能力。daemon 在项目空闲、配置允许、预算和冷却满足时，向 TUI/WebUI 投递一次 discovery prompt。
- `Always-On cron`：旧项目的定时任务能力。cron daemon 触发后台 worker，并把运行日志与 history 写入项目内 `.claude/always-on`。
- `Discovery plan`：由 `AlwaysOnDiscoveryPlan` 工具保存的后续工作计划，供 `/ao list plan`、`/ao status plan`、`/ao run plan` 使用。
- `Gateway resident process`：PolitDeck 当前已有的 `politdeck server` 常驻进程，是新 Always-On 模块优先复用的运行宿主。

## Source Of Truth

- 旧项目实现：`third-party/claude-code-main/edgeclaw-config.ts`
- 旧项目 discovery 调度：`third-party/claude-code-main/src/daemon/discoveryScheduler/`
- 旧项目 TUI hook：`third-party/claude-code-main/src/hooks/useAlwaysOnHeartbeat.ts`、`third-party/claude-code-main/src/hooks/useAlwaysOnDiscoveryRequests.ts`
- 旧项目 `/ao` 命令：`third-party/claude-code-main/src/commands/ao/`
- 新项目 gateway：`src/gateway/`
- 新项目 server 入口：`src/cli/politdeck.ts`、`src/cli/createLocalGateway.ts`
- 现有测试约定：`tests/gateway/`、`tests/tool/parity-dual-execution.test.ts`、`tests/agent/parity-dual-contract.test.ts`
