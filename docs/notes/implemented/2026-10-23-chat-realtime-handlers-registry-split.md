# Agent Note: sweep B1.2 · useChatRealtimeHandlers 注册表拆分（#646）

Status: implemented

## Problem

`ui/src/components/chat/hooks/useChatRealtimeHandlers.ts` 是实时链的入口：一个 **721 行**的 hook
里嵌着一个 **624 行**的匿名 `handleMessage`（文件 1,024 行）。它同时承担六件事：

1. WebSocket 帧的归属解析（`activeViewSessionId` / `sessionId` 回落 / runId）；
2. 7 类 `kind` 帧的 store 写入（agent_activity、subagent_link、active-turn 投影 text、
   subagent detail、stream_delta、thinking、stream_end）；
3. 3 个 legacy `messageType` case（`websocket-reconnected`、`pending-permissions-response`、
   `session-status`）；
4. 10 类副作用的 UI 编排（file_artifacts、session_created、complete、error、
   permission_request、permission_cancelled、approval_pending、approval_resolved、status、
   compact_boundary）；
5. 通用 store 路由与重复文本检测；
6. session-status 未知时的重试定时器。

新增任何一种帧都要改这个中心箭头函数，且定时器状态与 React 生命周期混在一起。

计划判据（B1.2）：按 kind 分发的 handler 注册表；timers → `useSessionStatusRetryTimers`；
helper → utils；两个函数各 ≤350 行。

## Decision

### 模块边界（6 个新文件，全部 <800 行）

| 文件 | 行数 | 职责 |
|---|---|---|
| `useChatRealtimeHandlers.ts` | 113 | 薄 hook：两个 ref + timers hook + `useMemo` 工厂 + subscribe effect |
| `chatRealtimeHandlers.ts` | 253 | `createChatRealtimeMessageHandler`（231 行）与 7 条 kind 注册项 |
| `chatRealtimeLegacyHandlers.ts` | 190 | 3 个 `messageType` case 的独立工厂 |
| `chatRealtimeSideEffects.ts` | 359 | 10 类副作用的 kind → handler 注册表 |
| `chatRealtimeMessageUtils.ts` | 212 | 14 项纯工具（归一化、去重、投影、runId、日志） |
| `chatRealtimeTypes.ts` | 102 | `LatestChatMessage` / 帧结构 / 依赖类型 |
| `useSessionStatusRetryTimers.ts` | 52 | 重试定时器 Map、`clear`/`schedule`、卸载清理 |

结果：hook **721 → 103 行**，`handleMessage` **624 → 95 行**，文件 **1,024 → 113 行**；
最大的新函数是 `createChatRealtimeMessageHandler`（231 行），未引入新的 ≥300 行 god function。

### 派发顺序原样保留

`handleMessage` 的顺序与旧版逐段一致，注册表不改变优先级：

1. 归属解析与归属告警；
2. **legacy 三 case 优先**（命中即 return，含 active-turn replay 递归回顶层 handler）；
3. kind 注册表按原 `if` 链顺序匹配**第一条**：agent_activity → subagent_link →
   text + `activeTurnProjection` → subagent detail（非空 `subagentId`）→ stream_delta →
   thinking → stream_end；
4. 通用 store 路由（`flushKinds`、重复文本检测、`appendRealtime`）；
5. 副作用注册表（未登记 kind 与旧 `default: break` 等价，静默）。

### 关键契约

- **依赖数组零变化**：`useMemo` 的 23 项依赖与旧 `useCallback` 逐项相同。工厂不消费
  `sendMessage`（只有 timers hook 消费），因此不把它注入工厂——否则
  `react-hooks/exhaustive-deps` 会要求把它加进依赖，改变 `handleMessage` 的身份变化频率与
  subscribe 重订节奏。
- **ref 生命周期不变**：`thinkingBySessionRef`、`activeTurnReplaySignatureRef` 仍由 hook 持有，
  跨渲染稳定；定时器 Map 随 `useSessionStatusRetryTimers` 迁移，并保留卸载清理 effect。
- **单一定时器语义**：`scheduleSessionStatusRetry` 仍以 sessionId 去重、`clear` 幂等，
  超时后发送与旧版完全相同的 `check-session-status` 帧（`includeActiveTurnMessages: true`）。

## Alternatives considered

- **只把每个 case 提取成函数、保留单文件**：`handleMessage` 仍是 624 行的中心派发体，
  新增帧继续改同一处；且不满足「timers → hook、helper → utils」的判据。否。
- **用 `Record<kind, handler>` 取代顺序 `if` 链**：`text` 需要叠加
  `activeTurnProjection === true`，subagent detail 还需要非空 `subagentId`，Record 无法表达
  「守卫 + 首条命中」的原语义，改成查表会引入额外的优先级编码。否（选择有序数组 + `matches`）。
- **把 `sendMessage` 注入工厂**：工厂不使用它，注入会强迫依赖数组新增一项，改变回调身份与
  subscribe 重订行为，属于本项「行为零变化」边界之外。否。
- **把定时器并进工厂/hook 主体**：定时器 ref 会绑在 `useMemo` 依赖上，依赖变化时 Map 被重建，
  重试去重失效；独立 hook 保持 ref 生命周期稳定。否。
- **Class/service 化**：状态与 React ref/effect 生命周期耦合，class 化只增加适配层，
  且会扩大跨模块 API 面。否。
- **顺手统一日志文案或重构 legacy case**：超出「行为零变化」边界，会让逐 token 对拍失真；
  本批只做声明化改写（抽取 case 的 `break → return`、末尾 switch 的 `break` 删除）。否。

## Verification

- **逐段 token 对拍 43/43 一致**（TS scanner，跳过 trivia；声明改写：抽取 switch case 的
  `break → return`、末尾 switch `break` 删除；格式化产生的尾逗号在 `)`/`]`/`}` 前规范化）。
- **负控制**（注入后恢复，逐条核对转红名单）：
  - C1 删除 `isProcessing === null` 分支的 `return`：`useChatRealtimeHandlers.test.tsx`
    **1 failed / 7 passed**（预期的「不调用 onSessionInactive」断言转红）。
  - C2 删除投影新鲜度守卫：**1 failed / 7 passed**（预期的「行内容比投影新」用例转红）。
  - C3 日志文案 `Dropped WS frame` → `Dropped frame`：token proof **42/43** 转红，
    jsdom 测试 **8/8** 仍绿——证明对拍能抓住复制漂移，而测试不覆盖文案。
- **定向测试**：`useChatRealtimeHandlers.test.tsx` 8/8 + `useSessionStore.streaming.test.ts`
  24/24。
- **UI 全量**：197 个文件 / 1,486 个测试通过。
- **门禁**：`pnpm check` EXIT=0；`pnpm test` 5,968 例 / 5,963 pass / 0 fail / **5 skip**
  （既有跳过：本地法律库集成（含子用例）、非 CI graphviz、未录 fixture——均为环境/录制依赖，
  与本改动无关）；`pnpm test:pr-tooling` 197/197。
- **生成物**：`gen:event-matrix` 无 diff（矩阵不登记该 UI hook）；`gen:doc-claims` 0 处；
  架构基线移除该文件 file-size 豁免（**40 → 39**）；`metrics.md` ui/src 647 → 653 文件、
  103,082 → 103,345 行。
