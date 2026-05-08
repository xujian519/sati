# Polit Config 模块文档

本目录用于管理重写方案中 `src/polit/config` 相关设计文档。

`polit/config` 是 `PolitDeck` 的全局配置入口，负责从 `PolitHome` 目录加载默认 YAML 配置、叠加项目级配置和受控环境变量覆盖，并向当前已进入实现阶段的 `model` 模块提供稳定的配置快照。

当前业务只推进到 `model` 模块，因此本文档只展开 `model` 相关配置。快照、配置来源、诊断、脱敏、手动 reload 和基于 `fs.watch` 的热重载已经在 `src/polit/config` 中实现；审计、CLI doctor、跨入口 conformance 等仍是未来扩展边界。

## 文档结构

1. `[01-config-architecture.md](./01-config-architecture.md)`
  定义 `polit/config` 的职责、边界、内部结构、依赖方向和运行时对象。
2. `[02-config-schema-and-sources.md](./02-config-schema-and-sources.md)`
  定义 `default`、`project`、`env` 三类配置来源、优先级、YAML 结构、密钥引用和校验规则。
3. `[03-hot-reload-runtime.md](./03-hot-reload-runtime.md)`
  定义配置热重载的 watcher、快照发布、变更分类、原子性、回滚和事件语义。
4. `[04-module-integration.md](./04-module-integration.md)`
  定义当前阶段 `model` 模块如何消费配置，以及配置变更如何影响后续模型请求。
5. `[05-testing-observability-and-ops.md](./05-testing-observability-and-ops.md)`
  定义配置模块的测试、诊断、审计、可观测性和运维要求。

## 核心目标

- 全局配置默认从 `PolitHome/politdeck.yaml` 加载，`PolitHome` 只由默认值和环境变量控制，不写入 YAML。
- 当前阶段只有 `model` 模块消费解析后的业务配置段，不直接读取 YAML、环境变量或用户目录。
- 配置读取结果以不可变快照形式发布，避免运行时共享可变对象。
- 支持手动 reload 和 best-effort watcher 热重载，并保证已创建的模型 runtime 不会被 reload 中途改写。
- 配置错误必须结构化、可展示、可诊断、可恢复。

## 与其他文档的关系

本目录细化 `[../rewrite-plan/](../rewrite-plan/)` 中 `src/polit/config` 的设计。`model` 模块如何消费 `model` 配置段见 `[../model/03-model-configuration.md](../model/03-model-configuration.md)`。