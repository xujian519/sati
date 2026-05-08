# 配置热重载运行时

本文定义 `polit/config` 热重载的运行时语义。目标是在不重启 `PolitDeck` 的情况下让配置变更对后续模型请求生效，同时保证正在执行的模型请求不被破坏。

当前业务只推进到 `model` 模块，因此本文只展开 `model` 配置的热重载影响。snapshot、watcher、失败保旧、变更分类和成功 reload 订阅事件已经有基础实现；审计日志、命名事件总线和 restart-required 检测仍未实现。

## 热重载目标

配置热重载必须满足：

- 文件变化能被自动发现。
- 新配置完整解析和校验后才发布。
- 发布新 snapshot 是原子操作。
- 无效配置不会覆盖当前有效配置。
- 当前模型请求的行为保持稳定。
- 后续模型请求能使用最新有效配置。
- 成功 reload 通过 `PolitConfigStore.subscribe()` 通知 listener。
- secret 不泄露到日志、事件或持久化记录。

## 非目标

热重载不意味着所有配置都能立即修改运行中对象。

不建议支持：

- 中途替换正在流式响应的模型请求。
- 中途替换正在使用中的 provider adapter 实例。
- 中途把已构造完成的 model request 改写成另一个 provider 协议。
- 在一个模型流内部混用新旧 API key、headers 或 URL。

这些行为会让模型请求语义不稳定，应通过变更分类控制。

## 核心原则

### Snapshot 绑定

当前实现中，调用方先从 `PolitConfigStore` 读取 snapshot，再用 `snapshot.config.model` 创建或调用 `ModelRuntime`：

```text
configStore.getSnapshot()
  -> createModelRuntime(snapshot.config.model)
  -> ModelRuntime.stream/complete(request)
```

`ModelRuntime` 持有创建时传入的 `ModelConfig`。reload 不会改写已经创建的 runtime，因此已发起请求不会在过程中切换 API key、URL、headers 或 capabilities。调用方如需让后续请求使用新配置，需要用新 snapshot 创建或选择新的 runtime。

### 原子发布

热重载流程必须先构造候选 snapshot：

```text
file changed
  -> load candidate
  -> validate candidate
  -> classify diff
  -> publish candidate
```

只有候选 snapshot 完全有效时，才替换 `currentSnapshot`，并向订阅者发布 `PolitConfigReloadEvent`。

### 失败保旧

如果 reload 失败：

```text
current snapshot remains active
lastReloadDiagnostics = diagnostics
reload promise rejects
```

运行时继续使用旧 snapshot。当前实现会把失败诊断保存到 `lastReloadDiagnostics`，通过 `getDiagnostics()` 查询；失败 reload 不会向 subscriber 发布事件。

## Watcher 设计

`startWatching()` 当前监听：

- `${PolitHome}/politdeck.yaml`。
- 当前 workspace 的项目级配置。

实现要求：

- 使用 debounce 合并短时间内的多次写入。
- 处理编辑器保存时的 rename/write 临时文件行为。
- 处理文件被删除、重建、权限变化。
- 处理符号链接解析后的真实路径。
- watcher 失败时降级为手动 reload，不应导致 agent loop 崩溃。

当前默认 debounce：

```text
250ms
```

配置文件通常很小，不需要复杂增量解析。每次 reload 都可以完整读取和校验。

## 手动 Reload

除自动 watcher 外，应提供手动 reload API：

```text
configStore.reload(reason?)
```

常见来源：

- CLI 命令。
- SDK 调用。
- UI 设置页保存。
- 测试用例。
- watcher 降级后的人工触发。

手动 reload 与 watcher reload 共享同一条加载和校验路径。

## 变更分类

热重载会对新旧 snapshot 的 `config` 字段做结构 diff，并给出变更分类。

类型中保留以下分类：

```text
runtime-live
next-request
next-runtime
restart-required
invalid
```

### 当前分类实现

当前 `classifyConfigChanges()` 的实现很保守：

```text
changed path starts with "model." -> next-request
other changed path                   -> next-runtime
```

由于 snapshot 当前只包含 `config.model`，实际发布的业务变更通常都是 `next-request`。

### runtime-live

可以立即影响配置运行时本身，不改变已发出的模型请求。

示例：

- 配置诊断展示级别。

即使是 `runtime-live`，也不能修改已发出的模型请求或已发出的事件。

### next-request

只对后续模型请求生效。

示例：

- 默认模型。
- fallback model。
- provider URL。
- provider timeout。
- provider headers。
- provider retry。
- provider model list。
- model capabilities。
- multimodal constraints。
- API key 引用解析结果。

这是大多数配置的默认分类。

### next-runtime

只对重新创建的长生命周期运行时对象生效。

示例：

- 未来需要长生命周期连接池的 provider transport。
- 未来需要会话级模型策略的配置。

当前阶段 model 配置通常不需要 `next-runtime`。如果未来某些 provider 连接在长生命周期运行时对象中固定，则再使用该分类。

### restart-required

必须重启进程才能生效。

示例：

- PolitHome 大幅迁移。
- cache 根目录迁移。
- 底层进程级 proxy 或证书配置。

`PolitHome` 不来自 YAML，只能由环境变量改变。当前 snapshot 的业务 config 不包含 `PolitHome`，因此当前实现不会通过 diff 把 `POLIT_HOME` 变化分类为 `restart-required`。如果未来支持运行时检测 `POLIT_HOME` 变化，应标记为 `restart-required`，不在当前进程内迁移配置、缓存或聊天记录目录。

### invalid

候选配置无效，不能发布。

示例：

- YAML 语法错误。
- required 字段缺失。
- API key 引用的环境变量不存在。
- 默认模型不存在。
- provider protocol 不支持。
- provider URL 非法。
- model capabilities 类型非法。
- multimodal input 包含不支持的模态。

## 配置事件

当前没有独立的命名配置事件总线，只有 `PolitConfigStore.subscribe()` 的成功 reload 事件。事件不要进入模型上下文。

未来可扩展命名事件：

```text
config.load.started
config.load.completed
config.load.failed
config.reload.detected
config.reload.started
config.reload.completed
config.reload.failed
config.snapshot.published
config.restart.required
```

当前 `PolitConfigReloadEvent` payload 包含：

```text
previousSnapshot
nextSnapshot
changedPaths
changeClasses
```

payload 中不能包含未脱敏 secret。

## Snapshot 发布协议

`ConfigStore.subscribe()` 的 listener 不应直接执行重活。

当前协议：

```text
subscribe((event) => {
  event.previousSnapshot
  event.nextSnapshot
  event.changedPaths
  event.changeClasses
})
```

listener 要求：

- 不能阻塞发布路径太久。
- 不能抛出未捕获异常。
- 不能修改 snapshot。
- 需要异步重建资源时，应创建自己的后台任务。

## 模块响应热重载

### Model

`model` 模块对后续请求读取新配置的前提是调用方用最新 snapshot 创建或选择 runtime。

可热重载：

- default model。
- provider timeout。
- headers。
- retry。
- model capabilities。
- multimodal constraints。

谨慎处理：

- API key 改变后，新请求使用新 key；已有请求不切换。
- provider URL 改变后，新请求使用新 URL；连接池可延迟重建。

### 未来业务模块

`context`、`tool`、`permission`、`session`、`extension` 等模块的热重载语义等对应模块进入实现阶段后再定义。当前文档不提前规定这些模块的业务行为。

## 并发与竞态

必须处理：

- 多次 reload 并发触发。
- reload 时新的模型请求正在构造。
- reload 时调用方可能正在为新 snapshot 创建 model runtime。
- reload 时已有模型流正在消费。

建议策略：

- reload 串行化，同一时间只允许一个 reload pipeline。
- 新模型请求总是读取当时已发布的最新 snapshot。
- 候选 snapshot 不对外可见。
- 如果调用方在订阅事件后异步重建 runtime，应绑定目标 snapshot version。
- 过期 runtime rebuild 完成后不得覆盖更新版本。

## 删除配置文件

如果用户删除 `${PolitHome}/politdeck.yaml`：

- watcher 应触发 reload。
- loader 应继续尝试项目级配置和 env overrides。
- 如果缺失必需 `model` 配置导致无法构造有效 snapshot，保留旧 snapshot。
- 诊断会保存在 `lastReloadDiagnostics` 中；当前缺失文件本身不会单独记录 source，最终通常表现为 `CONFIG_MODEL_MISSING`。

当前不允许无有效 `model` 配置启动；启动加载时缺失 `model` 段会抛出 `PolitConfigError`。

## 回滚

热重载失败天然回滚到旧 snapshot。

如果新 snapshot 已发布但业务资源重建失败，应区分：

- snapshot 已生效。
- 某模块资源未完成切换。

模块应发出自己的诊断，例如：

```text
model.provider.reload.failed
model.registry.reload.failed
```

必要时该模块继续使用旧资源，直到下一次 reload 成功。

## Model 安全与审计

热重载可能改变模型连接边界，因此未来应审计：

- provider URL 变化。
- provider protocol 变化。
- API key 引用变化。
- headers 中认证相关字段变化。
- default model 变化。
- fallback model 变化。
- model capabilities 变化，尤其是 tool use、streaming、thinking、JSON schema、max context token。
- multimodal input constraints 变化。

这些变更未来应进入 audit log，并在交互式 UI 中提示用户。当前实现只提供 changed paths 和 change classes，secret 值本身必须脱敏。

## 推荐默认语义

为了降低复杂度，默认采用：

- 当前模型请求绑定旧 snapshot。
- 后续模型请求使用新 snapshot。
- 当前变更分类主要是 `next-request`。
- path 大变更的 `restart-required` 分类是未来扩展。
- reload 失败保留旧 snapshot。

这个语义最容易测试，也最不容易让 agent loop 在真实项目中出现不可解释行为。