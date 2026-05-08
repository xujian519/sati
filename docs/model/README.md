# Model 模块文档

本目录用于管理 `src/model` 模块相关文档。

`model` 模块负责校验和消费全局配置中的 `model` 段，把 agent loop 内部的统一模型请求转换为不同厂商协议，并把不同厂商的响应、流式事件、错误和 usage 解析回统一事件。当前实现支持 Anthropic Messages API 和 OpenAI Chat Completions 兼容协议，同时为未来扩展其他协议、认证方式和传输方式保留抽象。

## 文档结构

1. `[01-model-architecture.md](./01-model-architecture.md)`
  定义 `model` 模块职责、内部结构、边界和与 agent loop 的关系。
2. `[02-provider-protocols.md](./02-provider-protocols.md)`
  定义 Anthropic/OpenAI 两类协议的请求构造、响应解析和流式事件归一化要求。
3. `[03-model-configuration.md](./03-model-configuration.md)`
  定义 `~/.politdeck/politdeck.yaml` 与项目级配置中的 `model` 配置段、provider/model 配置项、环境变量凭据解析和未来扩展点。
4. `[04-model-testing.md](./04-model-testing.md)`
  定义测试方法、测试用例和根目录 `tests/` 下的测试文件组织方式。

## 当前范围

当前阶段由全局 `polit/config` 模块读取 `${PolitHome}/politdeck.yaml`，按需叠加项目根目录 `.politdeck.yaml` 和受控环境变量覆盖，再把合并后的 `model` 段交给 `parseModelConfig()` 校验。该配置段包括默认 provider/model、可选 fallback model、provider URL、API key、协议格式、超时、headers、retry、model list、model 级别 capabilities 和 multimodal input constraints。暂不实现 OAuth 登录、浏览器登录、远端 token 同步等复杂认证方式。