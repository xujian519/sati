# Agent Note: 模型窗口覆盖层（探测与实测事实参与解析）

Status: implemented

## Problem

`parseCapabilities`（`src/model/config/parseModelConfig.ts`）的窗口解析只有三层：config 声明 > catalog 条目 > **协议默认**。第三层是兜底：用户填一个中转站模型名、刚发布的新模型或自建服务（catalog 未命中、又没写 `capabilities`）时，openai 协议一律按 **128000** 计。这个数不只是设置页的显示问题——它是自动压缩阈值（`warningRatio` 0.8 / `blockingRatio` 0.95）的分母：真实窗口 262k 的模型会在约 102k 就触发压缩，真实 128k 的模型又被"看起来还有很多余量"耽误。

#454/#455 解决的是**可见性**（设置页显示生效值与其来源 `config | catalog | default`，并加了目录镜像门禁）。本 note 解决的是**取值**：让引擎有机会拿到比"协议默认"更真的事实。

两类事实此前都在代码里出现过，只是没被持久化、也没进解析：

- **探测**：provider 的 `/models` 端点有时会带回真实窗口（OpenRouter `context_length`、Google `inputTokenLimit`、Anthropic `max_input_tokens`、Ollama `details.context_length`、llama.cpp `meta.n_ctx_train`）。`ui/server/routes/config.js` 的探测只取 `{id, displayName}`，窗口字段被丢掉。
- **实测**：`ContextOverflowRecovery` 会从 provider 的超限报文里解析出真实上限（`reason: "provider-context-cap"`），`modelErrorRecovery` 把它写进 `TokenCapManager` 的**进程内** Map（跨 turn 存活、跨进程与配置重载丢失）。

## Decision

新增 `src/model/window/`，做一条覆盖层：

| 模块 | 职责 |
|---|---|
| `extract.ts` | 从 `/models` 响应抽窗口：明确键表（不做模糊匹配）、只下探具名容器（`details`/`meta`/`model_info`/`top_provider`）的顶层键、每个数值过区间校验（1k–16M）、**拿不到就不产出条目** |
| `store.ts` | `~/.sati/model-windows.json`：同步读（解析期要用）、原子写、fail-open（缺失/损坏/版本未知 → 空表）、同 key 冲突**取小** |
| `probe.ts` | 按需探测执行器（端点候选回退、按协议构造鉴权头、失败静默），`source: probe` 写回 |
| `types.ts` | 条目类型、区间常量、`modelWindowKey` |

**解析优先级：config 显式声明 > 覆盖层（observed / probe）> catalog > 协议默认。**

四条设计判断：

1. **冲突取小，且来源跟随被采纳值。** `observed` 通常比 `probe` 可信（实测 vs 声明），但两者都可能偏大或偏小。取小是保守方向：宁可让压缩早触发，也不要因高估窗口把失败推迟到真实超限点。`source` 只在"该值真的被采纳"时标注为 `observed`——把 probe 的声明值冒充成实测会让设置页对用户说谎。
2. **信任边界落在语义而非数据形状。** 回写只在 `reactive.reason === "provider-context-cap"` 时发生，而不是"`maxContextTokens` 存在"。截头重试、输出上限钳制等分支的数值不是上下文窗口，一旦持久化会把压缩线**永久**钉在错值上（覆盖层是有磁盘副作用的）。
3. **解析期零 IO。** `parseModelConfig` 保持同步纯函数：覆盖层由调用方（`loadPilotConfig`）一次读入后按值传入（`windowOverrides`）。未提供或空表 ⇒ 等价于未启用该层，行为与改动前逐字相同（既有 `parseModelConfig` / `protocol-defaults-parity` 用例原样通过）。
4. **探测不在配置加载路径上自动发起。** 按需调用（设置页入口在后续批次）。理由是 ollama 预热的前车之鉴：后台网络副作用会让 config reload 摆动（`diffConfigSnapshots` 每次判定变化 → 每 turn 重建 runtime），而"拿不到窗口"本就是常态（标准 OpenAI 形状、xAI、未扩展的中转站与自建服务都不返回窗口）。

## Alternatives considered

- **把 openai 协议默认从 128k 调到 200k/256k**（issue #449 期望方案 2 前半）— 落选：128k 是当前主流 openai 兼容模型的真实窗口（GPT-4o、DeepSeek 等），调大会把这些模型的压缩线从 ~102k 推到 ~160k，把失败推迟到真实超限点；而跨进程兜底只有瞬态降级。这正是 `2026-09-18-settings-effective-window.md` 已记录过的否决，本 note 不改判。
- **只在 UI 显示"窗口未知"** — 落选：不解决误判，只解决困惑；#454 已经做到这一步了。
- **强制用户在 onboarding 填窗口** — 落选（本轮）：摩擦大，且不解决"用户不知道自己该填多少"。改为"能探测就探测、探不到再提示确认"（构件④，后续批次）。
- **把探测结果写回 `sati.yaml`（`capabilities.maxContextTokens`）** — 落选：`src/` 内没有 sati.yaml 写通道（`PilotConfigStore` 只读，写入在 `ui/server` 与 `cli/commands/configSet` 两侧），且探测结果是**运行时事实**而非用户配置，混写后"用户改了什么"不可辨认。覆盖层单开文件可随时清除。
- **在配置加载时自动对每个 provider 打一次 `/models`** — 落选（默认关）：见决策 4。若要自动，应作为显式开关 + TTL，而不是默认行为。
- **只读顶层 key（不下探嵌套容器）** — 落选：Ollama 的 `details.context_length`、llama.cpp 的 `meta.n_ctx_train` 都在嵌套层里，放弃它们会丢掉两个协议的探测能力。折中是**具名容器白名单**，不递归。
- **把 `max_tokens` 一并当作上下文窗口** — 落选：它在 OpenAI 兼容响应里通常表示输出配额（Anthropic 的 `/v1/models` 同义），误读会让窗口被永久低估。它只作为输出上限的**末位**候选。
- **用 `readFileSync` 之外的异步读取 + 缓存层** — 落选：`parseModelConfig` 是同步解析，覆盖层必须同步可得；缓存复杂度换不来收益（文件极小、读发生在配置加载期）。

## Consequences

- catalog 未命中的模型，只要 provider 的 `/models` 返回窗口（或曾经真实超限过），压缩阈值就按真实窗口计算；`observed` 值跨会话与进程重启存活。
- 默认路径**零行为变更**：没有覆盖层文件时，解析结果与改动前逐字相同（用例锁定）。
- 覆盖层是有磁盘副作用的持久事实：写入判据必须严（构件②已按语义收紧），并提供清除入口（设置页"清除探测值"，后续批次）。
- 探测覆盖不完整是**已知边界**：拿不到窗口的 provider 只能靠实测（超限一次）或用户确认，不可能"首次显示即准确"（除非把 `parseModelConfig` 异步化，代价过大）。
- 代价：多一处持久化文件（`~/.sati/model-windows.json`）与一个跨层依赖（`src/model/config` → `src/model/window`，后者不反向依赖，无环）。
