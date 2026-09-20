# Agent Note: 全局修复 DeepSeek v4 在 default 思考模式下长输出 content 为 0

Status: proposed

## Problem

`deepseek-v4-flash/pro` 在 Sati 的 default 思考模式下，长分析任务的最终 `content` 为 0（只返回 `reasoning_content`）。DeepSeek 官方文档确认 `thinking` 默认 `enabled`、`reasoning_content` 在最终答案之前、`content` 才是答案且与思考共享 `max_tokens`；官方 API 实测长任务默认 → `content` 0，`thinking:{type:"disabled"}` → `content` 5371。根因：`registry.ts` default 分支提前返回 `{enabled:false}` 且未带 `useOpenAICompatibleThinking/thinkingType`，`openai/request.ts` 的 `useOpenAICompatibleThinking` 分支因此未命中、不写 `body.thinking`，DeepSeek 按默认 `enabled` 开启思考。评测链路已用显式 `thinking:{mode:"off"}` workaround，但其它 deepseek-v4 长输出路径仍会 `content` 空。

## Proposal

在 `src/model/thinking/registry.ts` 的 default 分支，对 `/deepseek-v4/` 模型返回 `{ enabled:false, thinkingType:"disabled", useOpenAICompatibleThinking:true, ...omitTemperature }`，使请求体显式 `body.thinking={type:"disabled"}`；其余模型保持原样（default 不传 thinking，跟随模型默认）。`deepseek-reasoner`（/deepseek-v4/ 不匹配、always-thinking 不支持关）与 kimi 不涉及。

## Alternatives considered

- **只修评测链路** — 已作为过渡落地，其它长输出路径仍 `content` 空，弃。
- **request.ts 的 useOpenAICompatibleThinking 加 `else {disabled}`** — default 分支未设该标志，不命中，无效，弃。
- **default 走 deepSeekPlan** — 会变 `enabled+low effort`，改 default 语义（应=不额外开思考），弃。
- **一并关 kimi** — k2.7-code/k3 官方不支持关思考，无法传 disabled，kimi 问题单独处理，弃。
- **配置层改默认** — 治标不治本且影响能力解析，弃。

## Acceptance criteria

- `resolveThinkingPlan({}, deepseekProvider, deepseekV4FlashModel)` 返回 `useOpenAICompatibleThinking:true + thinkingType:"disabled"`。
- `buildOpenAIRequest` 对应请求体含 `body.thinking={type:"disabled"}`。
- default 的 `runtime.complete({model:"deepseek-v4-flash", ...})`（不传 thinking）对本仓库长 statement 返回 `content` 非空（>3000 字符）。
- `deepseek-reasoner` 行为不变；`pnpm typecheck && pnpm lint && pnpm test` 全绿。

## Risks

改变所有 deepseek-v4 default 调用行为（从不思考的"content 满"替代"思考但 content 空"）；若 agent 主循环依赖思考提升质量，应改为主循环显式 `thinking:{mode:"medium"}`；kimi-k2.7-code/k3 长输出仍可能 `content` 空（模型限制，无法此修复）。
