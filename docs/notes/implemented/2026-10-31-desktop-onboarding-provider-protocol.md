# Agent Note: 桌面 onboarding 与模型探测保留 openai-responses 协议

Status: implemented

## Problem
桌面首启 onboarding 会把用户选择的 provider 写成 `~/.sati/sati.yaml` 的
`model.providers.sati.protocol`。PR #804 引入的 `providerTypeToProtocol` 只识别
`anthropic` / `google`，其余一律回退 `openai`；同一版本里 `ui/server/routes/config.js`
的 `POST /models` 模型列表探测也有同样的映射遗漏。选择 `openai-responses` 的用户会得到
一份**能通过校验但语义错误**的配置：协议被写成 `openai`，运行时请求 `/v1/chat/completions`
而不是 `/v1/responses`，直到第一条聊天请求失败才暴露。

## Decision
- `providerTypeToProtocol` 增加 `openai-responses → openai-responses` 分支，
  返回类型扩为 `anthropic | openai | openai-responses | google`，与
  `config-validator.ts` 的 `VALID_PROTOCOLS` 对齐。
- `POST /models` 与同文件 `/test-connection` 对齐：识别
  `openai-responses`（及别名 `responses`）并传入正确的 protocol。
- 新增 `tests/desktop/onboarding-config.spec.ts` 锁定映射与 YAML 输出。

## Alternatives considered
- **保持探测端回退 openai** —— 当前 `buildProviderModelsEndpointCandidates` 对
  `openai` 与 `openai-responses` 返回同一 URL，因此模型列表探测暂时不受影响；但两处
  映射漂移会在端点分叉时变成静默回归，选择一次性对齐。
- **让未知 providerType 也回退 anthropic/openai** —— 已被现有 `ALLOWED_PROVIDER_TYPES`
  的抛错分支否决：错误协议写盘后仍能通过校验，失败被推迟到运行时。

## Consequences
- onboarding 与本机模型探测对 `openai-responses` 的行为一致，配置不再静默降级。
- 协议映射仍是硬编码映射表；新增 provider 类型时需同时更新
  `ALLOWED_PROVIDER_TYPES`、`providerTypeToProtocol`、`VALID_PROTOCOLS` 与探测端。
