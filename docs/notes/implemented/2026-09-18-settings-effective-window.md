# Agent Note: 设置页显示生效上下文窗口与其来源

Status: implemented

## Problem

模型在 `sati.yaml` 里声明了、但没有写 `capabilities`，且内置 catalog 也没有这个模型时（换中转站、刚发布的新模型、自建服务都会落到这一支），引擎按**协议默认**取窗口：openai / openai-responses 128k、anthropic 200k、google 1M（`src/model/config/parseModelConfig.ts` 的 `parseCapabilities`）。

设置页却在同一位置硬编码了另一个数：`AgentsSection.tsx` 的 `placeholder={String(caps.catalogModel?.maxContextTokens ?? 200000)}`。于是出现「输入框提示 200k、后端实际生效 128k」——用户从界面上看不出差异，只能从"还没对话就显示用了四分之一窗口"这类现象倒推。输出上限那一行同样不一致（`?? 16384`，而协议默认是 32768）。

UI 不能 import `src/`（边界规则），但它自己那份 `ui/src/shared/catalogProviders.ts` 已经带每个 provider 的 `protocol`，所以"生效窗口 + 来源"可以在 UI 端算出同口径的值。

## Decision

**只做同源与可见，不动兜底数值。**

- 新增 `ui/src/shared/modelProtocolDefaults.json`：协议默认窗口与输出上限的 UI 侧镜像（4 个协议 + 输出上限）。`src/model/config/parseModelConfig.ts` 里协议 → 常量的映射本身是解析逻辑（`openai-responses` 复用 openai），所以要有东西盯着它。
- 新增 `tests/model/protocol-defaults-parity.spec.ts`：拿引擎**真实解析**的结果（`parseModelConfig` 解析一个只声明协议、不声明 capabilities 的 provider）与镜像逐协议对拍。镜像漂移、或协议 → 常量的映射变了而镜像没跟，都会红。手工验证过它确实会失败（把 openai 改成 200000 → 1 fail）。
- `activeModelCapabilities` 增补解析结果：`protocol`（provider 声明 → catalog provider → openai）、`maxContextTokensOverride`、以及 `effectiveContext` / `effectiveOutput`（`{ tokens, source }`，source ∈ `config | catalog | default`，顺序即引擎的顺序：模型声明 > catalog 条目 > 协议默认）。
- `AgentsSection` 的两个 `placeholder` 改成读 `effectiveContext` / `effectiveOutput`，并在两段说明文案后追加一行生效值与其来源（"生效值：128,000（来自协议默认）"）。上下文那一行在 `agent.maxContextTokens` 已填时显示该值 + `config`。

`source` 的三值沿用引擎 `ModelInfoSource` 的 `config | catalog | default` 词汇，UI 只做标签翻译。

## Alternatives considered

- **把协议默认窗口也做成"单一事实源"（引擎 import 同一份 JSON）** — 落选：`tsc` 不产出 JSON，根配置加 `resolveJsonModule` 后还要把 JSON 复制进 `dist`（改构建产物面）；UI 再 import `src/` 下的文件又违反边界规则。镜像 + 对拍测试付出一个小测试文件的代价，就拿到了等价的防漂移能力。
- **顺带把 openai 协议默认从 128k 提到 200k**（issue #449 的期望方案 2 前半） — 落选（本轮单独决策）：128k 是当前主流 openai 兼容模型的真实窗口（GPT-4o、DeepSeek 等），调大会让这些模型的压缩线推后、把失败推迟到真实的超限点；超限时 `modelErrorRecovery` 只能用**瞬态**降级（`setTransientTokenCap`）在同一回合内压缩重试兜住，不持久修正。收益（百分比好看）与代价（真实 128k 模型多一次失败请求 + 一次非预期强制压缩）不成比例。
- **兜底时不显示数值，改为一律要求用户确认窗口**（期望方案 1） — 落选（本轮）：正确但要改 onboarding 流程、增加摩擦，且不解决"用户看不出当前值来自哪一层"的可观测性问题；先让现状可见，再谈是否强制。
- **顺带把工具栏/聊天气泡里显示的生效窗口也改成读同一解析** — 落选：气泡上的数字来自网关 `context_budget` 快照（后端实测口径），本来就是真值，不需要 UI 再算一遍。
- **配一把 `gen:` 生成器把镜像写成 `ui/src/shared/*.generated.ts`（照 `gen-event-matrix` 的模式）** — 落选：3 个协议的数字用"生成 + --check"门槛过重；测试对拍用的是引擎真实解析（比生成器的常量直出更强），成本更低。

## Consequences

- 设置页不再说谎：输入框提示值、说明文案里的生效值、后端实际生效值三者同口径、同来源标注。用户在 catalog 未命中时能直接看到"128,000（来自协议默认）"，从而知道该自己填。
- **没有降低固定开销，也没有提高任何模型的可用窗口**——协议默认仍是 128k/200k/1M。25% 那个观感问题里，分母这一半保持不变，只变得可解释、可自行修正。
- 代价一：多一处镜像。防漂移由 `tests/model/protocol-defaults-parity.spec.ts` 承担（挂 `pnpm test`，不是 `pnpm check`——它是 node test，跟其余后端 spec 一起跑）。
- 代价二：`ui/src/shared/catalogProviders.ts` 那份 catalog 仍然是手工镜像（无门禁），本轮只给协议默认加了门禁；catalog 逐模型的数值漂移仍要靠人工同步。
- 输出上限那一行的硬编码 `16384` 一并修正为协议默认（32768）：同一处缺陷、同一行代码，留一半不改会让"提示值不可信"的判断重新成立。
