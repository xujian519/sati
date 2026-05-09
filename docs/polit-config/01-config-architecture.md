# Config 模块架构

本文定义当前 `src/polit/config` 的职责、边界和内部结构。该模块属于 `polit` 基础层，与 `src/polit/paths` 一起为上层 runtime 提供产品级默认行为。

当前实现中 `agent`、`model`、`extension`、`memory`、`gateway`、`adapters`、`router`、`alwaysOn` 和 `cron` 段已经进入 `PolitConfig` schema。`tool`、`permission`、context 和 session/transcript 已在 `src` 中形成运行时边界，但仍主要通过构造参数、依赖注入、session state 或 `polit/paths` 配置。本文说明当前架构，并把尚未进入 YAML 的模块作为后续配置段扩展目标。

## 定位

`polit/config` 是配置系统的唯一入口。

它负责：

- 解析 `PolitHome`。
- 从 `PolitHome` 目录加载默认 YAML 配置。
- 读取项目级配置。
- 合并配置来源。
- 解析环境变量和 secret 引用。
- 校验总配置结构。
- 生成不可变 `PolitConfigSnapshot`。
- 向上层 runtime 分发 `model`、`agent`、`router`、`gateway`、`alwaysOn`、`cron` 等配置段。
- 监听配置变化并热重载。
- 产出配置诊断和成功 reload 事件。

它不负责：

- 直接执行模型请求。
- 直接决定 provider adapter 行为。
- 直接管理模型请求生命周期。
- 在模块内部保存业务运行状态。

## 依赖方向

当前 `polit/config` 位于产品基础层，但会调用 `model/config` 对 `model` 配置段做结构和语义校验：

```text
polit/config
  -> polit/paths
  -> model/config/parseModelConfig
  -> model/config/schema
  -> model/protocol/errors
```

上层模块依赖它：

```text
model
  -> polit/config
```

当前 `agent`、`model`、`router`、`gateway`、`alwaysOn`、`cron` 和 `extension` 相关运行时消费 `polit/config` 产出的 snapshot。未来 `context`、`tool`、`permission`、`session` 等模块接入 YAML 时，也应通过 snapshot 消费配置，并保持各模块的二次语义校验在自己的模块边界内完成。

`polit/config` 可以调用 `model/config` 的纯解析逻辑，但不能调用 `ModelRuntime`、provider transport 或任意业务执行代码。

## 核心对象

### PolitHome

`PolitHome` 是 `PolitDeck` 的用户级数据根目录，默认值是：

```text
~/.politdeck
```

它只能由内置默认值和环境变量控制，例如：

```text
POLIT_HOME=/path/to/polit-home
```

`PolitHome` 不允许出现在 YAML 配置中。这样可以避免“先读取 YAML 才知道 YAML 在哪里”的循环依赖，也避免项目配置改变用户级数据根目录。

默认 YAML 配置文件直接从 `PolitHome` 目录下加载：

```text
${PolitHome}/politdeck.yaml
```

该路径不需要单独定义配置文件路径常量。需要加载配置时，根据当前解析出的 `PolitHome` 直接定位 `politdeck.yaml`。

聊天记录、运行历史和未来 session 数据也保存在 `PolitHome` 下，并按 project 区分：

```text
${PolitHome}/projects/<project-id>/chats
```

`project-id` 应由项目根目录的规范化绝对路径派生，把斜杆、空格、冒号等不适合作为目录名的字符替换为短横线。它应保持可读，不使用 hash。

### PolitConfigSource

配置来源的抽象描述。

当前阶段只实现三类 source：

```text
default
project
env
```

建议结构：

```text
kind: default | project | env
path?: string
priority: number
loadedAt: timestamp
contentHash?: string
```

说明：

- `default`：来自 `${PolitHome}/politdeck.yaml` 的默认 YAML 配置。
- `project`：来自当前项目目录 `.politdeck/politdeck.yaml` 的项目级 YAML 配置。
- `env`：来自环境变量的覆盖项，包括 `POLIT_HOME` 和 model 相关覆盖。

`source` 用于诊断。用户看到配置冲突、无效字段或热重载失败时，必须能知道问题来自哪一层配置。

抽象上保留 `kind`、`priority`、`path`、`contentHash` 等字段，未来可以添加 remote、managed profile、adapter override 等来源，但当前实现不接入这些来源。

### PolitRawConfig

`PolitRawConfig` 是 YAML 解析后的未校验对象。它只能在 config 模块内部流转，不能暴露给业务模块。

### PolitConfigSnapshot

`PolitConfigSnapshot` 是业务模块唯一能消费的配置对象。

要求：

- 不可变。
- 有版本号。
- 有来源摘要。
- 有内容 hash。
- 有加载时间。
- 有 schema 版本。
- 已完成默认值填充。
- 已完成配置段拆分。
- 已完成 secret 引用解析或保留受控 secret handle。

建议结构：

```text
PolitConfigSnapshot
  version
  schemaVersion
  loadedAt
  contentHash
  sources
  diagnostics
  config
    model
```

当前 snapshot 的 `config` 已包含多个业务段：

```text
PolitConfigSnapshot
  config
    model
    agent
    extension
    memory?
    gateway?
    adapters?
    router?
    alwaysOn?
    cron?
```

`agent` 段当前只包含默认模型选择；fallback 与场景路由属于 `router` 段。尚未进入 YAML 的 `tool`、`permission`、`context`、`session` 配置仍是后续 schema 扩展边界。

### PolitConfigStore

`PolitConfigStore` 是运行时内存中的快照仓库。

职责：

- 保存当前有效 snapshot。
- 保存最近一次失败 reload 的诊断。
- 提供 `getSnapshot()`。
- 提供 `subscribe(listener)`。
- 原子发布新 snapshot。
- 在热重载失败时保留旧 snapshot。

### PolitConfigLoader

`PolitConfigLoader` 是纯加载流程。

```text
resolve PolitHome from default and env
  -> load ${PolitHome}/politdeck.yaml
  -> load project config
  -> collect supported env overrides
  -> parse YAML
  -> merge
  -> resolve API key env refs while parsing model config
  -> validate
  -> normalize
  -> freeze snapshot
```

该流程应可独立测试，不依赖真实 watcher、UI 或 agent loop。

### PolitConfigWatcher

`PolitConfigWatcher` 监听配置来源变化，并触发 reload。它不直接修改业务模块状态，只向 `PolitConfigStore` 提交加载结果。

## 模块边界

### 与 polit/paths

`polit/paths` 负责：

- `PolitHome`。

当前阶段 `polit/config` 只需要读取和校验与 `PolitHome`、配置文件、缓存和模型配置相关的路径。`PolitHome` 和由它派生出的路径不进入 YAML，只能由默认值和环境变量决定。

聊天记录路径由 `polit/paths` 基于 `PolitHome` 和 project id 派生：

```text
getPolitProjectChatDir(projectRoot) -> ${PolitHome}/projects/<project-id>/chats
```

这属于路径模块能力，不属于 YAML schema。

### 与 adapters

未来 CLI、TUI、SDK、remote adapter 可以传入临时覆盖项，例如：

```text
--model
--provider
```

当前阶段不实现额外覆盖来源。调用方如需影响默认模型选择，只能使用项目级配置或已实现的环境变量覆盖项来覆盖 `agent.model`；fallback 应写入 `router.fallback`，不应绕过 config store 直接修改 `model` 或 `router` 模块。

### 与业务模块

当前阶段业务模块只接收 `model` 配置段：

```text
model consumes snapshot.config.model
```

`model` 模块可以做配置段级别的二次校验，但不能重新读取总 YAML。

未来业务模块接入时遵循同一规则：

```text
agent consumes snapshot.config.agent + snapshot.config.model providers
tool consumes runtime wiring until a tools schema exists
permission consumes runtime/session state until a permission schema exists
context consumes runtime wiring until a context schema exists
session consumes polit/paths derived paths until a session schema exists
```

这些模块不能绕过 `polit/config` 自行读取 `.politdeck/politdeck.yaml`，也不能把运行中产生的用户选择、permission prompt 结果或 transcript 事实写回配置对象。

## 生命周期

启动时：

```text
resolve PolitHome from default and env
  -> load config
  -> publish initial snapshot
  -> start watcher
  -> create model runtime
```

运行时：

```text
file changed
  -> debounce
  -> load candidate snapshot
  -> classify changes
  -> publish if valid
  -> emit config events
```

关闭时：

```text
stop watcher
  -> flush config diagnostics if needed
  -> dispose subscribers
```

## 设计原则

配置系统必须保持保守：

- 缺失配置用明确默认值处理，不能隐式猜测危险行为。
- 无效配置不覆盖当前有效配置。
- 当前模型请求使用发起该请求时绑定的 snapshot。
- 新 snapshot 默认只影响后续模型请求，除非某配置明确标记为 runtime-live。
- secret 不进入普通日志、持久化记录或模型上下文。
- 配置事件可观测，但配置值输出必须脱敏。

