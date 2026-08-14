# deepseek-harness 优秀设计引入计划 —— 阶段二实施文档

- 创建日期：2026-08-14
- 状态：**部分实施（2026-08-14）**——S2-A（遮蔽范围可恢复化）已落地；依赖 AgentLoop 拆解的后续工作项已明确（见 §6）
- 前置：阶段一（`docs/deepseek-harness-phase1-plan.md`）已实施完成

---

## 1. 阶段二目标与范围

阶段二对应 dsh 三大设计：

| 编号 | 设计 | 阶段二任务 |
|---|---|---|
| #1 | 「模型可见 = 已记录」单一事实源 + 投影 | transcript 投影化（messages 派生） |
| #2 | 遮蔽式压缩 + 摘要前缀缓存对齐 | 压缩不删历史、遮蔽可逆；触发时机收敛 |
| #5 | 事件化扩展点 | pre-step / request-error / pre-execute 瀑布 |

实施前深度调研确认：Sati 的会话/压缩体系已比阶段一假设的成熟（transcript 事件流 + 压缩边界 + 重放切片），阶段二的核心增量是**压缩遮蔽的可逆性**（对应 dsh surface replace）。

---

## 2. 调研结论（已核实）

### 2.1 会话数据流

```
AgentLoop 运行期 messages（内存数组）
  ├─ 每轮消息经 input.onDurableMessage → TurnRunner.persistDurableMessage
  │    → transcript.recordDurableMessage（JSONL 追加）
  └─ 恢复期：replayTranscriptEntries 从 transcript 投影 messages
       （压缩 boundary 之前的消息丢弃——"重放即切片"）
```

- `AgentSessionState.messages` 由 TurnRunner 运行结果持有（`AgentSession.ts:101`），非 transcript 派生；
- `replayTranscriptEntries`（`TranscriptReplay.ts:41`）已实现投影 + 压缩边界切片（`findLastCompactBoundaryIndex`）；
- 压缩：`tryAutoCompact`（`DefaultContextRuntime.ts:327`）返回新 messages 数组，AgentLoop 替换 + `persistCompactSnapshot`（`AgentLoop.ts:2084`）写 `control_boundary`（compact_boundary）。

### 2.2 压缩边界现状

- `CompactBoundaryMetadata`（`TranscriptEntry.ts:57`）已有：compactionId / trigger / preTokens / postTokens / messagesSummarized / preservedSegment / preCompactDiscoveredTools / extra；
- **缺**：被遮蔽（摘要替代）消息的定位信息——重放无法从 transcript 精确恢复被压缩的原文；
- transcript 原文（durable_message）完整保留——**压缩不删历史的事实已成立**，缺的是"定位被遮蔽内容"的元数据。

### 2.3 触发时机

`tryAutoCompact` 在 AgentLoop 有**两个调用点**（`AgentLoop.ts:396` 路由前、`:482` 路由后）——但第二个仅在**路由模型窗口变化**（routedMaxCtx ≠ preRoutingMaxCtx）时触发，语义合理（窗口变了才需要重新评估），非重复触发。

### 2.4 注入审计（S2-B 调研结论）

记忆/知识/指令注入（`DefaultContextRuntime.prepareForModel`）作为 system prompt 段落**动态组装，不落 transcript**——违反「模型可见 = 已记录」：
- `<memory-context>`（记忆检索结果）→ systemPromptParts，不落库；
- `<project-instructions>`（SATI.md）→ systemPromptParts，不落库；
- 修复需把注入内容作为带 `source` 标记的 durable_message 落库，涉及 prepareForModel 与 AgentLoop 的协作改造——**依赖 AgentLoop 拆解**。

---

## 3. 本轮实施：S2-A 遮蔽范围可恢复化

### 3.1 目标

让压缩从「重放即丢弃」升级为「遮蔽可逆」——transcript 记录被遮蔽消息的索引范围，重放可恢复被摘要替代的完整原文（供审计 / UI 历史回看 / 恢复），对应 dsh surface replace 语义。

### 3.2 改动

| 文件 | 改动 |
|---|---|
| `src/context/compaction/CompactionEngine.ts` | `CompactionResult` 增加 `shadowedMessageIndexes?`；`planFullCompactionMessages` 计算被遮蔽消息的原始索引（分组保序游标累计）；新增导出 `compressIndexRanges`（索引 → 含端范围） |
| `src/session/transcript/TranscriptEntry.ts` | `CompactBoundaryMetadata` 增加 `shadowedRanges?: Array<{ fromIndex; toIndex }>` |
| `src/agent/loop/AgentLoop.ts` | `persistCompactSnapshot` 把 `shadowedMessageIndexes` 压缩为 `shadowedRanges` 写入 compactMetadata |
| `src/session/transcript/TranscriptReplay.ts` | 新增 `replayShadowedMessages(entries)`：按最后一个 compact_boundary 的 shadowedRanges 从全量投影序列恢复原文；内部 `projectFullMessageSequence`（与 replayTranscriptEntries 同构的投影） |
| `src/session/index.ts` | 导出 `replayShadowedMessages` / `ShadowedMessagesResult` |
| `tests/session/shadowed-messages-replay.spec.ts`（新） | 7 用例：ranges 压缩、单/多范围恢复、无 ranges/无边界空、模型视图不变、越界截断 |

### 3.3 设计要点

- **索引语义**：shadowedRanges 基于「压缩输入 messages 序列」；恢复基于「最后一次压缩输入区间投影」（倒数第二个 compact_boundary 之后到最后一个之前：上次压缩产物 + 其间新增消息）。multi-compaction 场景索引对齐（修复记录：审查发现全量投影在多次压缩后与压缩输入序列错位，已改为输入区间投影 + 对齐自检诊断）；残余错位仅来自未落库消息（transient synthetic prompts、压缩产物持久化失败被吞），由 `replayShadowedMessages` 的 diagnostics 提示而非静默截断；
- **模型视图不变**：`replayTranscriptEntries`（压缩边界切片）行为未改，恢复函数是新增只读能力；
- **向后兼容**：`shadowedMessageIndexes`/`shadowedRanges` 均为可选字段，旧 transcript 无字段时恢复返回空。

---

## 4. 验证结果（阶段二）

- `pnpm typecheck`（Node 22）✅ 0 错误
- `pnpm lint` ✅ 0 error / 0 warning
- `pnpm format:check`（biome）✅ 通过
- 新增测试 7 用例全绿；受影响模块回归 80 用例全绿（context/session/knowledge/permission/model-config）
- 全量后端测试（Node 22）：见阶段一 §10.3 基线（proxy 测试仍受本机代理环境变量影响，与本改动无关）

---

## 5. 实施中的实证修正

1. **S2-A 索引对齐**：CanonicalMessage 无稳定 id（仅 metadata.transientId），被遮蔽消息定位只能走索引。审查发现并修复：恢复投影基础从「transcript 全量序列」改为「最后一次压缩输入区间」（多次压缩后全量投影与压缩输入序列错位，会静默返回错误原文）；另加对齐自检诊断（还原数与 shadowedRanges 期望数不符时产出 warning），覆盖未落库消息（transient / 压缩产物持久化失败）导致的残余错位。
2. **注入不落库是真实 gap**（S2-B）：记忆/知识/指令注入作为 system prompt 段落动态组装，未落 transcript——完整修复依赖 AgentLoop 拆解。
3. **触发时机已合理**：路由后压缩仅在模型窗口变化时触发，非重复——无需代码改动，收敛动作并入 AgentLoop 拆解（单一压缩执行器）。

---

## 6. 依赖 AgentLoop 拆解的后续工作项（阶段二剩余）

以下工作无法在不拆解 AgentLoop（3500 行上帝文件，无直接测试）的前提下安全落地，需先完成主循环拆分：

| 工作项 | 说明 | 前置 | 状态 |
|---|---|---|---|
| 事件化扩展点 | `agent/pre-step`（消息改写/拒绝）；request-error 通知语义由既有 `StopFailure` 覆盖、pre-execute 由既有 `PreToolUse` 覆盖（已核实，无需新增） | AgentLoop 拆解后接缝化 | ✅ 已实施（PreStep 钩子） |
| 单一压缩执行器 | 3 个 tryAutoCompact 调用点（pre-routing / post-routing / model-error-recovery）收敛为 `runAutoCompact` 单一入口 | AgentLoop 拆解 | ✅ 已实施 |
| 注入内容落库 | 记忆/指令/方法论注入作为带 `source` 标记的 `injected_context` 参考条目落库（「模型可见 = 已记录」；重放投影跳过，不进入模型可见 messages） | AgentLoop 拆解 | ✅ 已实施（`readInjectedContexts` 审计面） |
| 运行期 messages 投影化 | `AgentSessionState.messages` 改为从 transcript 派生（增量缓存 + 投影），消除内存态与持久态漂移 | AgentLoop 拆解 + transcript seq 契约 | ✅ 已实施（读取面：`projectMessagesFromTranscript` + `AgentSession.projectMessages` 注入；submit 历史输入从持久层派生，持久层为准；内存 transcript 回退 `state.messages`） |
| UI 消费 shadowedRanges | readSessionMessages / ui/server 暴露"压缩前历史可展开" | 双后端收敛（阶段三） | ✅ 已实施（见下方 §7；RPC 读取路径已收敛到 TS 后端，无需完整双后端收敛即可落地） |

---

## 7. UI 消费 shadowedRanges（2026-08-14 实施）

### 7.1 目标

历史会话中，每次压缩边界可见（分隔线 + token 前后对比），且可展开查看该次压缩被遮蔽（摘要替代）的完整原文——对应 dsh surface replace 语义的 UI 审计面。

### 7.2 数据链路

```
transcript（control_boundary + durable_message 原文）
  → readWebSessionMessages：按边界生成 compact_boundary WebMessage
    （payload 内嵌 shadowedRanges + shadowedMessages（WebMessage 级扁平化））
  → ui/server routes/messages.js：mapWebMessageToNormalized 透传 compactMetadata（= payload）
  → store merged NormalizedMessage
  → useChatMessages.normalizedToChatMessages：compact_boundary → ChatMessage（isCompactBoundary + shadowed*）
  → MessageComponent：压缩边界行 + 「展开压缩前 N 条消息」交互
```

### 7.3 改动

| 文件 | 改动 |
|---|---|
| `src/session/transcript/TranscriptReplay.ts` | `replayShadowedMessages` 泛化出 `replayShadowedMessagesAt(entries, boundaryIndex)`（按任意边界恢复被遮蔽原文）；原函数委托最后一次边界，语义不变 |
| `src/web/server/readSessionMessages.ts` | `CompactBoundaryInfo` 加 `boundaryIndex`；`compactBoundaryMetadata` 透传 `shadowedRanges`；新增 `insertCompactBoundaryMessages`——主会话与 subagent 路径均在对应消息后插入 `compact_boundary` WebMessage（payload = metadata + shadowedMessages） |
| `src/session/index.ts` | 导出 `replayShadowedMessagesAt` |
| `ui/src/components/chat/types/types.ts` | `ChatMessage` 加 `shadowedRanges` / `shadowedMessages`；新增 `CompactBoundaryShadowedMessage` 类型 |
| `ui/src/components/chat/hooks/useChatMessages.ts` | `compact_boundary` 转换透传 shadowed 数据（`extractCompactBoundaryShadowed` 从 compactMetadata 提取，宽松校验） |
| `ui/src/components/chat-v2/processGrouping.ts` | `isProcessMessage` 排除 `isCompactBoundary`（压缩边界作为独立消息行渲染，不再折叠进 process 组） |
| `ui/src/components/chat/view/subcomponents/MessageComponent.tsx` | `isCompactBoundary` 分支重构为 `CompactBoundaryRow`（标签行 + 展开按钮 + 被遮蔽原文只读列表：user/assistant 文本、thinking、tool_use、tool_result、图片） |

### 7.4 设计要点

- **内嵌而非按需 RPC**：shadowedMessages 直接内嵌在 compact_boundary WebMessage payload（复用同一 flatten 投影），前端展开无需额外请求；分页随 boundary 消息走。桌面单机场景 payload 总量 = transcript 历史本身，可接受；
- **多压缩支持**：`replayShadowedMessagesAt` 每次压缩分别恢复（投影区间 = 前一个 compact_boundary 之后、本 boundary 之前）；`replayShadowedMessages`（最后一次）向后兼容；
- **向后兼容**：旧 transcript 无 shadowedRanges → 压缩边界消息仍显示（标签行），展开按钮隐藏（shadowedMessages 为空）；
- **分页语义不变**：compact_boundary 在 flatten 后、slice 前插入，offset/limit 切分一致。

### 7.5 验证

- 后端：`tests/web/compact-replay.spec.ts` 更新（boundary 存在 + shadowedRanges/shadowedMessages 内嵌断言）；`tests/session/shadowed-messages-replay.spec.ts` +3 用例（replayShadowedMessagesAt 多压缩/非法索引）；
- 前端：`useChatMessages.compactBoundary.spec.ts` +2 用例（shadowed 透传/畸形 payload 容忍）；MessagesPaneV2 渲染测试回归通过；
- 全量验证链同 §4（typecheck/lint/biome/Node 22 全量测试）。
