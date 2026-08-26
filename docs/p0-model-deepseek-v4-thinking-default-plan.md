# P0-模型 修复 DeepSeek v4 在 default 思考模式下长输出 `content` 为 0

> 前提：评测链路已用"显式 `thinking:{mode:"off"}`"workaround（见 `feat(patent)` 提交）。
> 本方案是**全局**模型层修复，独立于评测链路，供单独评审。
> 只做设计，不实施。

---

## 1. 问题

`deepseek-v4-flash / deepseek-v4-pro` 在 Sati 的 **default** 思考模式下，**长分析任务的最终 `content` 为 0**（只返回 `reasoning_content`）。这不只影响评测——任何调用深seek-v4 做长输出的路径（agent 主循环、文书生成等）都可能中招。

## 2. 证据（官方文档 + 直接 API 实验）

DeepSeek 官方文档（`api-docs.deepseek.com`）确认：

- `deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-flash-vision-exp` 是真实模型名。
- 请求参数 `thinking`：`type` 取 `enabled`（**默认**）/ `disabled`；`reasoning_effort` 默认 `high`。
- 响应 `message.reasoning_content`：**"在最终答案之前"的思考内容**；`message.content` 才是最终答案。
- 思考与答案**共享 `max_tokens` 预算**，思考过长会挤掉 `content`。

直接用官方 API 对本仓库的 `patent_exam_2011_a22_02` 长 statement 实验：

| 请求变体 | `content` 长度 | `reasoning_content` 长度 |
|---|---|---|
| 默认（不传 thinking） | **0** | 67K+ 字符 |
| `thinking:{type:"disabled"}` | **5371** | 0 |
| `thinking:{type:"enabled"}, reasoning_effort:"low"` | 3928 | 804 |

结论：**deepseek-v4 官方默认开启思考，长任务思考把 `content` 榨干为 0；显式 `disabled` 即恢复满 `content`。**

## 3. 根因（Sati 模型层）

`src/model/thinking/registry.ts` 的 `resolveThinkingPlan` 在 **default** 模式**提前返回**（`mode === "default"` 分支，L79–85）`{ mode, enabled: false, omitTemperature: true }`——**没有设置 `useOpenAICompatibleThinking` / `thinkingType`**。

`src/model/providers/openai/request.ts` 的请求体只在 `useOpenAICompatibleThinking` 分支写 `body.thinking`，且仅当 `thinkingType` 存在或 `enabled` 为 true 时写 `{type:"enabled"}`（L116–120）——**default 时两者皆无 → 不写 `body.thinking`**。

于是请求体交给 DeepSeek 时**没有任何 `thinking` 字段**，DeepSeek 按**默认 `enabled`** 开启思考 → 长任务 `content` 为 0。

对照：`deepSeekPlan` 的 `off` 分支（L297–307）已正确返回 `{ thinkingType:"disabled", useOpenAICompatibleThinking:true }`，但 default 模式根本没走到那。

## 4. 修复方案（最小、精准）

在 `registry.ts` 的 default 分支，对 `/deepseek-v4/` 模型显式返回"关闭思考"的 plan（复用 off 分支的语义）：

```ts
if (mode === "default") {
  const reasoningOnly = isReasoningOnlyModel(modelId);
  const omitTemperature = reasoningOnly ? { omitTemperature: true } : {};
  // deepseek-v4 官方默认开启思考（thinking 默认 enabled）；不显式传 `thinking:{type:"disabled"}`，
  // 长输出会把最终 content 榨干为 0。default（未显式请求思考）应显式关闭，而非交给模型默认。
  if (/deepseek-v4/.test(modelId)) {
    return { mode, enabled: false, thinkingType: "disabled", useOpenAICompatibleThinking: true, ...omitTemperature };
  }
  return { mode, enabled: false, ...omitTemperature };
}
```

效果：`deepseek-v4-flash/pro` 的 default 调用 → request.ts 命中 `useOpenAICompatibleThinking` 分支 → `body.thinking = { type: "disabled" }` → DeepSeek 关闭思考 → `content` 满。

**不涉及** `deepseek-reasoner`（`/deepseek-v4/` 不匹配它，它 always-thinking 也不支持关）与 kimi（另见限制）。

## 5. 验证

1. **单元**：新增 `tests/model/thinking/` 用例——`resolveThinkingPlan({} , deepseekProvider, deepseekV4FlashModel)` 应返回 `useOpenAICompatibleThinking:true + thinkingType:"disabled"`；`buildOpenAIRequest` 对应请求体含 `body.thinking={type:"disabled"}`；`deepseek-reasoner` 保持原样（不传 thinking）。
2. **真实冒烟**：用 `runtime.complete({model:"deepseek-v4-flash", ...})`（不传 thinking，default）对本仓库长 statement 调用，断言 `content` 非空且 > 3000 字符。
3. **回归**：跑 `pnpm typecheck && pnpm lint && pnpm test`；重点看依赖 default 行为的路径（agent 主循环、session-title、tool 调用）不回归——这些路径此前在 deepseek-v4 上长输出本就 `content` 空，修复后应**改善**而非破坏。

## 6. 风险与影响面

| 风险 | 说明与缓解 |
|---|---|
| 改变所有 deepseek-v4 default 调用行为 | 从"思考但可能 content 空"变为"不思考、content 满"。这修的是 bug；若某调用方**确实需要**思考，应显式 `thinking:{mode:"high"}`（default 不再隐含思考）。 |
| agent 主循环可能依赖思考来提升回复质量 | 需评估：主循环对 deepseek-v4 若依赖思考，应在其请求显式开启；否则默认不思考反而更稳（不再有 content 空）。建议在主循环对 deepseek-v4 显式 `thinking:{mode:"medium"}`。 |
| `deepseek-reasoner`/kimi 不受益 | kimi-k2.7-code/k3 官方不支持关思考，长任务 `content` 仍可能空（模型限制），无法以此修复；如需可切换 kimi-k2.6 或接受。 |
| 影响面 | 仅 deepseek-v4 系列（`/deepseek-v4/`），其它 provider/model 路径不变。 |

## 7. Alternatives considered

- **只修评测链路（现状）** — 能解评测，但其它 deepseek-v4 长输出路径仍 `content` 空，全局问题未解，弃（作为过渡保留）。
- **在 request.ts 的 `useOpenAICompatibleThinking` 分支加 `else { body.thinking={type:"disabled"}}`** — 只对已设 `useOpenAICompatibleThinking:true` 的 plan 生效；default 分支没设该标志，**不命中**，对 deepseek-v4 default 无效，弃。
- **default 走 `deepSeekPlan`**（去掉 early-return，让 default 进入 provider plan）— deepSeekPlan 对 `default` 会走到 `clampEffort` 返回 `{enabled:true, thinkingType:"enabled", effort:"low"}` → 变成"开启低 effort 思考"，改变 default 语义（default 应=不额外开思考），且思考仍可能挤 content，弃。
- **一并关 kimi** — k2.7-code/k3 官方不支持关闭思考，无法传 `disabled`（会报错/无效），弃；kimi 问题单独处理。
- **在配置层（provider 默认 effort）改** — 把 deepseek-v4 模型 catalog 的能力/默认改成特定值，治标不治本，且会隐晦地影响能力解析，弃。
