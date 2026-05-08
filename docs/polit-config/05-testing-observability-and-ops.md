# 测试、可观测性与运维

本文定义 `polit/config` 模块的测试策略、诊断输出、审计要求和运维细节。

## 测试目标

`polit/config` 必须从第一天具备确定性测试。当前业务只推进到 `model` 模块，因此测试重点是通用配置运行时和 `model` 配置段。

当前测试已经覆盖 YAML 读取、来源合并、env credential 解析、禁止 YAML `polit` 段、project chat dir 派生和 reload 失败保旧。后续测试应继续覆盖：

- YAML 读取。
- 多来源合并。
- 默认值填充。
- schema 校验。
- secret 引用解析。
- 配置段拆分。
- snapshot 不可变性。
- 热重载成功。
- 热重载失败保旧。
- 变更分类。
- 成功 reload 事件和诊断脱敏。
- watcher 竞态。

## 单元测试

当前源码中的主要测试对象：

```text
loadPolitConfig()
createPolitConfigStore()
mergeConfigSources()
diffConfigSnapshots()
classifyConfigChanges()
redactConfig()
```

重点用例：

- 空配置缺少 `model` 段时报 `CONFIG_MODEL_MISSING`。
- 缺失 `schemaVersion` 产生 warning。
- 未知字段产生 warning。
- 非法 enum 产生 error。
- array 覆盖而不是拼接。
- `null` 清空可选字段。
- `${ENV}` 引用成功。
- `${ENV}` 缺失失败。
- 明文 API key 被接受且在诊断/输出中脱敏。
- 默认模型不存在时报错。
- provider protocol 非法时报错。
- provider URL 非法时报错。
- model capabilities 类型错误时报错。
- multimodal input 非法时报错。

## 热重载测试

热重载需要 fake fs 和 fake clock。

建议用例：

```text
valid file change publishes new snapshot
invalid file change keeps previous snapshot
rapid writes are debounced
delete file falls back or reports diagnostics
rename temp file save is handled
concurrent reloads are serialized
stale async rebuild cannot overwrite newer snapshot
restart-required changes are reported（未来扩展）
secret changes are not logged
```

必须验证：

- `snapshot.version` 单调递增。
- reload 失败时 version 不变。
- `lastReloadDiagnostics` 可通过 `getDiagnostics()` 查询。
- reload 失败时 `getDiagnostics()` 包含失败诊断；当前失败 reload 不发布 subscriber 事件。
- 当前模型请求绑定旧 snapshot。
- 后续模型请求使用新 snapshot。

## 集成测试

集成测试应覆盖 config 与 `model` 模块的连接。

建议场景：

- 修改默认模型后，新的模型请求使用新模型。
- 修改 provider URL 后，后续模型请求使用新 URL。
- 修改 API key 引用后，后续模型请求使用新 secret。
- 修改 timeout、headers、retry 后，后续 request builder 使用新参数。
- 修改 model capabilities 后，后续请求校验和构造使用新能力。
- 修改 multimodal constraints 后，后续 canonical content block 校验使用新限制。
- 非法 model 配置热重载失败后，旧 snapshot 继续可用。

这些测试可以使用 fake transport 和 fake provider adapter，不需要真实外部服务。

## Conformance Tests

跨入口一致性测试是未来目标。当前源码尚未实现 CLI/SDK/TUI/remote adapter 入口：

```text
CLI config loading
SDK config loading
TUI config loading
remote config loading
```

未来同一组 source 输入必须产出相同 snapshot。adapter 不能增加新的 source 类型；当前阶段所有入口只能使用 `default`、`project`、`env` 三类来源，并且必须产出相同 snapshot。

## 诊断输出

配置诊断应面向用户可读，也要适合机器处理。

建议结构：

```text
ConfigDiagnostic
  code
  severity
  message
  path
  source
  hint
  redactedValue?
```

示例：

```text
code: CONFIG_MODEL_DEFAULT_NOT_FOUND
severity: error
path: model.defaultModel
source: ${PolitHome}/politdeck.yaml
hint: Add the model under model.providers.<provider>.models or change model.defaultModel.
```

诊断中的 path 使用配置路径，不使用源码路径。

## 脱敏规则

以下字段必须脱敏：

- `apiKey`。
- `authorization` header。
- `cookie` header。
- token、secret、password、credential 相关字段。
- proxy credential。

脱敏输出：

```text
<redacted>
```

可选保留 hash 或后四位用于排查：

```text
<redacted:sha256:abcd1234>
```

任何脱敏 hash 都不能用于恢复原 secret。

## 日志

未来可扩展日志事件：

```text
config.load.start
config.load.success
config.load.failure
config.reload.detected
config.reload.success
config.reload.failure
config.snapshot.publish
config.change.restart_required
config.secret.reference_missing
```

未来日志应包含：

- snapshot version。
- source summary。
- config hash。
- changed paths。
- diagnostics count。

日志不能包含完整配置内容。

## Audit

模型连接相关配置变化未来必须进入 audit。当前实现只提供 changed paths、change classes 和诊断，没有 audit sink。

包括：

- `model.provider.url`。
- `model.provider.protocol`。
- `model.provider.apiKey` 引用。
- `model.provider.headers` 中的认证相关变化。
- `model.defaultProvider`。
- `model.defaultModel`。
- `model.fallbackModel`。
- `model.providers.<id>.models`。
- `model.capabilities`。
- `model.multimodal`。

未来 audit 记录应包含：

```text
timestamp
actor
source
previousSnapshotVersion
nextSnapshotVersion
changedPaths
changeClass
```

未来交互式 UI 可以把高风险变更显示给用户确认。headless 场景至少要写入 audit sink。

## Debug 命令

未来 CLI 可提供：

```text
politdeck config validate
politdeck config doctor
politdeck config print --redacted
politdeck config sources
politdeck config reload
```

命令语义：

- `validate`：读取并校验配置，不启动 agent runtime。
- `doctor`：检查路径、secret 引用、模型默认值、provider URL 和协议配置。
- `print --redacted`：输出最终合并后的脱敏配置。
- `sources`：输出所有参与合并的 source 和优先级。
- `reload`：对正在运行的 runtime 触发手动 reload。

## 失败处理

启动失败：

- YAML 语法错误：阻止启动。
- 任一 provider 的 `apiKey` 缺失或环境变量引用无法解析：当前加载直接失败。
- 默认 provider 或默认模型非法：阻止模型请求。
- provider protocol 或 URL 非法：阻止该 provider 可用。

热重载失败：

- 保留旧 snapshot。
- 保存失败诊断；当前不发布 failure 事件。
- 记录诊断。
- UI/CLI 显示错误。
- 不影响当前模型请求。

模块资源重建失败：

- snapshot 可以已发布。
- 模块继续使用旧资源或降级。
- 记录模块级 reload failure。
- 后续 reload 可恢复。

## 性能要求

配置加载应足够轻量：

- 小型 YAML reload 应在几十毫秒内完成。
- secret 解析不能做慢速网络请求。
- watcher debounce 避免编辑器保存风暴。
- snapshot diff 只比较结构化配置，不扫描工作区。
- 如果调用方异步重建 model runtime，需要绑定 snapshot version。

如果未来 secret backend 或 remote config 需要网络访问，应把它们设计为独立 provider，并明确 timeout、cache 和失败策略。

## 文档与示例

未来配置模块应维护示例文件：

```text
examples/politdeck.yaml
examples/politdeck.minimal.yaml
examples/politdeck.model.yaml
examples/politdeck.model-openai.yaml
```

示例未来必须保持可通过 `config validate`。包含 secret 的示例只能使用 `${ENV_NAME}`。

## 发布前检查清单

实现 `polit/config` 前，至少确认：

- 是否有总 schema。
- 是否有默认值表。
- 是否有 `default/project/env` source 优先级测试。
- 是否有热重载失败保旧测试。
- 是否有 secret 脱敏测试。
- 是否有 restart-required 变更分类（当前类型保留但 diff 不会报告 `POLIT_HOME`）。
- 是否有当前模型请求绑定 snapshot 的行为测试。
- 是否有 CLI/SDK 一致性测试。

当前 `model` 模块已经可以通过 `loadPolitConfig()` 和 `createModelRuntime(snapshot.config.model)` 接入真实运行时配置。其他业务模块进入实现阶段时，再扩展各自的配置 schema、热重载语义和集成测试。