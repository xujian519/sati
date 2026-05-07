# Config 模块架构

本文定义重写方案中 `src/polit/config` 的职责、边界和内部结构。该模块属于 `polit` 基础层，与 `src/polit/paths`、`src/polit/runtime` 一起为上层 runtime 提供产品级默认行为。

当前业务只进行到 `model` 模块，因此本文只把 `model` 作为已接入配置系统的业务模块展开。其他模块的配置段是未来阶段的扩展目标，不在当前阶段设计具体字段或运行时语义。

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
- 向 `model` 模块分发 `model` 配置段。
- 监听配置变化并热重载。
- 产出配置诊断、变更事件和审计记录。

它不负责：

- 直接执行模型请求。
- 直接决定 provider adapter 行为。
- 直接管理模型请求生命周期。
- 在模块内部保存业务运行状态。

## 依赖方向

`polit/config` 位于架构底层，只能依赖通用基础能力：

```text
polit/config
  -> polit/paths
  -> shared/fs
  -> shared/schema
  -> shared/errors
  -> shared/events
```

上层模块依赖它：

```text
model
adapters
  -> polit/config
```

当前阶段只有 `model` 和 adapter 需要直接接入 `polit/config`。未来 `agent`、`context`、`tool`、`permission`、`session`、`extension` 等模块接入时，也应保持同样依赖方向。

`polit/config` 不应反向依赖 `model` 或任意 adapter。配置模块可以知道 `model` 配置段名字，但不能调用 `model` 模块的运行时代码。

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

`project-id` 应由项目根目录的稳定标识派生，例如规范化绝对路径 hash，避免不同项目的聊天记录混在一起。

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
- `project`：来自当前项目目录的项目级 YAML 配置。
- `env`：来自环境变量的覆盖项，包括 `POLIT_HOME` 和 model 相关覆盖。

`source` 用于诊断和审计。用户看到配置冲突、无效字段或热重载失败时，必须能知道问题来自哪一层配置。

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

当前阶段 `model` 模块拿到 snapshot 后只读取 `snapshot.config.model`。其他业务段等对应模块进入实现阶段后再加入 snapshot。

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
  -> collect env overrides
  -> parse YAML
  -> merge
  -> resolve env and secret refs
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

CLI、TUI、SDK、remote adapter 可以传入临时覆盖项，例如：

```text
--model
--provider
```

当前阶段不实现额外覆盖来源。adapter 如需影响配置，应通过环境变量或项目级配置进入 `polit/config`，不应绕过 config store 直接修改 `model` 模块。

### 与业务模块

当前阶段业务模块只接收 `model` 配置段：

```text
model consumes snapshot.config.model
```

`model` 模块可以做配置段级别的二次校验，但不能重新读取总 YAML。

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

