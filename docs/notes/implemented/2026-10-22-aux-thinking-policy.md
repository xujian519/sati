# Agent Note: 辅助模型请求不再强制关闭 thinking

Status: implemented

## Problem

两处辅助请求在请求体里硬编码 `thinking: { enabled: false }`：

- `src/context/compaction/CompactionEngine.ts` 的摘要请求（长上下文压缩）。
- `src/router/tokenSaver/classifyAndRoute.ts` 的分流判定请求（judge）。

该覆写假定所有模型都支持「关闭推理」。部分推理模型（上游以 GLM-5.3 为例）不接受关闭
thinking，请求会被 provider 拒绝；此时压缩与分流直接失败或回退到默认档位，属于可用性缺陷，
而不是成本优化。辅助请求也没有理由替用户否决已配置模型的 thinking 策略。

## Decision

按上游 #665 删除这两处覆写，让辅助请求继承调用方/模型的默认 thinking 策略：

- 压缩摘要请求保留 `stream: true` 与原有 `maxOutputTokens`。
- judge 请求保留 `maxOutputTokens: 256`、`stream: false`，以及「不显式传 temperature」的既有口径。

## Alternatives considered

- **保留覆写，按模型能力表决定是否发送** —— 需要维护 provider/model 能力矩阵，且网关别名与
  自建兼容端点无法可靠判定；删除覆写即可兼容全部模型，成本更高时再由用户侧模型配置约束。
- **改成 `thinking: { enabled: true }`** —— 同样是对模型策略的越权覆写，会让不支持显式开启的
  模型报错，且强制辅助请求产生推理 token。
- **只改 judge、不改压缩** —— 两处问题同源；压缩是长上下文下的关键路径，留下覆写等于保留
  同类故障。
- **仅在配置里加开关** —— 多一个默认值需要迁移的配置项，收益仅是恢复旧行为；上游与本仓库
  都没有需要强制关闭 thinking 的辅助请求场景。

## Consequences

- **换来**：辅助请求不再因模型拒绝关闭 thinking 而失败；请求形态与用户配置的模型策略一致。
  回归判据为 `tests/context/compaction-engine.spec.ts` 与
  `tests/router/tokenSaver/classifyAndRoute.spec.ts` 中对请求对象 `"thinking" in request === false`
  的断言。
- **负控制**：把两处覆写加回后，上述两条断言分别转红；移除后定向 28 例全绿。
- **付出**：对默认开启 thinking 的模型，摘要与 judge 可能产生额外推理 token，时延与成本高于
  旧行为；judge 仍受 `maxOutputTokens: 256` 与超时约束，压缩摘要仍受既有输出上限约束。
- **未验证**：未用真实 GLM-5.3 或其它拒绝该字段的 provider 发起请求；兼容性结论来自请求形态
  与上游报告，本地仅验证请求不再携带该字段。
