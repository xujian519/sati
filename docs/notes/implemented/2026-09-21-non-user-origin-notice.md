# Agent Note: 非用户来源文本的护栏（模型分不清「谁在说话」）

Status: implemented

## Problem

模型的消息序列只有 `user` / `assistant` 两种角色（`CanonicalRole`），没有第三档来表达
「这条是以用户身份注入的、但不是用户」。Sati 有多条这样的注入路径——钩子上下文、
渠道提示、团队成员唤醒、定时任务与常驻任务——它们一律以 `user` 角色进入请求，正文里
没有任何一句声明「这不是用户本人」。

在默认 `skipPermissions: true` 下这个缺口是有后果的：工具审批的最终形态是「用户批准」，
而模型能看到的唯一批准证据就是消息文本。一段被读成「用户已批准」的注入文本会直接变成
放行；团队成员会话更极端——它恒定 `canPrompt: false`，被误读为已获授权时没有第二次
纠正机会（权限提示根本不会出现）。团队成员的 followup 又恰恰由**另一个智能体**撰写
（调度器的任务分派、队长或对等成员的消息），即"同侪能给你授权"这种最容易被模型接受的
误读。

代码里已有同类技术的先例可循：压缩控制块用 `<internal-compaction-control ... synthetic="true">`
加固定说明，并要求「只有块外的原始用户文本才算用户意图」。本次把同一做法推广到其余
注入路径。

## Decision

新增 `src/context/prompt/nonUserOriginNotice.ts`：一个抬头常量
`[SYSTEM NOTIFICATION - NOT USER INPUT]`、一段两句话的固定说明（否掉「这是用户输入」、
否掉「这是授权」），以及幂等的包装函数 `withNonUserOriginNotice`。

接线三处（都是「非人力实时输入成为 user 角色消息」的收口点，而非逐调用方散点）：

| 注入路径 | 收口点 | 形态 |
|---|---|---|
| 钩子 `additional_context` | `src/lifecycle/runtime/LifecycleRuntime.ts` | 护栏放在 `<hook_context>` **标签内** |
| 渠道合成消息 | `src/gateway/client/InProcessGateway.ts` 的 `syntheticMessages` 映射 | 护栏包裹整条文本 |
| 团队成员唤醒 | `src/agent/team/member/member-waker.ts` | 护栏包裹 followup（所有唤醒路径共用此函数） |

**只加文本，不动 `metadata.synthetic`**：Web 投影过滤（`readSessionMessages`）与压缩锚点
判定（`isRealUserRequestMessage`）都依赖该标记，改了会连带破坏两条无关机制。

钩子路径的护栏必须放在标签**内**：压缩锚点按文本前缀排除内部消息
（`INTERNAL_USER_TEXT_PREFIXES` 含 `<hook_context`），抬头若压到最前面，这条消息会
退化成「真实用户请求」并被压缩保留为锚点——护栏本身会造成一个上下文管理回归。

## Alternatives considered

- **给消息加 `metadata.origin: "system" | "peer" | "user"` 并让渲染层翻译** — 落选：
  模型看不到 metadata。安全声明必须出现在模型读到的正文里，否则它只是给人和工具看的
  记账，起不到作用。
- **新增第三角色（`role: "system"` 消息）承载这些注入** — 落选：`CanonicalRole` 只有
  user/assistant，加角色要同时改 4 个 provider adapter、请求重建对拍、重放键投影与
  token 估算，代价远大于一条前缀；且 provider 对「对话中段的 system 消息」支持不一。
- **在 `decide()` / 权限层拦截「模型误以为已批准」** — 落选：权限层只能看到工具调用，
  看不到模型为何认为获批。这类错误只能从注入侧预防。
- **逐个调用方添加（`CronFire`、`assignmentPrompt`、`fallbackMailboxPrompt`、WeCom…）** —
  落选：调用方会新增，收口点不会；`wakeMember` 与 `syntheticMessages` 是既有漏斗，
  在此处加护栏可继承给未来所有渠道与唤醒来源。
- **把护栏也加到定时任务的 `task.message`** — 落选：那段文本是用户自己预先设定的指令，
  冠以「不是用户输入」会诱导模型放弃执行；且定时回合本身跑在 `bypassPermissions` 下，
  不存在「骗取批准」的攻击面。此处无收益，只增加误读风险。
- **针对「跨会话/外部引用内容」再加一条护栏** — 未做：Sati 当前没有任何会话引用
  （`#sess_` 式）入口，没有注入点。等该能力出现时再补，不预设机制。

## Consequences

- 三条注入路径的模型可见文本都多了两行固定抬头。代价是每个请求多几十个 token 与
  一点注意力稀释；收益是「谁在说话」有了模型可读的判据。
- 护栏是**提示词级**约束，不是强制层。它与 `alwaysAsk`（工具级硬门）分工明确：后者
  防的是自动放行路径，前者防的是模型自己误判语义。两者都不替代项目级 hook 信任门。
- 团队成员的 followup 文本被改写（护栏在前、原文在后），因此成员转录里看到的消息不再是
  调度器原文——排查成员行为时需知道有这一层。为此 `withNonUserOriginNotice` 幂等，
  同一文本经两层注入点不会叠成两段抬头。
- `tests/context/user-request-anchor.spec.ts` 那条「护栏抬头压最前面会在缺 metadata 时
  失守」的用例，把钩子路径为何必须标签内置写成了可执行的证据，而不是注释里的告诫。
