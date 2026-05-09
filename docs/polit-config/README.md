# Polit Config 模块文档

本目录用于管理当前 `src/polit/config` 相关设计文档。

`polit/config` 是 `PolitDeck` 的全局配置入口，负责从 `PolitHome` 目录加载默认 YAML 配置、叠加项目级配置和受控环境变量覆盖，并向运行时提供稳定的配置快照。

当前 `PolitConfig` schema 已包含 `agent`、`model`、`extension`、`memory`、`gateway`、`adapters`、`router`、`alwaysOn` 和 `cron` 顶层段。`agent.model` 只管理默认模型选择；fallback 已迁移到 `router.fallback`，旧的 `agent.fallbackModel` 仅作为废弃字段产生 warning。

## 文档结构

1. `[01-config-architecture.md](./01-config-architecture.md)`
  定义 `polit/config` 的职责、边界、内部结构、依赖方向和运行时对象。
2. `[02-config-schema-and-sources.md](./02-config-schema-and-sources.md)`
  定义 `default`、`project`、`env` 三类配置来源、优先级、YAML 结构、密钥引用和校验规则。
3. `[03-hot-reload-runtime.md](./03-hot-reload-runtime.md)`
  定义配置热重载的 watcher、快照发布、变更分类、原子性、回滚和事件语义。
4. `[04-module-integration.md](./04-module-integration.md)`
  定义 `model`、`agent`、`gateway`、`router`、`alwaysOn` 和 `cron` 如何消费配置，以及配置变更如何影响运行时。
5. `[05-testing-observability-and-ops.md](./05-testing-observability-and-ops.md)`
  定义配置模块的测试、诊断、审计、可观测性和运维要求。
6. `[06-agent-and-session-config.md](./06-agent-and-session-config.md)`
  定义 `agent.model` 和 session 创建之间的配置映射，并说明 fallback 改由 router 管理。
7. `[07-config-change-taxonomy-beyond-model.md](./07-config-change-taxonomy-beyond-model.md)`
  定义 `agent` 与 `model` 配置变更分类原则。

## 核心目标

- 全局配置默认从 `PolitHome/politdeck.yaml` 加载，`PolitHome` 只由默认值和环境变量控制，不写入 YAML。
- 当前实现由 `agent` 段管理默认模型选择，`model` 段管理 provider/model 定义，`router` 段管理 fallback 与场景路由；已接入的运行时通过 snapshot，而不是直接读取 YAML、环境变量或用户目录。
- 配置读取结果以不可变快照形式发布，避免运行时共享可变对象。
- 支持手动 reload 和 best-effort watcher 热重载，并保证已创建的模型 runtime 不会被 reload 中途改写。
- 配置错误必须结构化、可展示、可诊断、可恢复。
- 为 `agent.model`、`router.fallback` 与 `model.providers` 固定边界，避免把默认模型选择、fallback 策略、provider 定义和运行时会话状态混在同一个配置段中。

## 与其他文档的关系

本目录细化 `[../rewrite-plan/](../rewrite-plan/)` 中 `src/polit/config` 的设计。`model` 模块如何消费 `model` 配置段见 `[../model/03-model-configuration.md](../model/03-model-configuration.md)`。