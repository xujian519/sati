# Agent Note: 推理强度不再静默夹取（上游 #587 判据切片）

Status: implemented

## Problem

`src/model/thinking/registry.ts` 的 `clampEffort` 在请求的思考强度不在模型允许集合内时，
按 rank 距离**就近取整**：用户选了 `max`，厂商只支持到 `high`，请求照常发出并成功，
只是强度不是用户选的——没有任何提示。10 处调用点全部走这条路。

把"选了什么"和"实际发了什么"分开，对两类人都坏：用户以为自己的选择生效了（看不到
降级），排查问题时也无从判断（请求层面一切正常）。而强度直接影响成本与延迟。

## Decision

新增 `resolveEffort(mode, allowed)`：命中返回该值，未命中返回 `undefined`；调用方经
`effortField()` 展开成 `{ effort }` 或 `{ unsupportedReason }`。10 处调用点全部改走它。
`unsupportedReason` 由既有出口 `throwIfUnsupportedThinkingPlan` 抛成
`ModelRequestError("unsupported_thinking")`，消息里带上允许集合。

保留的**唯一**映射是 `max → xhigh` 同义别名（厂商把最高档叫 `xhigh` 时）：两者都是
"尽可能强"，属于命名差异而非降级。`clampEffort` 本身删掉（它剩下的行为就是这条别名，
留着是死代码）——别名逻辑连同"别删"的注释搬进 `resolveEffort`。

厂商档位映射（`medium → high`、`xhigh → max`，deepseek/kimi 官方文档给的就是这两条）
保留：那是"用什么值表达用户所选强度"，不是"把用户的选择换成别的强度"。

配套：`unsupported_thinking` 在 `modelErrors.ts` 里补一条可操作指引
（`actions.thinkingStrength`，双 locale），否则新报错会落进讲 base URL/apiKey 的通用兜底。
`canonicalizeModelRequestError` 对所有 `ModelRequestError` 恒置 `retryable: false`，
故该错误不会被自动重试（已核实，无需改动）。

## Alternatives considered

- **引入完整 `model.thinking = { state, efforts, format }` 配置字段（上游原样）** — 落选（本批）：
  需连带改 `model/config/schema.ts`、`parseModelConfig.ts`、`modelCatalog.ts` 与设置面板，
  收益与风险不匹配；本批只取判据改进，配置化留待后续。
- **删除 temperature 参数（上游同一 PR 所为）** — **明确否决**：`src/patent/clarity/` 的
  确定性语义打分依赖 temp 0.1，删除会破坏专利清晰度准入门。
- **同时删掉 GEMINI/QWEN 预算表与 `isReasoningOnlyModel` 白名单** — 落选：这些是真实的
  厂商知识（kimi-k3 固定 1.0、deepseek-v4 静默忽略 temperature），压缩时应迁移而非丢弃。
- **保留静默夹取但加日志** — 落选：用户仍然看到"成功"的降级请求，等于不修。
- **保留 `clampEffort` 函数只删 rank 分支** — 落选：剩下的就是别名，两个函数表达一件事，
  后来者容易只改其中一个；别名逻辑收敛进 `resolveEffort` 一处。
- **同时收紧 UI 的档位下拉（`thinkingModeAvailability.ts`）** — 落选（本批）：那是第三份
  允许集合副本，逐条对齐属于"把三份手写表同步"，正确方向是收敛到模型目录由两侧共读；
  本轮在 `resolveEffort` 的注释里标注了这一点。

## Consequences

- 行为变更（需进发布说明）：以下**先前静默降级**的组合现在直接报
  `unsupported_thinking`，错误消息列出该模型的允许档位供改选——
  - `minimal`：OpenAI gpt-5 系列与 o 系列、Anthropic adaptive 档（opus-4.6+ / sonnet-5 等）、
    deepseek（v4 与旧模型）、kimi-k3；
  - `low`：旧 deepseek-chat / deepseek-reasoner（只到 high/max）；
  - `xhigh` / `max`：plain gpt-5（只到 high）。
  模型调用本身不受影响，且报错发生在请求构造阶段（不消耗 provider 配额、不产生重试）。
- `max → xhigh` 别名与厂商档位映射的回归锚在 `registry.spec.ts`：别名锚、命中透传、
  10 个判定点各一例不支持用例。
- 仍未收敛的重复：允许集合在本文件、UI 的 `thinkingModeAvailability.ts` 各一份，
  两者不一致时表现为"下拉能选、请求报错"。注释里已标注后续方向。
