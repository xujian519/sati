# 配置 Schema 与来源

本文定义 `polit/config` 需要支持的配置来源、优先级、总 YAML 结构、配置段拆分和校验规则。

当前业务只推进到 `model` 模块，因此本文只定义通用配置外壳和 `model` 配置段。其他模块的配置段不在当前阶段进入 schema。

## 配置文件

默认 YAML 配置文件位于 `PolitHome` 目录下：

```text
${PolitHome}/politdeck.yaml
```

`PolitHome` 默认是 `~/.politdeck`，只能由内置默认值和环境变量控制，例如 `POLIT_HOME`。`PolitHome`、缓存目录、聊天记录目录等 `polit` 路径配置不允许出现在 YAML 中。

项目级配置文件位于调用方传入的 `projectRoot` 根目录：

```text
<project>/.politdeck.yaml
```

聊天记录保存在 `PolitHome` 下，按 project 区分：

```text
${PolitHome}/projects/<project-id>/chats
```

`project-id` 由项目根目录的规范化绝对路径稳定派生：将斜杆、空格、冒号等不适合作目录名的字符替换为短横线，不使用 hash，也不由 YAML 配置。

## 配置来源

建议配置来源按优先级从低到高排列：

```text
default config: ${PolitHome}/politdeck.yaml
  < project config: <workspace>/.politdeck.yaml
  < env overrides
```

说明：

- `default config` 是默认 YAML 配置文件，由 `PolitHome` 决定位置。
- `project config` 只描述工作区相关覆盖，不应保存用户 secret。
- `env overrides` 当前只支持 `POLIT_HOME` 以及 `POLIT_MODEL_DEFAULT_PROVIDER`、`POLIT_MODEL_DEFAULT_MODEL`、`POLIT_MODEL_FALLBACK_MODEL`。API key 通过配置中的 `${ENV_NAME}` 引用解析，不作为独立配置覆盖项。

所有实际参与加载或覆盖的来源都会记录在 `PolitConfigSnapshot.sources` 中；不存在的默认/项目文件不会产生 source 记录。

当前阶段 `PolitConfigSource.kind` 只允许：

```text
default
project
env
```

抽象上仍保留 `priority`、`path`、`contentHash`、`loadedAt` 和可选 `phase` 等字段，未来可扩展 remote config、managed profile 或 adapter override，但当前实现不读取这些来源。

### Env 的两阶段作用

`env` source 有两类作用：

- bootstrap env：在读取任何 YAML 前解析，例如 `POLIT_HOME`。它决定 `${PolitHome}/politdeck.yaml` 的位置。
- config env override：在 YAML 读取后参与合并，例如默认 provider、默认 model 或 API key 引用。

这两类都归入 `kind: env`，但诊断中应区分 `phase: bootstrap | merge`，避免用户误以为 `POLIT_HOME` 可以写在 YAML 中。

## 合并规则

合并规则必须可预测：

- map 按 key 深度合并。
- scalar 由高优先级覆盖低优先级。
- array 默认整体替换，不做去重拼接。
- 对于 `model.providers`、`model.providers.<id>.models` 这类 map，按 provider id 或 model id 深度合并。
- `null` 会按普通值参与覆盖；当前 model schema 多数可选字段只接受 `undefined` 或正确类型，因此不要依赖 `null` 清空字段。
- 未知字段默认报 warning；稳定版可以升级为 error。

不建议支持复杂模板、条件语句或脚本化配置。配置文件应保持声明式。

## 总配置结构

建议总 YAML 结构：

```yaml
schemaVersion: 1

model:
  defaultProvider: anthropic-main
  defaultModel: claude-sonnet-4-5
  fallbackModel: claude-haiku-4-5
  providers:
    anthropic-main:
      protocol: anthropic
      url: https://api.anthropic.com
      apiKey: ${ANTHROPIC_API_KEY}
      timeoutMs: 120000
      headers:
        anthropic-version: "2023-06-01"
      models:
        claude-sonnet-4-5:
          displayName: Claude Sonnet 4.5
          capabilities:
            supportsToolUse: true
            supportsStreaming: true
            supportsParallelToolCalls: true
            supportsThinking: true
            supportsJsonSchema: true
            supportsPromptCache: true
            maxContextTokens: 200000
            maxOutputTokens: 8192
          multimodal:
            input: [text, image, pdf]
            maxImagesPerRequest: 20
            supportedImageMimeTypes:
              - image/png
              - image/jpeg

```

## 配置段职责

### 不允许的 polit 路径配置

YAML 中不允许出现 `polit` 段来配置 `PolitHome`、缓存目录、聊天记录目录或其他产品级路径。

这些路径只能通过：

- 内置默认值。
- 环境变量，例如 `POLIT_HOME`。
- `polit/paths` 基于 `PolitHome` 派生出的固定规则。

原因：

- config loader 必须先知道 `PolitHome`，才能找到默认 YAML。
- 项目级配置不应改变用户级数据根目录。
- 聊天记录、缓存等路径应保持全局一致，避免配置热重载时迁移运行时数据。

### model

`model` 段描述 provider、model list、URL、headers、timeout、API key 引用、capabilities 和 multimodal constraints。

具体字段见 `[../model/03-model-configuration.md](../model/03-model-configuration.md)`。

### 未来业务配置段

`loop`、`context`、`tool`、`permission`、`session`、`extension` 等配置段等对应模块进入实现阶段后再定义。当前阶段不要提前把这些字段写入正式 schema，避免为尚未实现的业务行为制造兼容负担。

## Secret 引用

当前阶段支持环境变量引用：

```yaml
model:
  providers:
    anthropic-main:
      apiKey: ${ANTHROPIC_API_KEY}
```

解析规则：

- `${NAME}` 从环境变量读取。
- 缺失环境变量是配置错误。
- 明文 secret 允许；当前实现不会为明文 `apiKey` 单独产生 warning。
- 日志、诊断、事件和 snapshot debug 输出必须脱敏。

未来可以扩展：

```yaml
apiKey:
  from: keychain
  name: anthropic-main
```

或：

```yaml
auth:
  type: oauth
  tokenStore: polit
```

但当前阶段不实现 OAuth。

## Schema 版本

`schemaVersion` 是顶层字段。当前实现只支持版本 `1`；缺失时按 `1` 处理并产生 warning。

建议策略：

- 缺失时按 `1` 处理并 warning。
- 大于当前支持版本时报错。
- 当前只支持 `schemaVersion: 1`；没有实现迁移器。

## 校验层次

配置校验分三层：

```text
syntax validation
  -> structural validation
  -> semantic validation
```

`syntax validation` 检查 YAML 是否可解析。

`structural validation` 检查字段类型、枚举值、必填字段和默认值。

`semantic validation` 检查跨字段关系，例如：

- `model.defaultProvider` 必须存在。
- `model.defaultModel` 必须属于默认 provider。
- `model.fallbackModel` 如果存在，也必须属于某个可用 provider。
- `model.providers.<id>.protocol` 必须是当前支持的协议。
- `model.providers.<id>.url` 必须是合法 URL。
- `model.providers.<id>.apiKey` 的环境变量引用必须可解析。
- `model.providers.<id>.models` 不能为空。
- `model.providers.<id>.models.<model>.capabilities` 可以缺省，缺省时使用协议默认值；出现的字段必须类型正确。
- `model.providers.<id>.models.<model>.multimodal.input` 只能包含当前 canonical protocol 支持的输入模态。

## 错误模型

当前配置诊断结构为：

```text
PolitConfigDiagnostic
  code
  severity
  message
  path?
  source?
  hint
  redactedValue?
  recoverable?
```

`severity` 支持：

```text
info
warning
error
fatal
```

启动时遇到 `fatal` 会抛出 `PolitConfigError`。热重载时遇到 `fatal` 不替换当前 snapshot，`PolitConfigStore` 会保留旧 snapshot 并保存最近一次失败诊断；当前实现不会为失败 reload 发布订阅事件。