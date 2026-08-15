# 跨进程重启续算重试（#2）专项实施计划

> 方案版本：v0.2（2026-08-16 审阅修订：并入 P0 设计前提决策与 P1/P2 修正，见 §0 修订记录）
> 编制日期：2026-08-16
> **实施状态：已实施（2026-08-16）**——T-A/T-B/T-C/T-D 全部落地并合入 main；实证修正见 §4.2
> 前置：deepseek-harness-phase4-plan.md 全部任务（T1–T10）已合入 main（PR #34/#35/#36/#37/#38）
> 适用范围：Sati agent 会话的跨进程恢复——进程崩溃/强制退出/断电后，重启时自动扫描中断任务并按 (turn, step, provider, policyKey) 续算
> 决策依据：phase4 §4.2（T4 目标原文）「retryId 跨重启稳定、重启后按 (turn, step, provider, policyKey) 扫描续算」+ §7 风险 4 + §9.5 遗留注意

---

## 0. 修订记录

| 版本 | 日期 | 修订内容 |
|---|---|---|
| v0.1 | 2026-08-16 | 初稿（四段式：现状/改动/验收/结果） |
| v0.2 | 2026-08-16 | 审阅并入：P0-1 单 turn_result 投影收敛决策；P0-2 resume 顺序自引用修复（`skipInterruptedSynthesis`）；P0-3 T-A 事实基线修正（router-events.jsonl 已有 best-effort 落盘、RetryStateTracker 死代码）；P0-4 部分响应断点首期红线；P1 扫描范围/审批挂起/policyKey 定义/测试基建/CAS 标注/重建算法；P2 表述修正 |

---

## 1. 现状

### 1.1 已具备的能力（进程内 durable 边界，T4 已落地）

| 能力 | 实现 | 位置 |
|---|---|---|
| 写入即落盘 | `recordEntry` 每次 `await appendFile`（无写后缓冲）；`flushCheckpoint` 为契约性 no-op，真实价值在显式 checkpoint 接线 | `src/session/transcript/JsonlTranscriptWriter.ts`、phase4 §9.4 实证修正 2 |
| 工具副作用前 checkpoint | `executeToolCalls` 在工具执行前 `await input.onFlushCheckpoint?.()`（fail-closed：无法保证持久边界就不发生副作用） | `src/agent/loop/AgentLoop.ts:1250-1253`、`src/agent/turn/TurnRunner.ts:277-279` |
| 进程内稳定 retryId | `createRetryId(provider, model, scope)`：同 scope（turnId）跨 attempt 哈希稳定；缺 scope 退化为随机 UUID | `src/model/streaming/retryState.ts:41-49`、`streamModel.ts:137-139` |
| 重试进度透出 | `streamModel` 经 `onRetryProgress` 回调 → router `streamAttempt` 转 `sati_router_retry_progress` 事件（含 retryId/attempt/reason/provider/model，**无 policyKey**） | `streamModel.ts:569-588`、`RouterRuntime.ts:1074-1089` |
| 重试事件落盘（best-effort） | gateway 事件钩子把 `sati_router_retry_progress` `appendFileSync` 到 `~/.sati/router-events.jsonl`（可丢、非 transcript 权威序列、无恢复语义） | `src/cli/createLocalGateway.ts:639-652` |
| 请求信封快照 | 发送前落 `request_header`（provider/model/maxOutputTokens/systemPromptDigest/toolSchemaDigest/messageCount，log-only，投影不进入模型可见消息；**不含请求体内容**） | `src/agent/loop/AgentLoop.ts:452-458`、`src/session/transcript/TranscriptEntry.ts:208-221` |
| 模型消息流式落盘 | `onDurableMessage` 在流式过程多处落盘（partial assembled，`AgentLoop.ts:761/807/1367`；abort 时 `captureAbortedPartial` 落盘残片，`1635-1654`） | `AgentLoop.ts`、`TurnRunner.ts:98-124` |
| 孤儿 turn 收尾 | resume 时 `synthesizeInterruptedTurn` 合成 `turn_result{interrupted}`（sequence=maxSeq+1 并入本次重放序列，投影立即闭合）；**只在 resume 入口触发** | `src/session/resume/resumeAgentSession.ts:77-89`、`src/session/transcript/interruptedTurn.ts` |
| 会话级 resume | gateway `createSession` 每次会话激活都 `resumeAgentSession`（读 transcript → 重放 → 重建会话状态 + metadata），**内部总是执行孤儿合成** | `src/cli/createLocalGateway.ts:1081-1094`、`resumeAgentSession.ts:59-131` |
| 会话枚举 | `listProjectSessions`（readdir chatDir 过滤 .jsonl，mtime 快速失效缓存）；每项目一个 chatDir，子代理 transcript 在 `chatDir/{id}/subagents/` | `src/session/storage/SessionList.ts`、`src/session/storage/ProjectSessionStorage.ts:77-86` |

### 1.2 缺口（跨进程续算缺失的五件事）

1. **retry 轨迹不在 transcript 权威序列**：重试进度**已** best-effort 落盘于 `router-events.jsonl`（gateway 事件钩子），但该文件可丢（appendFileSync 异常静默）、不参与重放/审计投影、无 policyKey、无恢复语义；`request_header` 快照不含 retryId/policyKey/attempt。另：`RetryStateTracker`（`retryState.ts:66`）为**死代码**——全 src 无使用点，重试调度实际由 `streamModel` 内联逻辑承担。
2. **请求级中断无检测**：`findOpenTurn` 只做 turn 级判定（`ACTIVITY_ENTRY_TYPES`：accepted_input/assistant_message/tool_result_message/durable_message/request_header/injected_context），无「request_header 已落、响应未到」的请求级孤儿识别——**请求粒度**的断点（T4 目标原话的 step 维度）目前不可见。
3. **无任务级重启扫描**：gateway 启动时仅有孤儿 tool-results 目录清理（`ToolResultsCleanup`，`createLocalGateway.ts:422-427`）；孤儿 turn 合成只在会话被激活时触发。**没有「启动时枚举所有会话 → 识别中断任务 → 重新驱动 AgentLoop」的机制**。
4. **resume 不自动续跑**：`resumeAgentSession` 只重建状态 + 合成收尾；中断 turn 被判为 `interrupted` 后**任务即死**，用户须手动再发一条消息才能继续——「崩溃后自动续算到完成」不成立。
5. **投影对「中断→续算成功」无收敛语义**：`TranscriptReplay` 对**每个** `turn_result` 都 push `turn_completed` 事件并 merge usage（无 last-wins/supersede，`TranscriptReplay.ts:98-109`）——同 turn 若先后落 interrupted 与 completed 两个结果，重放会双发 `turn_completed`、usage 双计。**本计划 v0.2 通过「先判定后 resume + 续算路径跳过合成」保证同 turn 始终至多一个 `turn_result`，从根上规避该冲突（见 §2.0 前提 1/2）。**

### 1.3 与既有机制的边界

- **与 `resumeAgentSession` 的关系**：续算**复用** resume 的状态重建（transcript → 重放 → 会话对象），新增 `skipInterruptedSynthesis` 选项（§2.0 前提 2）；孤儿收尾语义保留（作为不续算 turn 的兜底）。
- **与 `router-events.jsonl` 的关系**：T-A 把重试轨迹从该 best-effort 文件**升级**为 transcript 权威序列（单一事实源）；首期两处并存（router-events.jsonl 保留为网关诊断日志，transcript 为权威），风险见 §2.5-7。
- **与 always-on 的关系**：phase4 判定「重启扫描续算属 always-on 范畴」（§9.5）。但既有 always-on（`src/always-on/`）只管理 discovery 计划/工作周期，**没有 agent 任务级重启恢复**；本计划在 `src/session/resume/` 下实现任务级扫描器，经 gateway 启动点接线，互不干扰。
- **与 `BackgroundTaskRuntime` 无关**：后者管理 C5 后台 bash 进程（detached spawn + TaskOutputStore），无 agent 循环，不属本计划范围。

---

## 2. 改动

### 2.0 设计前提（P0 决策，先于任务落地）

审阅确认以下四前提必须先定，否则实施会撞 append-only 日志与 resume 入口的既有语义：

1. **「先判定、后 resume」的顺序**：`TaskResumeScanner` 先 `readTranscript` + `findOpenRequest/findOpenTurn` 判定是否可续算；**判定可续算 → 跳过孤儿合成**；判定不可续算 → 沿用现状合成收尾。**同一 turn 至多一个 `turn_result`**（续算成功落 completed、一直未成最终合成 interrupted），`TranscriptReplay` 零改动。
2. **`resumeAgentSession` 增加 `skipInterruptedSynthesis?: boolean`**（默认 `false` 保持现状；续算路径传 `true`，仅跳过合成、其余重建逻辑不变）。
3. **续算 = 重算断点请求，请求体从当前状态重建（不可逐字节重发）**：`request_header` 快照只有 digest（`TranscriptEntry.ts:208-221`），**不含请求体**；续算驱动 = resume 后让 AgentLoop 以最新状态重新组装请求（等效重算断点请求），而非重发快照。上下文 = `replayTranscriptEntries` 投影产物（压缩后消息按 `findLastCompactBoundaryIndex` 语义，`TranscriptReplay.ts:52`）。
4. **部分响应断点首期红线**：模型消息流式落盘（`AgentLoop.ts:761/807/1367`、abort 残片 `1635-1654`），崩溃断点常见形态是「request_header + 部分 durable_message 已落、无 turn_result」。append-only 无法删除已落残片，重发后投影会混杂新旧响应——**首期 (b) 形态不自动续算**（沿用收尾 + UI 提示「请求中断于响应中段，请手动重发」），仅 (a) 形态（请求完全未响应，`request_header` 后无任何 durable 消息）自动续算。部分响应续算的投影收敛（请求级作废语义）列为二期。

### 2.1 T-A：重试调度持久化（retry 轨迹进 transcript 权威序列）

**目标**：把重试轨迹从 best-effort 的 `router-events.jsonl` 升级为 transcript 条目（可审计、可重放、跨重启可重建），并显式化 `policyKey`。

| 改动 | 位置 |
|---|---|
| 新条目类型 `retry_schedule`（log-only：重放投影跳过，与 `request_header` 同等待遇；**不**进 `ACTIVITY_ENTRY_TYPES`——重试轨迹不驱动 turn 判定） | `src/session/transcript/TranscriptEntry.ts`、`TranscriptReplay.ts`（log-only 集合）、`TranscriptWriter.ts` / `JsonlTranscriptWriter.ts` / `InMemoryTranscriptWriter.ts`（`recordRetrySchedule`） |
| 接线点：gateway 事件钩子（`createLocalGateway.ts:639-652`）在 `sati_router_retry_progress` 到达时，除 appendFileSync/broadcast 外，按 `event.sessionId` 查 per-session transcript writer 并 `recordRetrySchedule`（事件含 retryId/attempt/reason/provider/model，补 policyKey 后落盘） | `src/cli/createLocalGateway.ts`（事件钩子）、`TurnRunner`/session 上下文取 writer |
| `policyKey` 定义：provider.retry 重试策略参数指纹（baseDelayMs/maxDelayMs/jitter/streamMaxRetries/requestMaxRetries 的稳定 hash）；provider 无显式 retry 配置时恒为 `default`（最常见——四元组此时退化为三元，文档显式接受该降维） | `retry_schedule` 条目字段 |
| `RetryStateTracker` 处置：死代码，二选一——删除，或接入为 `RetryJournal`（`record()` 落 transcript + `restore(entries)` 重建调度表，供诊断/审计）。倾向**删除**（retry 进度已由事件链路承载，tracker 无消费方） | `src/model/streaming/retryState.ts` |

**关键决策**：重试轨迹进 transcript 而非依赖 `router-events.jsonl`——与「事件日志是唯一权威」的项目纪律一致；`request_header` 快照**不**扩展（避免破坏既有对拍器），retryId/policyKey 由 `retry_schedule` 独立承载，两序列经 `(turnId, sequence)` 关联。

### 2.2 T-B：请求级孤儿检测（step 粒度断点，含部分响应红线）

**目标**：识别「request_header 已落、响应未到」的请求断点，按 §2.0 前提 4 分形态处置。

| 改动 | 位置 |
|---|---|
| `findOpenRequest(entries)`：返回最后一个开放请求及其形态——(a) `request_header` 后无任何 durable 消息（**可续算**）；(b) `request_header` 后已有部分 durable 消息但无 `turn_result`（**首期不续算**，红线）；另返回 (turnId, provider, model, sequence) | `src/session/transcript/interruptedTurn.ts`（或新 `interruptedRequest.ts`） |
| 判定组合：turn 级开放且 (a) → 续算登记；turn 级开放但 (b) 或仅工具结果后崩溃（无 open request）→ 沿用 `synthesizeInterruptedTurn` 收尾（现状兜底） | 同上 |

### 2.3 T-C：任务级重启扫描 + 续算驱动（核心）

**目标**：gateway 启动时枚举所有会话，识别 (a) 形态中断任务并自动续算到完成，不重复副作用、不重放已完成 step。

**新模块** `src/session/resume/TaskResumeScanner.ts`：

```text
TaskResumeScanner.start()          // gateway 启动点接线（与 ToolResultsCleanup 并列，异步不阻塞）
│  listProjectSessions()           // 全部 projectKey 的主会话 chatDir（mtime 快速失效）
│  per-session: readTranscript()
│    findOpenTurn() / findOpenRequest()   // 判定中断与断点形态（§2.0 前提 4）
│    → (a) 且无审批挂起 → 登记 (sessionId, turnId, retryId)
│    → (b)/仅开放 turn/审批挂起 → 沿用 synthesizeInterruptedTurn 收尾
└  per 登记项：
     resumeAgentSession({ skipInterruptedSynthesis: true })   // 复用状态重建，跳过合成
     校验 maxSeq CAS（乐观锁：登记后 transcript 未被并发写入）
     驱动 AgentLoop 重新走一轮（等效重算断点请求）→ 落 turn_result

（登记集合持久化：幂等键 (sessionId, turnId, retryId)，扫描记录落 `.sati/resume-journal.jsonl`——
 扫描中途崩溃不重复续算；transcript 出现新 turn_result 即视为已接管/已完成。
 retryId 来源：断点请求关联的 retry_schedule 条目（T-A）；无则按 createRetryId(provider, model, turnId) 生成，
 保证同断点跨扫描稳定）
```

| 改动 | 位置 |
|---|---|
| `TaskResumeScanner`（枚举/判定/登记/驱动 + resume-journal 幂等） | `src/session/resume/TaskResumeScanner.ts`（新） |
| `resumeAgentSession` 增 `skipInterruptedSynthesis` 选项（§2.0 前提 2） | `src/session/resume/resumeAgentSession.ts` |
| **CAS 为新增机制**（现状 `JsonlTranscriptWriter` 无并发写保护，只有 `restoreState` 恢复写入序号）：续算驱动前重读 transcript 校验 `maxSeq` 未变；变化即放弃（用户已接管） | `JsonlTranscriptWriter.ts` / 扫描器 |
| 审批挂起跳过：续算登记前查询 gateway approval 状态（`GatewayApprovalBus` 内存态）；挂起中的 turn 不自动续算（仅收尾 + UI 提示「有挂起审批，请人工处理」） | `src/cli/createLocalGateway.ts` 接线、gateway approval API |
| 接线：gateway 启动异步扫描（`void (async () => …)()` 模式，与 MCP 启动一致）；续算过程经既有 `AgentEvent` 透出，UI 可见「任务已从断点恢复」 | `src/cli/createLocalGateway.ts` |

**续算语义（显式化）**：续算 = 重新计算断点请求（模型输出非确定，重算即新结果）；**已落盘的副作用不重放**（工具结果以 `tool_result_message` 为唯一事实源），已完成的 step 不重发。**已知边界**：工具执行本身非原子——「工具已执行、结果未落盘」时崩溃，重算会重复执行该工具（与 dsh 同款 durable 边界语义，无法从日志区分，见 §2.5-6）。

### 2.4 T-D：配置、门禁与成本控制

| 改动 | 说明 |
|---|---|
| `SATI_TASK_RESUME_ENABLED`（env，默认开） | 开关；`0` 时启动扫描仅做孤儿收尾（现状行为不变） |
| 续算门禁：仅「明确标记可续算」的任务自动续算（后台任务/工作流 run，session 元数据标记）；普通对话会话中断只收尾不自动续跑（避免意外消耗 token）；**审批挂起的 turn 一律不自动续算**（§2.3） | `SessionMetadataStore` / `session_metadata` 条目 |
| （删除 v0.1 的 `SATI_CHECKPOINT_EVERY_N_STEPS`：Sati 已「写入即落盘」、`flushCheckpoint` 为 no-op，无批写可刷——该配置无作用对象） | — |

### 2.5 风险与注意事项

1. **续算重发 ≠ 幂等输出**：模型输出非确定，断点请求重发可能产生不同响应——这是**有意的**（续算语义 = 重算断点请求），副作用幂等靠「工具结果取自 transcript」保证，二者必须分开表述（文档/注释中显式化）。
2. **上下文重建不可逆**：续算点之前的消息若已被压缩（control_boundary），重建按压缩后消息（`findLastCompactBoundaryIndex`，`TranscriptReplay.ts:52`）——与 resume 现状一致（shadowedRanges 恢复路径），首期不做「解压重放」。
3. **并发竞态**：续算驱动与用户手动提交可能并发；以 resume-journal 幂等键 + transcript maxSeq CAS 收敛，CAS 失败即放弃本次续算（用户已接管）。
4. **checkpoint IO 成本**：写入即落盘已无写后缓冲，无新增刷盘负担（v0.1 的每 N 步配置已删除）；性能回归用 llm-replay fixture 度量。
5. **误续算成本**：(a) 形态判定依赖「request_header 落盘即请求发出」的近似——实际可能未发出或已发出未响应；重发可能重复消耗一次 API 调用；无法确定性区分，接受该成本（与 dsh 同款 durable 边界语义）。
6. **工具执行非原子**：「工具已执行、结果未落盘」崩溃 → 重算重复执行该工具（副作用重复）。日志无法区分「已执行/未执行」；首期接受（与 dsh 一致），如需消除需工具级幂等键（二期）。
7. **双轨落盘不一致**：T-A 后 retry 轨迹同时在 `router-events.jsonl`（best-effort）与 transcript（权威）——两处写入失败容忍度不同，诊断时以 transcript 为准；router-events.jsonl 保留为网关诊断日志。
8. **启动扫描开销**：会话枚举 readdir 轻量 + 每会话读 transcript 判定；快速失效（mtime 集合未变即跳过）控制规模；扫描异步、不阻塞 gateway 启动。
9. **扫描范围限制**：首期只扫主会话 chatDir（子代理 `subagents/` 不独立扫描，随主会话重放恢复；子代理上下文事件在 T-A 接线时按 `turnId` 归属判断跳过——子代理 turnId 与主会话不同，避免错位落盘）。

---

## 3. 验收

### 3.1 功能验收（每任务专项）

| 项 | 验收标准 | 对应改动 |
|---|---|---|
| T-A | 触发重试后 transcript 出现 `retry_schedule` 条目（含 retryId/policyKey/attempt），与 gateway 事件钩子同时可见；**重启后**从 transcript 重建调度表，retryId 与崩溃前一致（跨重启稳定）；log-only 投影不进入模型可见消息；子代理上下文事件不落主会话 | 2.1 |
| T-B | 手工构造 (a) 形态 transcript（request_header 后无 durable）→ `findOpenRequest` 判定可续算（返回 turnId/provider/model/sequence）；(b) 形态（request_header + 部分 durable）→ 判定不续算；工具结果后崩溃（无 open request）→ 仍走 interrupted 收尾 | 2.2 |
| T-C | **fixture 驱动续算**：构造 (a) 形态中断 transcript → `TaskResumeScanner.start()` → 自动续算至 `turn_result` 落盘；**不重复执行**已 checkpoint 的工具副作用（spec 断言工具结果取自 transcript，无第二次执行）；已完成 step 不重发（请求计数断言）；**同一 turn 至多一个 turn_result**（投影单发 `turn_completed`、usage 不双计） | 2.0/2.3 |
| T-C | 同 turn 并发提交（用户手动接管）→ CAS 失败放弃续算、无重复 turn_result；扫描中途崩溃 → resume-journal 幂等键防重复续算；`SATI_TASK_RESUME_ENABLED=0` 时行为与现状完全一致 | 2.3/2.4 |
| T-D | 普通对话会话中断 → 仅 interrupted 收尾不自动续跑；后台任务/工作流 run → 自动续算；审批挂起中的 turn → 不自动续算（收尾 + 提示） | 2.3/2.4 |

### 3.2 回归

- resume 语义不变：`resumeAgentSession` 既有 spec 全绿（默认 `skipInterruptedSynthesis: false` 路径孤儿合成、metadata 恢复、投影闭合）；新增 `skipInterruptedSynthesis: true` 用例；
- 孤儿 turn 合成仍工作（`findOpenTurn` 语义不变，新增 `findOpenRequest` 不改变既有判定）；
- `request_header` 对拍器（`SATI_VERIFY_REQUEST_RECONSTRUCTION`）不受影响——快照结构未扩展；
- llm-replay 既有 fixture（`deepseek-v4-flash-basic` + 脚本录制 fixture）全绿（续算路径不新增重放断言——重放请求键含 messages，续算重发不与之匹配是已知约束，互不干扰）；
- `router-events.jsonl` 既有 appendFileSync 行为不变（T-A 为旁路新增，不删既有写）；
- 全量后端测试 `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check` 通过。

### 3.3 行为验证（人工）

- 真实会话跑一轮，中途 `kill -9` gateway 进程 → 重启 `pnpm server` → 观察 (a) 形态任务自动续算、UI 出现恢复提示、transcript 含 `retry_schedule` 与续算轨迹、`turn_result` 唯一；
- (b) 形态（响应中段 kill）：重启后不自动续算，UI 提示手动重发；
- 长任务（专利工作流）中途重启 → 续算不重复写产物文件（产物 mtime 不变）。

---

## 4. 结果（实施记录）

> 状态：**已实施（2026-08-16）**。与 v0.2 的偏差见 §4.2 实证修正。

### 4.0 新增文件与修改清单

| 文件 | 用途 |
|---|---|
| `src/session/resume/TaskResumeScanner.ts`（新） | 启动扫描 + (a) 形态判定 + 续算 turn 提交（T-C） |
| `tests/session/transcript/retry-schedule.spec.ts`（新） | T-A/T-B 单测 9 用例 |
| `tests/session/resume/task-resume-scanner.spec.ts`（新） | T-C 扫描器 fixture 测试 7 用例 |
| `src/session/transcript/TranscriptEntry.ts` | `retry_schedule` 条目类型 + union（T-A） |
| `src/session/transcript/TranscriptWriter.ts` / `JsonlTranscriptWriter.ts` / `InMemoryTranscriptWriter.ts` | `recordRetrySchedule`（T-A） |
| `src/session/transcript/TranscriptReplay.ts` | `retry_schedule` log-only 跳过（T-A） |
| `src/session/transcript/interruptedTurn.ts` | `findOpenRequest` + `OpenRequest` 类型（T-B） |
| `src/model/streaming/retryState.ts` | `createPolicyKey` + `normalizeRetryReason`（T-A） |
| `src/session/resume/resumeAgentSession.ts` | 返回 `writer`（T-A 接线用） |
| `src/session/index.ts` | 导出扫描器 |
| `src/env.ts` | `TASK_RESUME_ENABLED` 键（T-D） |
| `src/cli/createLocalGateway.ts` | `sessionWriters` 登记 + 事件钩子落 `retry_schedule` + `runTaskResumeScan` 启动接线（T-A/T-C/T-D） |
| `docs/event-producer-consumer.md` | 重新生成（submitTurn 流消费点 26→27） |

### 4.1 任务清单（勾选，按实证修正后的实施形态）

```text
[x] T-A 重试轨迹进 transcript（retry_schedule 条目 + gateway 事件钩子接线 + policyKey/normalizeRetryReason + RetryStateTracker 保留）
[x] T-B 请求级孤儿检测（findOpenRequest，(a)/(b) 形态判定）
[x] T-C TaskResumeScanner（submitTurn 新 turn 续算 + submittedKeys 防重 + 审批挂起跳过 + gateway 启动接线）
[x] T-D SATI_TASK_RESUME_ENABLED（默认开）；删除每 N 步配置
[x] 集成 spec（(a) 形态 fixture 续算、(b) 跳过、审批挂起跳过、防重、turn 闭合不提交）
[x] 回归（resume/孤儿收尾/request_header 对拍/llm-replay 全绿）
[x] 文档：phase4 §9.5 遗留注意第 1 条标记已落地
```

### 4.2 实证修正（v0.2 → 实施）

| # | v0.2 方案 | 实施调整 | 原因 |
|---|---|---|---|
| 1 | 续算 = `skipInterruptedSynthesis` + 同 turn 重算断点请求 | **续算 = gateway.submitTurn 提交新 turn**（`RESUME_TURN_MESSAGE` 带 `[system-resume]` 标记）；旧开放 turn 由 resume 默认合成 interrupted 收尾，新 turn 基于 transcript 重建上下文继续 | 同 turn 至多一个 turn_result 天然成立，`TranscriptReplay` 零改动、resume 入口零改动；副作用不重复为弱保证（上下文含已完成 tool_result，与 resume 后手动继续一致） |
| 2 | `RetryStateTracker` 删除 | **保留** | 有测试覆盖（`tests/model/streaming/retry-state.spec.ts`），非死代码；T-A 增量由 retry_schedule 条目承载 |
| 3 | maxSeq CAS（新增机制） | **不需要** | 续算经 submitTurn 走 gateway 正常路径（beginTurn 有 session_busy 保护）；扫描仅启动时 fire-and-forget 一次，无并发写窗口 |
| 4 | resume-journal 幂等（.sati/resume-journal.jsonl） | **不需要** | 防重靠 transcript 状态（续算 turn 自身成为 open turn 时由下次扫描推进）+ 内存 submittedKeys（本次启动内） |
| 5 | policyKey = provider.retry 参数指纹 | **首期恒 `default`**（`createPolicyKey()` 无参） | 事件载荷不含 provider.retry 配置；真实指纹待事件载荷扩展（文档已接受该降维） |
| 6 | 扫描范围 = 全部 projectKey | **首期 fallbackProjectRoot 单项目** | 默认单项目场景；多项目循环扫描留二期 |
| 7 | 续算门禁 = session 元数据标记（仅后台任务/工作流） | **简化为 env 开关**（`SATI_TASK_RESUME_ENABLED`） | session 元数据无任务身份标记维度；所有 (a) 形态会话自动续算 |

### 4.3 验证结果

- pnpm typecheck ✅ 0 错误（含 edgeclaw-memory-core）
- pnpm lint ✅ 0 error（1 条阶段二遗留 UI 导入顺序警告，与本次无关）
- pnpm format:check（biome）✅
- 全量后端测试 `pnpm test` ✅ 2792 pass / 0 fail / 3 skipped（新增 16 用例：T-A/T-B 9 + T-C 7）
- `pnpm gen:event-matrix --check` ✅（重新生成：submitTurn 流消费点 26→27，来源为扫描器的 `for await submitTurn`）