# Agent Note: 子代理复核预算、部分结果与窗口来源可信度

Status: implemented

## Problem

专利撰写任务的复核阶段会卡住很久甚至无结果，根因有四层：

1. **窗口被低估**：自定义模型（如 `deepseek/deepseek-flash`）不在 catalog，能力解析落到 OpenAI 协议默认 128k；这段兜底假设被写进子代理配置，`TokenCapManager` 当事实使用。真实模型通常有 1M 窗口，子代理却在 128k 内反复压缩，固定开销（system/tools/知识卡）已占大半。
2. **复核角色未真正受限**：父 agent 用 `subagent_type: "general-purpose"`，只把 `patent-reviewer` / `adversarial-reviewer` 写在 prompt 里。子代理拿到的是通用代理的写权限与完整工具面，只读约束、工具域裁剪、输出契约全部失效。
3. **复核没有预算**：复核子代理可以无限轮、无限工具调用地反复检索，父代理只能等。
4. **超时丢弃已产出内容**：`toolContext.fork` 在超时后抛错，已跑出的报告被丢弃，父代理重试并进一步放大上下文。

## Decision

- **窗口来源可追溯**：`ModelDefinition.tokenLimitSources` 逐字段记录 `config | window | catalog | protocol-default`。`parseModelConfig` 在 catalog 未命中时标 `protocol-default`，窗口覆盖层标 `window`，配置显式声明标 `config`。
- **只继承"假设"**：`resolveSubagentTokenLimits` 仅在子代理来源为 `protocol-default`、与父级同 provider、且父级已知窗口更大时，继承父级 `maxContextTokens`（输出上限同理）。catalog/config/window 的事实值不被父级覆盖；跨 provider 不继承。`agentSessionConfig` 在组装子代理上限时调用该解析。
- **复核预算直达 fork**：`agent` 工具新增 `max_turns` / `max_tool_calls` / `timeout_ms`；`SubAgentSession` 在 `tool_calls_detected`（执行前）累计工具调用，超预算批次不执行并通过组合 AbortSignal 收尾。
- **部分结果回流**：`SubagentReport` 增加 `stopReason` / `partial` / `toolCalls`。超时不再抛错丢弃报告；工具结果与事件（`subagent_completed`）显式标注 `partial` 与停止原因，模型可见文本追加 `[partial: ...]` 提示。
- **角色不得冒充**：`general-purpose` 的 directive 若以委派语句指定了已注册的只读角色（如"你是 adversarial-reviewer"），工具直接报 `invalid_tool_input`（`errorCode: subagent_role_mismatch`）并提示改用真实 `subagent_type`。仅提及角色名（如"参照 patent-reviewer 的清单"）不触发。
- **技能层纪律**：`patent-agent` / `patent-team-composition` / `patent-reviewer` / `adversarial-reviewer` 明确要求复核用真实 `subagent_type`，并建议 `max_turns` 8–16、`max_tool_calls` 24–40；`partial: true` 只能当临时意见。

## Alternatives considered

- **把 OpenAI 协议默认窗口从 128k 提到 1M** — 会让真实 128k 模型被高估，压缩永远不触发，最终在 provider 侧硬失败（#449 已否决）。协议默认必须保持保守，靠探测/实测/覆盖层提升。
- **无条件继承父级窗口** — 子代理模型可能与父级能力不同（尤其跨 provider 或低配模型），无条件继承会把"不知道"变成"更大假设"。
- **新增每子代理 `contextBudgetTokens` 配置** — 当前窗口解析修复 + 轮数/工具预算已覆盖卡死形态；再增加预算维度会让配置面与解释成本上升，暂不引入。
- **对所有 `general-purpose` 复核 prompt 一律拒绝** — 误伤合法的通用检索/综合任务；只匹配角色委派语句，保留"提及角色名"的正常用法。
- **超时继续抛错、由父代理重试** — 重试会重复消耗上下文与时间，且已产出的半成品完全丢失；部分结果 + 显式标记更符合"降级但不静默"。

## Consequences

- 同 provider 的自定义模型在"只有协议默认"时获得父级 1M 窗口；catalog/config/window 事实值保持不变。跨 provider 子代理仍是 128k 兜底，需要窗口覆盖层或探测来提升。
- 预算中止的批次不执行，`toolCalls` 计数包含被拒批次（用于解释为何停）。
- `agent` 工具 inputSchema 变更已重录 llm-replay fixture；`AgentEvent.subagent_completed` 扩展字段已重生成事件矩阵。
- 冒充守卫只覆盖"只读角色 + 委派语句"；`general-purpose` + 只写角色名的其他形态仍依赖技能层纪律。
