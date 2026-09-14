# Agent Note: 渠道 HTTP 体读取与入站消息解析共享化

Status: implemented

## Problem

渠道接入面有两类同构复制，属于"改一处要记得改 N 处"的形态：

- **HTTP 请求体读取**：`api-server` / `sms` / `webhook` 三个 HTTP 入站渠道各自内联实现 `readRequestBody`，剔除无差异的常量名后**逐字相同**（17 行 ×3）。该实现此前**没有任何直接测试**——三份副本意味着任何一处改动（超限语义、错误文案、`destroy` 时机）都要同步三遍，且没有回归保护。
- **入站消息的「新会话确认」**：共享层已有 `resolveIncomingMessage`（`src/adapters/channel/protocol/ChannelCommandRegistry.ts`），把"mapper 解析 → `/new` 无正文则回执 `已创建新会话。` → 空正文直接吞掉"收敛成一次调用，但只有 6 个渠道用它；另有 13 处仍在各渠道内联同一套三分支逻辑。`/new` 回执文案或吞空规则的修正因此仍需逐渠道重复。

## Decision

1. **新增 `src/adapters/channel/protocol/httpBody.ts`**：`readRequestBody(req, max)` 从 api-server 版本逐字迁移（含 `payload too large` 错误文案与超限时 `req.destroy()`），三渠道改为直接 import。错误文案保留原样——调用方按该文案分流错误响应，它是对外契约的一部分。同 PR 补 `tests/adapters/channel-http-body.spec.ts`（多字节字符跨分片拼接、恰好等于上限、超限拒绝且请求被销毁、流错误透传）。
2. **8 处内联收敛到 `resolveIncomingMessage`**：`dingtalk`/`bluebubbles`/`matrix`/`signal`/`whatsapp`/`webhook` 的回复目标就是 `chatId`，直接传 `(id, t) => this.sendReply(id, t)`；`slack`/`mattermost` 的回复目标是 `{channelId, threadTs|rootId}` 上下文对象，用 `(_id, t) => this.sendReply(sendCtx, t)` 丢弃 helper 回传的 `chatId`（`sendCtx` 由纯对象字面量提前构造，无副作用、语义不变）。
3. **保留 5 处内联并记录理由**（见下），不做机械统一。

## Alternatives considered

- **把 `readRequestBody` 并入 `protocol/text.ts`** — 落选：`text.ts` 是零依赖的纯字符串工具（分块/`/new` 前缀解析），塞进 HTTP 请求体读取会把 `node:http` 类型依赖引入该模块，且两者不同类。
- **把 `readRequestBody` 并入 `protocol/ChannelCommandRegistry.ts`** — 落选：该模块职责是渠道命令注册与执行，HTTP 体读取与之无关，合入会让模块名与内容不符。
- **改用 `raw-body` 等既有 npm 包** — 落选：为 17 行通用逻辑新增运行时依赖不划算，且其错误类型/文案与仓内既有的 `payload too large` 契约不一致，三处调用方的错误分流都要跟着改。
- **把 3 处 `readRequestBody` 与 5 处语义不同的内联一并"强行统一"** — 落选：见下 `Consequences` 中保留清单，各自差异是业务语义而非写法差异。
- **同 PR 一并抽取 13 个渠道的单轮处理循环（TD-ADAPTERS-N02）** — 落选：该抽取会把 21 个 `submitTurn` 调用点搬入共享模块，而 13 个渠道**全部处于无测试集合**；台账已定序为"先补测试再动"的独立 PR，不应与本去重混在一起（本 PR 仅新增 import 与局部语句替换，不移动 `submitTurn` 调用点）。

## Consequences

- 三个 HTTP 入站渠道此后共用一份请求体读取实现，且该实现首次获得直测；`/new` 回执与吞空规则共 19 处站点（本 PR 前为 6 处共享 + 13 处内联），现收敛为 **14 处共享调用 + 5 处保留内联**。
- **保留的 5 处内联及其理由**（后续不要盲目"顺手统一"）：
  - `api-server`：`/new` 回执不是发消息而是**写 HTTP 响应**（流式或 JSON 二选一）；且空正文分支返回 400 结构化错误体，不是"吞掉"。
  - `feishu`：`/new` 需先 `abortTurn` 既有运行 + 重置交互状态；活跃会话时是 `queueTurn` 排队而非丢弃。
  - `wecom`：回执需携带 `chatType`/`replyToMessageId` 选项；活跃判据是 `sessionKey` 而非 chatId。
  - `weixin`：`/new` 需先 `abortTurn` + 重置状态，且空正文分支嵌在 `command === "new"` 内。
  - `qq`：mapper 入参形状不同（`{groupId, userId, text}` 而非 `{chatId, text}`），且在 `command === "new"` 时需回调 `onStateChange` 上报状态快照——套用 helper 需要一层丢弃/转发入参的包装，代码量不低于内联，可读性反而下降。
- `docs/event-producer-consumer.md` 按 `file:line` 硬编码，本 PR 已同变更重生成（行号位移）。注入的 `readRequestBody` 被事件矩阵启发式识别为 `error` 消费点——与它取代的三处 `req.on("error", reject)` 同源，属启发式 v1 对 Node 流错误监听的既有误报，非新增语义。
- 顺带修正 `ChatSessionMapper.ts` 文档注释中指向不存在路径 `docs/techdebt/adapters-shared-mapper.md` 的引用（上一轮共享化实际落在 `docs/notes/implemented/2026-09-11-adapters-skill-split.md`）。
