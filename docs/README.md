# PolitDeck 文档集

本文档集同时包含旧项目行为分析、重写设计文档和当前 `src/` 实现说明。阅读时优先以 `src/` 和测试为准；带有“重写方案 / parity 方案”标题的文档主要用于解释设计来源和后续验收边界。

当前 `src/` 顶层模块：

```text
adapters      channel 与 Web 静态挂载
agent         AgentSession、TurnRunner、AgentLoop
always-on     gateway-native discovery runtime
cli           politdeck / politdeck server / politdeck cron 入口
context       prompt、projection、budget、compaction、memory
cron          server 内定时任务 runtime、工具和 Gateway 管理面
extension     hooks、plugins、contributions
gateway       in-process / WebSocket Gateway 与 SessionRouter
lifecycle     lifecycle runtime 与 hook effects
model         canonical model protocol、provider adapter、streaming
permission    permission policy 与 decision runtime
polit         paths 与配置加载
router        scenario、fallback、TokenSaver、custom router
session       transcript、metadata、list、resume
tool          registry、runtime、builtin tools、scheduler
```

主要文档：

- `[current-agent-loop-analysis/](./current-agent-loop-analysis/)`：基于旧项目 `third-party/claude-code-main/src` 的 agent loop 行为分析。
- `[rewrite-plan/](./rewrite-plan/)`：早期产品规格和总体重写报告，部分包管理器/实施状态描述可能保留历史语境。
- `[polit-config/](./polit-config/)`：当前 `polit/config` 配置入口、schema、来源、热重载和变更分类。
- `[model/](./model/)`：`model` 模块协议、provider 转换、配置和测试。
- `[router/](./router/)`：`router` 模块产品规格、实现方案和测试指南。
- `[cron/](./cron/)`：当前 `src/cron` runtime、Gateway 方法、CLI 命令和存储格式。
- `[always-on/](./always-on/)`：Always-On discovery 的旧行为、当前 gateway-native 实现方案和测试计划。
- `[lifecycle-hooks-plugins/](./lifecycle-hooks-plugins/)`：生命周期、hooks 和插件系统文档。
- `[tui-real-env-testing/](./tui-real-env-testing/)`：通过真实 TUI、真实 Gateway、真实模型和真实工具链路进行环境验收的测试文档。
- `politdeck-*-refactor-development-guide.md` / `politdeck-*-test-maintenance-guide.md`：各模块的设计演进和测试维护文档。

## 阅读顺序

1. 先看对应 `src/<module>/index.ts` 和 `tests/<module>/`，确认当前实现事实。
2. 再读该模块的文档，理解设计动机、边界和仍未完成的能力。
3. 修改配置、Gateway、Cron 或 Always-On 时，同时检查 `src/cli/politdeck.ts` 与 `src/cli/createLocalGateway.ts`，因为它们是当前模块装配点。
4. 验证命令以 `package.json` 为准：当前根项目使用 `npm run build` 和 `npm test`。

## 目录原则

旧项目分析、新项目方案和当前实现说明分开维护。方案文档可以保留历史取舍，但其中涉及已落地模块、配置字段、CLI 命令和协议 surface 的内容应随 `src/` 同步更新。