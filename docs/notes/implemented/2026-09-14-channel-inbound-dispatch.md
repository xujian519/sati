# Agent Note: 渠道入站分派前置共享化（dispatch）

Status: implemented

## Problem

上一刀（`docs/notes/implemented/2026-09-14-channel-turn-processor.md`）抽走了单轮处理循环；剩下的**分派前置**仍是各渠道的手抄件——13 个渠道逐字重复同一段 33 行控制流：

```
elicitation 挂起 → 应答并投递确认（return）
permission 挂起 → 应答并投递确认（return）
activeChats 命中 → 记 info 日志并丢弃（return）
resolveIncomingMessage（/new 回执、命令解析、吞空正文）→ handled 则返回
activeChats.add → try { 轮次 } finally { activeChats.delete }
```

这与 `TD-ADAPTERS-N01` 登记的「dispatch + submitTurn 处理循环脚手架重复」对应；上一刀只做完了后半句，本刀完成后半句的反面。

归一化对比（占位符化挂起键、应答文本、投递目标、`sendCtx` 定义）后，13 处共享段的差异**只有 4 项且都可参数化**：

| 渠道 | 挂起/去重键 | 应答文本 | 确认与命令回执目标 | 轮次首参 |
|---|---|---|---|---|
| bluebubbles | `chatGuid` | `text` | `chatGuid` | `chatGuid` |
| discord / dingtalk / email / homeassistant / slack / sms / telegram | `chatId` | `text`（telegram 为 `msg.text`） | `chatId`（slack 为 `{channelId, threadTs}`） | 同左 |
| matrix | `roomId` | `text` | `roomId` | `roomId` |
| signal | `sessionChatId` | `text` | `sessionChatId` | `sessionChatId` |
| whatsapp | `msg.chatId` | `msg.text` | `msg.chatId` | `msg.chatId` |
| mattermost | `chatId` | `text` | `{channelId, rootId}` | `{channelId, rootId}` |
| wecom-callback | `chatId` | `text` | `chatId` | `chatId` |

另有一处**表面差异经核验为无操作**：dingtalk 调 `.answer(key, text.trim(), …)`，而 `ImElicitationHelper.answer` / `ImPermissionHelper.answer` 内部第一件事就是 `text.trim()`（`ImElicitationHelper.ts:69`、`ImPermissionHelper.ts:38`），故调用点 trim 是冗余；统一传原文不改变行为。

## Decision

1. **新增 `src/adapters/channel/protocol/ImInboundDispatch.ts`**：导出 `dispatchChannelMessage(deps, input)`，把上述 33 行收拢为一处。语义细节原样保留：挂起分支在应答失败时只记日志并 `return`（不抛、不继续走轮次）；交互守卫是 `hasPending(key) && gateway` 的短路（无 gateway 时不消费该消息而是继续走解析与轮次）；`activeChats` 的 `add` 在命令解析之后、`delete` 在 `finally`。
2. **一个投递 sink 而非两个**：确认回执与 `resolveIncomingMessage` 的命令回执在 13 个渠道里**目标是同一个**（11 个是 `sendReply(key, …)`，slack/mattermost 是 `sendReply(sendCtx, …)` 并丢弃 helper 回传的 chatId），所以 deps 只暴露 `send(interactionKey, text)`。这比上一刀预留的「命令回执 sink + 轮次投递 sink」两套更简单，且与既有的 `(_id, t) => this.sendReply(sendCtx, t)` 判例一致。
3. **`turn` 是回调而非 deps 内联**：`ImInboundDispatch` 不依赖 `ImTurnProcessor`，渠道侧注入 `mapped => this.processMessage(<key>, mapped.sessionKey, mapped.message)`；两个模块各自单一职责，组合由调用点完成。
4. **渠道侧只保留各自的消息解析与前置校验**（`dispatchPayload` / `onDownstream` / `handleMessageCreate` / `parseLine` / `onWsMessage` / …），共享段 36–37 行 → 16 行，13 个渠道各删去 `resolveIncomingMessage` 导入（净行数不变：−1 导入 +1 导入）。
5. **补 `tests/adapters/channel-inbound-dispatch.spec.ts`（14 条直测）**。
6. **同 PR 重生成事件矩阵**（本刀未移动 `submitTurn` 调用点，矩阵未变，仍走 `--check` 确认）。

## Alternatives considered

- **两个 sink（`deliver` 用于确认回执、`replyTo` 用于命令回执）** — 落选：13 处实证为同一目标，多一个字段只会制造"该用哪个"的歧义；slack/mattermost 的差异（丢弃 helper 回传的 chatId）由 sink 实现内部消化，与既有 N04 判例同构。
- **把 `turn` 也做成 deps 字段并让 `ImInboundDispatch` 内联调用 `processChannelTurn`** — 落选：会让 dispatch 模块依赖 turn 模块，并迫使它同时持有两套参数（轮次需要 `render`/`beforeTurn`/`errorLabel`，分派不需要）；回调解耦后两个模块可独立测试与演进。
- **给 dingtalk 保留 `.trim()`（加 `answerText` 字段）** — 落选：helper 内部已 trim，字段纯粹是历史噪声；核实到内部 trim 后统一传原文，行为不变（已写入本 note 的核验记录）。
- **把 `activeChats` 换成"由 deps 提供的判重回调"** — 落选：13 处都是 `Set<string>`，回调只会增加一层无收益的间接；`Set` 的存在还让测试可以直接观测 add/delete 时机。
- **顺手把 matrix 的 `room already active` 文案保留（加 `wordingLabel` 字段）** — 落选：日志文案无消费方（全仓 grep 确认无代码/文档/测试依赖该串），为它加字段不值得；统一为 `chat` 后语义不变，属可观测面的措辞归一，已在 `Consequences` 记录。
- **一并抽 `deliverCronResult`（cron 结果投递同族复制）** — 落选：该段挂在各渠道的 cron 触发路径上，与入站分派不同源；留给 `TD-ADAPTERS-N01` 的剩余面单列。
- **让渠道类 `implements` 一个"可分派宿主"接口以省去 deps 字面量** — 落选：渠道的字段是 `private`，TS 的私有成员跨类不可结构匹配，靠类型断言硬撑会牺牲类型安全；显式 deps 字面量（16 行）比断言更便宜也更清楚。

## Consequences

- **代码量**：13 个渠道文件 182 行插入 / 470 行删除（净 −288），新增共享模块 86 行 → 净减约 202 行；13 处分派前置收敛到一处。
- **可观测面的一处措辞归一**：matrix 的「`matrix: room <id> already active, skipping`」变为「`matrix: chat <id> already active, skipping`」（其余 12 处原本就是 `chat`）。经全仓 grep 确认无消费方；这是日志措辞而非契约。
- **测试**：新增 14 条直测覆盖——elicitation/permission 挂起与确认投递、两者同时挂起时 elicitation 优先、应答返回 `undefined` 不投递、应答抛错只记日志且不进轮次、无 gateway 时守卫短路后仍走轮次、会话在跑时丢弃、`/new` 回执、空正文吞掉、mapper 入参与轮次在 `activeChats` 包围下执行、轮次抛错仍清标记、mapper 抛错不落标记、交互键与投递目标解耦、`channelKey` 用于日志前缀。渠道类本身仍无集成测试（本刀未改变该现状）。
- **等价性证据**：改写后逐渠道机械比对「被删 span 的要素」与「新调用的要素」（挂起键、应答文本、resolve 文本、投递目标、轮次目标、轮次方法、channelKey），13/13 一致；两处命名差异（sink 形参 `id` 对应旧的具体键、`sendCtx` 字面量）在核验器中显式解析而非忽略。
- **门禁**：`pnpm check` 全绿（`gen-event-matrix: fresh`）；`pnpm test` 全绿。
- **`TD-ADAPTERS-N01` 剩余面**：`deliverCronResult` 投递共享化；以及 6 个语义不同的渠道（webhook/wecom/weixin/feishu/api-server/tui）的分派路径不适用本 helper（既有理由见上一刀 note）。
