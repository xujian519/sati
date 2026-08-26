# Agent Note: Agent 主循环对 deepseek-v4 显式开启思考（medium）

Status: implemented

## Problem

`docs/notes/proposed/2026-08-26-p0-model-deepseek-v4-thinking-default.md` 落地后，`resolveThinkingPlan` 的 `default` 分支对所有 `/deepseek-v4/` 模型显式返回 `{type:"disabled"}`（为保护确定性/benchmark 调用方的长输出不被 `reasoning_content` 榨干 `content`）。但 agent 主循环（`AgentLoop` 的 `createModelRequest`）在 pilot 未配置 `agent.thinking` 时把 `thinking` 置为 `undefined` → 落入该 default 分支 → **主循环的 deepseek-v4 完全不思考**。这与该 proposed note 自述一致（"若 agent 主循环依赖思考提升质量，应改为主循环显式 `thinking:{mode:"medium"}`"），即修复全局默认后遗留的主循环回归。

## Decision

- `src/model/thinking/registry.ts` 新增并导出 `defaultAgentThinking(modelId)`：对 `/deepseek-v4/` 返回 `{ mode:"medium", enabled:true }`（v4 的 medium 映射 `reasoning_effort=high`），其余模型返回 `undefined`（沿用 `resolveThinkingPlan` default 分支）。
- `src/agent/loop/AgentLoop.ts` 的 `createModelRequest`：`thinking: this.config.thinking ?? defaultAgentThinking(this.config.model)`。主循环（含 agent 工具 fork 的子代理，二者都跑 `AgentLoop`）在未显式配置时默认开启 medium 思考；确定性/benchmark 调用方（`patent-evolve.mjs`、session-title、compaction、token-saver）不进 `AgentLoop`，各自显式传 `off`/`disabled`，不受影响。
- `src/pilot/config/loadPilotConfig.ts` 的 `parseAgentThinking`：区分「未配置」与「显式 `enabled:false`」——前者返回 `undefined`（可被主循环默认覆盖为 medium），后者返回 `{ enabled:false }`（truthy，不被 `??` 覆盖 → 走 registry default 分支关闭）。这样 deepseek-v4 主循环可通过 pilot `agent.thinking.enabled:false` 真正关闭思考，而非被主循环默认忽略。函数导出以便单测。

## Alternatives considered

- **在 `createLocalGateway.ts` 组装 `thinking: agent.thinking ?? defaultAgentThinking(model)`** — 也能生效，但只覆盖 gateway 单一入口；放在 `AgentLoop.createModelRequest` 覆盖所有跑主循环的路径（含子代理），且不把模型语义硬编码进网关编排层，弃。
- **改回 registry `default` 分支为 deepseek-v4 开启思考** — 会让该分支重新对 benchmark/确定性调用方开启思考，重蹈 content=0；并推翻上一份已实现的 proposed note，弃。
- **对 deepseek-v4 主循环默认 `low`（`reasoning_effort=low`）** — low 实测仍能出 content（3928 字）且思考更省预算；但用户明确要求 medium，且主循环有空响应兜底（`handleNoToolCalls` 的 empty-retry + `outputTokenRetry`），故按 medium 落地。若实测主循环长输出频繁走 empty-retry，可再降为 low。
- **一并让 pilot 支持 `mode` 字段** — 超出本提交范围（pilot `thinking` 类型仅 `{ enabled; budgetTokens? }`），只做显式 off 的可区分，弃。

## Consequences

换来：deepseek-v4 主循环恢复推理（不再被全局 default 修复误伤），且可通过 pilot 显式关闭；子代理同样受益；确定性/benchmark 调用方行为不变。付出：`defaultAgentThinking` 按 modelId 字符串匹配（沿用 registry 现有 `/deepseek-v4/` 惯例）；medium 对 v4 映射 `reasoning_effort=high`，长输出仍有 content=0 风险，由主循环既有的 empty-output 重试（token bump）兜底；pilot `enabled:false` 语义由「等同未配置」变为「显式关闭」（非破坏性，此前 deepseek-v4 本就无法通过 pilot 关闭思考）。
