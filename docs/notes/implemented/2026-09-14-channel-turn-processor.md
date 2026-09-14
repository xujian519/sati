# Agent Note: 渠道单轮处理循环共享化（turn-processor）

Status: implemented

## Problem

各 IM 渠道的 `processMessage`（qq 另有 `processC2CMessage`）是同一段控制流的手抄件：**14 个渠道、15 段循环**，逐渠道复制「`submitTurn` 事件流 → elicitation/permission 捕获并即时投递提问 → 其余事件渲染累积 → 轮末 trim 后整段投递 → 清理交互挂起」。

机械核验（把 `channelKey`、渲染函数名、回复目标、挂起键变量、错误日志前缀归一化为占位符后对比 HEAD 版本）显示 15 段循环**只剩 8 种"形态"，且差异全部落在签名与投递目标上**：elicitation 分支、permission 分支（含 `if (questionText)` 条件投递）、render 累积、catch 兜底文案、两处 `clear`、`trim` 后的条件投递——这段本体在 15 处逐字相同。

该循环此前**没有任何直接测试**（13 个渠道整体处于无测试集合），因此「改一处漏三处」的风险没有任何回归保护；`docs/technical-debt/backlog.md` §9 已把该抽取登记为 `TD-ADAPTERS-N02`，并明确前置条件：先补测试、且须同 PR 重生成事件矩阵（抽取会移动 21 个 `submitTurn` 调用点中的 15 个，而矩阵按 `file:line` 硬编码）。

## Decision

1. **新增 `src/adapters/channel/protocol/ImTurnProcessor.ts`**：导出 `processChannelTurn(deps, input)`，把上述循环收拢为一处。轮末清理无条件执行（错误路径同样清理），失败文案收敛为常量 `CHANNEL_TURN_FAILURE_TEXT`。
2. **依赖面是最小结构接口而非类**：`ChannelTurnGateway`（只有 `submitTurn`）、`ChannelTurnElicitationSink` / `ChannelTurnPermissionSink`（只有 `capture`/`clear`），因此调用方传真实的 `ImElicitationHelper` / `ImPermissionHelper` 无需适配，测试也不需要为整个 `Gateway` 造桩。
3. **差异用参数吸收，而不是给 helper 加分支**：
   - `gateway?:` 可选表达「未连接则整轮跳过」，等价各渠道原有的 `if (!this.gateway) return;` 守卫（守卫仍是第一条语句，且 `beforeTurn` 排在其后，与原文顺序一致）；
   - `deliver: (text) => Promise<unknown>` 由调用方闭包持有回复目标，从而同时覆盖 `sendReply(chatId, text)`、`sendReply(ctx, text)`、`sendReplyChunked(groupOpenId, text, msgId)`、`sendC2CReplyChunked(userOpenId, text, msgId)` 四种形状；
   - `interactionKey` 与回复目标解耦：mattermost/slack 的挂起键是 `${channelId}:${threadTs|rootId}` 而回复目标是 ctx 对象，qq 的挂起键是 `chatKey`（c2c 分支为 `c2c:${userOpenId}`）而回复目标还要带 `msgId`；
   - `beforeTurn?: () => void` 吸收 discord/telegram 的 `void this.sendTyping(chatId)`（不 await，与原文的 fire-and-forget 一致）；
   - `errorLabel?: string` 仅服务 qq 的第二条循环——它的日志前缀是 `qq: submitTurn error (c2c)`，与群聊分支不同，保留原文案而不是为省一个字段改日志。
4. **15 处调用点改写为 12–19 行薄壳**（qq 两条共 40 行），方法签名与私有可见性均不变，调用方无需改动。
5. **补 `tests/adapters/channel-turn-processor.spec.ts`（15 条直测）**：请求透传、片段累积与 trim、无可见文本不投递、每个非交互事件都交给 render、render 返回 `undefined` 视为无片段、elicitation 无条件投递且不进 render、permission 条件投递、挂起键与回复目标解耦、未连接整轮跳过（不触发 `beforeTurn`/不碰交互状态）、`beforeTurn` 先于 `submitTurn`、流中断的日志前缀与兜底文案替换 + 轮末仍清理、`errorLabel` 覆盖前缀、清理先于最终投递、投递被 await（用 gate promise 验证串行）。
6. **同 PR 重生成 `docs/event-producer-consumer.md`**：`submitTurn` 事件流消费点由 14 个渠道文件收敛为 `ImTurnProcessor.ts` 一处，各事件"submitTurn 流"消费者计数 28 → 14。

## Alternatives considered

- **抽 `abstract class ChannelBase` / mixin，让渠道继承公共循环** — 落选：21 个渠道的 `start`/`stop`/传输细节差异极大（HTTP 回调、WS、轮询、CLI/TUI），公共基类会强迫它们共享与自身无关的构造与生命周期；且 `implements ChannelAdapter` 的接口契约仍要逐一实现，收益只剩循环体，与组合函数等价却多一层继承耦合。
- **同 PR 一并抽走 dispatch 前置（`elicitation.hasPending → answer` / `permissions.hasPending → answer` / `activeChats` 去重 / `resolveIncomingMessage` / `try-finally activeChats.delete`）** — 落选：该段与 `TD-ADAPTERS-N01` 对应，涉及的差异面更大（api-server 回写 HTTP 响应、feishu 的 `queueTurn`/`abortTurn`、wecom 的 `sessionKey` 判据、qq 的 `onStateChange`），且需要两套投递 sink（命令回执 vs 轮次投递）。保持「一个 PR 只动一段可独立验证的控制流」，dispatch 前置留作下一刀（建在同一 helper 之上）。
- **让 helper 直接接受 `Gateway` 与 `ImElicitationHelper`/`ImPermissionHelper` 具体类型** — 落选：`Gateway` 有 30+ 方法，测试要为整轮造桩；具体 helper 类型会把 protocol 层内部实现锁进共享模块的签名，后续换实现要改公共 API。最小结构接口让两侧都无需适配。
- **统一 15 处的日志前缀（去掉 qq 的 `(c2c)`）以省掉 `errorLabel`** — 落选：日志文案是运维定位手段（区分同一渠道的两条循环来源），改文案属于行为变更；为省一个可选字段而改变可观测面不划算。
- **把 18 个 `*-render.ts` 薄包装一并消除（改调 `renderPlainTextEvent`）** — 落选：既有判例已定「渲染薄包装是 options 未被误改的回归钉，且被 `channel-render.spec.ts` 直接 import」，且各渠道 render 保留自有扩展点；这与本次「抽取控制流」是两件事。
- **按渠道逐个 PR（14 个 PR）** — 落选：同一段代码的 14 份改写，拆成 14 个 PR 只会把同一份审查重复 14 遍；等价性由归一化对比 + helper 直测共同保证，一个 PR 内审完更省。

## Consequences

- **代码量**：14 个渠道文件 188 行插入 / 497 行删除（净 −309），新增共享模块 107 行 → 净减约 202 行；15 段循环收敛到一处。
- **测试覆盖变化（诚实说明）**：被抽取的**执行单元**（此前零覆盖）现有 15 条直测；**渠道类本身仍无集成测试**，这一点未被本 PR 改变。渠道侧「等价性」证据来自机械归一化对比（15 段循环的差异只剩签名与投递目标）+ 全部调用点均为薄壳。
- **保留内联的 6 处循环及理由**（后续不要盲目"顺手统一"）：
  - `webhook`：轮内维护"可见失败状态"去重（`isVisibleFailureGatewayEvent`）、无 elicitation/permission 捕获、错误分支走结构化状态事件而非纯文案，投递函数也不同（`deliverReply`）。
  - `wecom`：每事件先 `sendEventMedia`，轮末做交付物抽取（`extractWeComDeliverables`）并逐件投递，另有 `syntheticMessages` 等入参扩展。
  - `weixin`：live reply 控制器 + 超时看门狗 + `chatState.generation` 断点判定，事件分别交给 `liveReply.handleEvent` 而非累积文本。
  - `feishu`：live card 渲染 + 活跃会话排队。
  - `api-server`：投递即写 HTTP 响应（流式/JSON 二选一），无交互捕获。
  - `tui`：本地 TUI 渲染，不经渠道回复通道。
- **事件矩阵**：`submitTurn` 流消费点 14 → 1（`src/adapters/channel/protocol/ImTurnProcessor.ts`）；文档已同变更重生成。
- **门禁**：`pnpm check` 全绿（含 `check:event-matrix`、`check:patent-sop`、`check:skills`、`check:issue-labels`）；`pnpm test` 全绿。
- **仍待做**：`TD-ADAPTERS-N01` 的 dispatch 前置与 cron 投递共享面（`deliverCronResult` 同族复制）。
