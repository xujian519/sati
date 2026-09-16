# Agent Note: 压缩终态可见（降级 / 中断 / 失败）

Status: implemented

## Problem

压缩（context compaction）只有一个可见终态：**已压缩**。三种不同的结局在 UI 上完全同形，
而差异对使用者是有意义的——「摘要成功」与「用确定性降级摘要顶上」决定了接下来回答的质量，
「用户中断」则解释了为什么这次压缩之后上下文没变小。

核码后，缺口分三层，严重程度递减：

1. **摘要降级已经落盘，但被投影丢弃。** `compactionExecutor.ts` 把
   `compactMetadata.extra = { tier, summarySucceeded }` 写进 transcript，而
   `injectWebMessages.ts` 的 `compactBoundaryMetadata` 只透传 6 个字段的白名单，
   `extra` 不在其中。历史投影因此**无法表达**「这次只是降级摘要」——信息在磁盘上，
   在读路径上丢掉。
2. **中断被吞成降级。** `CompactionEngine` 的摘要调用把异常一律转成 `summaryError` →
   `status: "fallback"`，取消（abort）也走这条路。于是「用户点了停止」与「摘要模型挂了」
   不可区分，且都被登记为一次成功压缩。
3. **硬失败不可见。** `compactionExecutor` 的 catch 只写一行 warn 日志，不发事件、不落
   transcript。失败不是被误显示为成功，而是**完全没有显示**——一次压缩尝试无声消失。

同时 UI 侧的三态类型早就预留了：`CompactProgress.state` 的联合里有 `"failed"`，
但全仓没有任何生产者。

## Decision

四件事，前两件零新增字段：

1. **历史投影透出 `extra`**：`compactBoundaryMetadata` 增读 `summarySucceeded` / `tier` /
   `status`（用 `isRecord` 守卫，缺省不写键）。旧记录不带这些字段，因此必须"读不到就不写"，
   由读侧按"缺省 = 成功"处理。
2. **落盘补 `status`**：`extra` 增加 `status`，取自 `CompactionResult.status`（新增字段）。
   比 `summarySucceeded` 布尔更准确——它区分 `fallback` 与 `cancelled`。
3. **`CompactionStatus` 四值**：`success | fallback | cancelled | failed`。
   `AgentEvent.compact_completed.status` 由 `string` 收窄为该联合（编译期把关）。
   中断在摘要 catch 里由 `input.signal?.aborted` 判定，**且不进入 60s 摘要失败冷却**——
   用户中断不是摘要失败，误入冷却会让下一次压缩静默退化成确定性摘要。
4. **硬失败补一条配对终态**：`CompactionEngine.run` 在发出 `compact_started` 之后包
   try/catch，硬抛时先发 `compact_completed{status:"failed"}`（同一 compactionId）再 rethrow。
   放在引擎内而不是 `compactionExecutor` 的 catch，是因为 `compactionId` 由引擎生成——
   在 executor 侧补出来的事件无法与 `compact_started` 配对。

**UI 侧的关键分流**：`src/web/client/eventMapping.ts` 对
`status ∈ {failed, cancelled}` **不再产出 `compact_boundary` 帧**，改产出 `kind:"status"`
且 `compactProgress.state` 为对应值。否则失败仍然渲染成一条绿色的「已压缩」边界行。
边界行色调抽成纯函数 `resolveCompactBoundaryTone`（`ok | degraded | cancelled`）。

## Alternatives considered

- **新增独立的 `compact_failed` / `compact_cancelled` 事件类型** — 落选：新增事件变体要重跑
  事件矩阵并新增产/消边，而"压缩以某终态结束"本就自然属于 `compact_completed` 的语义扩展。
  代价是事件名对"失败"读起来别扭，用 `CompactionStatus` 的注释把这个语义写死。
- **复用 `agent_status` 的 error 形态报失败** — **明确否决**，这是本变更最大的陷阱：
  `TurnRunner` 会把任意可见失败状态置 `hasRecordedVisibleFailureStatus = true`，
  进而在收尾时**吞掉真正的 turn 失败横幅**；`sati-bridge.js` 也会把后续 error 帧静默掉。
  一个"压缩失败"会把"这一轮彻底失败"从界面上抹掉，方向恰好是危险的那一侧。
  代码注释与 frame 分流处都写明了这条约束。
- **只在 UI 侧判"没有 postTokens 就是失败"** — 落选：幻觉式判据。降级压缩同样可能没有
  postTokens，会把正常降级误判为失败。
- **在 `compactionExecutor` 的 catch 里补发失败事件（不改编排引擎）** — 落选：拿不到
  `compactionId`，事件无法与 `compact_started` 配对，UI 侧无法把"正在压缩"替换成"压缩失败"；
  且 `compact_started` 之前抛出的错误会造出一条没有前驱的终态。
- **把失败也渲染成边界行（只改配色）** — 落选：硬失败不写 transcript，刷新后那条行会消失，
  形成"失败过一次但历史里查无此事"的不一致。失败是**事件**，不是边界。
- **让中断进入摘要失败冷却** — 落选：用户中断不是摘要缺陷，冷却会让下一次压缩跳过模型、
  静默使用确定性摘要，把一次用户操作放大成后续压缩质量的下降。
- **一并把 tier-1（micro）/ tier-2（snip）也纳入终态** — 不在本次范围：这两级在
  `DefaultContextRuntime` 返回 `{type:"compacted", tier}` 但不带 `result`，
  而 `persistCompactSnapshot` 开头即 `if (!compact.result) return;`，因此既无事件也无
  transcript 痕迹。要覆盖它们得先让这两级也产出 result，属于独立变更。

## Consequences

**换来**：压缩的三种结局在 UI 上可区分——成功（绿）/ 摘要降级（琥珀）/ 中断（琥珀 + 专属文案）；
历史投影与实时帧从此携带同一套终态字段；压缩硬失败不再无声消失。
`working.compactingLevel` 这个无引用的死键随之删除。

**付出与限制**：

- `extra.status` 只对**此变更之后**的压缩记录存在。旧记录只有 `summarySucceeded`，
  因此旧的历史压缩行只能区分"成功 / 非成功"，`fallback` 与 `cancelled` 对它们不可分。
  读侧按 `compactSummarySucceeded === false` 归入降级色，不会误报为失败。
- `compact_completed` 现在有两个生产者（成功路径与失败路径），事件矩阵里已登记为两条边。
- 边界行的文案长度不同（`已中断（沿用降级摘要）` 最长）。已在 1637px 与 390px 两个视口
  实测：390px 下胶囊换行为两行、无文字裁切、无横向溢出。

## 相关

- 上游：PilotDeck #570（`compactState` 的 failed/cancelled 语义与 pending 判定）
- 方案：`docs/pilotdeck-2026-09-upstream-port-plan.md` §P2
- 验收：`tests/context/compaction-engine.spec.ts`（硬失败配对终态 / 中断不进冷却）、
  `tests/web/eventMapping.spec.ts`（失败不得渲染成边界帧）、
  `tests/web/compact-replay.spec.ts`（extra 透出 + 旧记录不臆造）、
  `ui/src/components/chat/view/subcomponents/compactBoundaryTone.test.ts`（色调判据）、
  `ui/src/components/chat-v2/MessagesPaneV2.render.test.tsx`（失败/中断标题）
- 浏览器实测：真实 transcript（历史投影）+ 三个合成 transcript（成功/降级/中断），
  在 1637px 与 390px 视口下确认徽标配色、i18n 取值与无溢出
