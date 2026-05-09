# 多模块配置变更分类

本文定义 `agent`、`model`、`router` 等配置段的变更分类，以及更多 future 配置段进入 `PilotConfig` 后 `classifyConfigChanges()` 应如何扩展。当前实现对 `agent.*`、`model.*` 和 `router.*` 等请求选择相关路径返回后续生效分类，长生命周期 runtime 配置通常归为 `next-runtime`。

## 分类定义

配置变更分类保持五类：

```text
runtime-live
next-request
next-runtime
restart-required
invalid
```

- `runtime-live`：可以立即影响配置系统自身或后台维护任务，不改写已发出的模型请求、工具调用或 session state。
- `next-request`：影响后续模型请求、后续 context prepare 或后续工具调用。
- `next-runtime`：需要重建长生命周期 runtime 对象，例如 registry、context runtime、MCP adapter 或 storage provider。
- `restart-required`：需要重启进程，通常涉及 `PilotHome`、进程级证书、全局 proxy、插件加载路径或 transcript 路径迁移。
- `invalid`：候选配置无效，不能发布。

## 推荐路径分类

未来可以从路径前缀开始分类，再由字段级规则细化：

```text
agent.model                    next-request
router.scenarios               next-request
router.fallback                next-request
gateway.*                      next-runtime
alwaysOn.*                     next-runtime
cron.*                         next-runtime
model.providers                next-request
model.provider.url             next-request
model.provider.apiKey          next-request
model.provider.timeoutMs       next-request
model.provider.headers         next-request
model.provider.retry           next-request
model.capabilities             next-request
model.multimodal               next-request
```

这些分类是目标语义；真正实现时应和具体 runtime 重建策略一起测试。

## Field-Level 规则

仅靠路径前缀不够。以下字段必须有专门规则：

- `agent.model`：改变默认厂商和默认模型，影响后续模型请求，不改变已构造完成的 `CanonicalModelRequest`。
- `router.fallback`：改变 fallback recovery policy 的目标，只影响后续 router retry/fallback 判断。
- `model.providers`：新增、删除或修改 provider/model 定义，影响后续 runtime 编译和请求校验。
- `model.provider.apiKey`：secret 变化必须脱敏记录，只影响后续请求。
- `model.capabilities` / `model.multimodal`：影响后续 request builder 和 context/input 投影，不改写已发送请求。

## Invalid 变更

候选配置如果出现以下情况，应归为 `invalid` 并保留旧 snapshot：

- `agent.model` 不是 `provider/model` 格式。
- `agent.model` 指向不存在的 provider 或 model。
- `router.fallback.*` 不是 `provider/model` 格式。
- `router.fallback.*` 指向不存在的 provider 或 model。
- provider protocol、URL、API key 引用或 model capabilities 非法。
- 任意 secret 引用无法解析。

## 请求绑定原则

任何分类都不能违反请求绑定原则：

- 已经构造完成的 `CanonicalModelRequest` 不被 reload 改写。
- 已经发送给模型的 tool schema 不被 reload 改写。
- 已经开始执行的 tool call 不被 reload 改写。
- 已经写入的 transcript entry 不被 reload 修改。
- 已经产生的 permission decision 不被 reload 回滚。

## 实现要求

扩展 `classifyConfigChanges()` 时应同步增加测试：

- `agent.model`、`router.scenarios`、`router.fallback` 至少覆盖后续生效分类用例。
- 高风险字段覆盖 `restart-required` 或 `next-runtime` 用例。
- invalid candidate 不发布 snapshot。
- 多字段变更返回去重后的 change classes。
- secret 变化只输出 redacted path，不输出 secret 值。
