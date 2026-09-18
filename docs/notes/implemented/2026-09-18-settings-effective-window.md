# Agent Note: 设置页显示生效上下文窗口与其来源

Status: implemented

## Problem

模型在 `sati.yaml` 里声明了、但没有写 `capabilities`，且内置 catalog 也没有这个模型时（换中转站、刚发布的新模型、自建服务都会落到这一支），引擎按**协议默认**取窗口：openai / openai-responses 128k、anthropic 200k、google 1M（`src/model/config/parseModelConfig.ts` 的 `parseCapabilities`）。

设置页却在同一位置硬编码了另一个数：`AgentsSection.tsx` 的 `placeholder={String(caps.catalogModel?.maxContextTokens ?? 200000)}`。于是出现「输入框提示 200k、后端实际生效 128k」——用户从界面上看不出差异，只能从"还没对话就显示用了四分之一窗口"这类现象倒推。输出上限那一行同样不一致（`?? 16384`，而协议默认是 32768）。

UI 不能 import `src/`（边界规则），但它自己那份 `ui/src/shared/catalogProviders.ts` 已经带每个 provider 的 `protocol`，所以"生效窗口 + 来源"可以在 UI 端算出同口径的值。

动手时按同一判据核了那份 UI catalog，发现它**不只是没有门禁，数值本身就是错的**：两边都有的 66 个模型里 19 处不一致（`openai/gpt-4.1` 窗口 UI 1047576 / 引擎 1050000、输出上限 UI 32768 / 引擎 131072；`anthropic/claude-sonnet-4.6` 窗口 UI 200000 / 引擎 1000000 等），另外 `openrouter` 下 4 个模型 UI 声明了窗口，而引擎的 `openrouter` 与 `ollama` 一样是空目录（留给运行时探测）——后端对这 4 个模型取协议默认 128k，UI 却显示 200k 到 1M。也就是说"提示值与生效值不一致"在这层同样成立，只是命中的是**目录已命中的模型**。

## Decision

**只做同源与可见，不动兜底数值。**

- 新增 `ui/src/shared/modelProtocolDefaults.json`：协议默认窗口与输出上限的 UI 侧镜像（4 个协议 + 输出上限）。`src/model/config/parseModelConfig.ts` 里协议 → 常量的映射本身是解析逻辑（`openai-responses` 复用 openai），所以要有东西盯着它。
- 新增 `tests/model/protocol-defaults-parity.spec.ts`：拿引擎**真实解析**的结果（`parseModelConfig` 解析一个只声明协议、不声明 capabilities 的 provider）与镜像逐协议对拍。镜像漂移、或协议 → 常量的映射变了而镜像没跟，都会红。手工验证过它确实会失败（把 openai 改成 200000 → 1 fail）。
- `activeModelCapabilities` 增补解析结果：`protocol`（provider 声明 → catalog provider → openai）、`maxContextTokensOverride`、以及 `effectiveContext` / `effectiveOutput`（`{ tokens, source }`，source ∈ `config | catalog | default`，顺序即引擎的顺序：模型声明 > catalog 条目 > 协议默认）。
- `AgentsSection` 的两个 `placeholder` 改成读 `effectiveContext` / `effectiveOutput`，并在两段说明文案后追加一行生效值与其来源（"生效值：128,000（来自协议默认）"）。上下文那一行在 `agent.maxContextTokens` 已填时显示该值 + `config`。

`source` 的三值沿用引擎 `ModelInfoSource` 的 `config | catalog | default` 词汇，UI 只做标签翻译。

**UI catalog 与引擎对齐**（同一判据的第二刀）：

- 把那 19 处数值改成引擎值——引擎才是 parse 期生效的那份，UI 镜像没有运行时作用，所以只能 UI 向引擎对齐。
- `openrouter` 那 4 个模型去掉窗口声明，只保留为可选项：引擎目录没有它们，后端会走协议默认，声明数值就是给用户看不生效的数字。要恢复数值，正确做法是把模型补进**引擎**目录，而不是在 UI 侧单独声明。
- 新增 `scripts/check-catalog-mirror.mjs` 门禁（挂 `pnpm lint` 的 `check:catalog-mirror`）：共用模型的三项数值必须等于引擎值、引擎没有的模型不得声明数值、provider 的 protocol 必须一致、UI 列的 provider 必须在引擎目录里存在。用 TS 编译器 API 求值两份字面量（引擎侧有 `{ ...OPENAI_SHARED_MODELS }` spread），遇到任何非字面量形态一律抛错而不是跳过。负控制验证过两类违规都会红。
- `defaultUrl` **不在门禁范围内**：当前 `minimax` 两边不一致（UI 预填 `api.minimaxi.com` / 引擎默认 `api.minimax.io`，后者是配置未写 url 时的实际默认），但哪个域名正确是产品判断，本轮保持现状、记为待定项。

## Alternatives considered

- **把 `openrouter` 那 4 个模型补进引擎目录（用 UI 现有数值）** — 落选：会让窗口真正生效、用户受益，但等于把四个外部模型的窗口数值升格为引擎 catalog 的生效事实，而这些数值只在 UI 侧被curated过、没有独立核实（OpenRouter 模型列表本身就是动态的，引擎与 `ollama` 一致选择了空目录 + 运行时探测）。本轮只承诺"UI 不说谎"，不承诺"把未核实的数值变成生效值"。
- **把 UI catalog 的数据搬进 JSON、或由引擎生成整份文件** — 落选：前者要动 400 行数据（本 PR 的焦点是提示值来源，不是数据结构）；后者更狠——生成式会顺带把引擎有而 UI 未列的 19 个模型塞进选择器（属功能变更），且 UI 独有的 `modelListUrl` / `requiresApiKey` 仍需手工维护。用一把只读门禁拦住漂移，代价最小。

- **把协议默认窗口也做成"单一事实源"（引擎 import 同一份 JSON）** — 落选：`tsc` 不产出 JSON，根配置加 `resolveJsonModule` 后还要把 JSON 复制进 `dist`（改构建产物面）；UI 再 import `src/` 下的文件又违反边界规则。镜像 + 对拍测试付出一个小测试文件的代价，就拿到了等价的防漂移能力。
- **顺带把 openai 协议默认从 128k 提到 200k**（issue #449 的期望方案 2 前半） — 落选（本轮单独决策）：128k 是当前主流 openai 兼容模型的真实窗口（GPT-4o、DeepSeek 等），调大会让这些模型的压缩线推后、把失败推迟到真实的超限点；超限时 `modelErrorRecovery` 只能用**瞬态**降级（`setTransientTokenCap`）在同一回合内压缩重试兜住，不持久修正。收益（百分比好看）与代价（真实 128k 模型多一次失败请求 + 一次非预期强制压缩）不成比例。
- **兜底时不显示数值，改为一律要求用户确认窗口**（期望方案 1） — 落选（本轮）：正确但要改 onboarding 流程、增加摩擦，且不解决"用户看不出当前值来自哪一层"的可观测性问题；先让现状可见，再谈是否强制。
- **顺带把工具栏/聊天气泡里显示的生效窗口也改成读同一解析** — 落选：气泡上的数字来自网关 `context_budget` 快照（后端实测口径），本来就是真值，不需要 UI 再算一遍。
- **配一把 `gen:` 生成器把镜像写成 `ui/src/shared/*.generated.ts`（照 `gen-event-matrix` 的模式）** — 落选：3 个协议的数字用"生成 + --check"门槛过重；测试对拍用的是引擎真实解析（比生成器的常量直出更强），成本更低。

## Consequences

- 设置页不再说谎：输入框提示值、说明文案里的生效值、后端实际生效值三者同口径、同来源标注。用户在 catalog 未命中时能直接看到"128,000（来自协议默认）"，从而知道该自己填。
- **没有降低固定开销，也没有提高任何模型的可用窗口**——协议默认仍是 128k/200k/1M。25% 那个观感问题里，分母这一半保持不变，只变得可解释、可自行修正。
- 代价一：多一处镜像。防漂移由 `tests/model/protocol-defaults-parity.spec.ts` 承担（挂 `pnpm test`，不是 `pnpm check`——它是 node test，跟其余后端 spec 一起跑）。
- 代价二：`ui/src/shared/catalogProviders.ts` 仍是手工镜像（不是生成物），但数值漂移现在由 `pnpm check:catalog-mirror` 拦住。`defaultUrl` 与 `modelListUrl` / `requiresApiKey` 刻意不在门禁内（前者是待定的产品判断，后者是 UI 独有的探测配置）。
- 设置页对**目录已命中的模型**也不再显示错的窗口：那 19 处修正会改变这些模型在输入框里的提示数值（例如 `gpt-4.1` 从 1,047,576 变 1,050,000）。这是把提示对齐到实际生效值的必然结果，不是行为变更——后端一直用的是引擎值。
- 引擎有而 UI 未列的 19 个模型（`gpt-5.5`、`claude-opus-4.8-*`、`gemini-3.6-flash` 等）仍不在选择器里：这是选择器覆盖面的缺口，不是数值不一致，本轮未动。
- 输出上限那一行的硬编码 `16384` 一并修正为协议默认（32768）：同一处缺陷、同一行代码，留一半不改会让"提示值不可信"的判断重新成立。
