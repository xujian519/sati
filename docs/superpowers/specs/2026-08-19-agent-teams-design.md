# 团队编排层（Team Orchestration Layer）— 设计文档

日期：2026-08-19
状态：已与用户逐节确认（架构总览 / 核心机制 / 工具面+面板 / 错误处理+验证）

## Context

调研（`docs/community-agent-teams-research.md`，2026-08-19 入库）确认：Sati 的"硬地基"（durable 会话、事件矩阵、HITL 审批、checkpoint 续跑、工具契约、渠道接入）比 dsh-agent-teams 更厚，缺的是**上层的团队编排语义**——可唤醒的持续成员、共享任务池的自动认领、任务 attempt 能力与安全转派、成员邮箱直连、团队级可视化。dsh-agent-teams 与 Claude Code Agent Teams 提供了经过实战打磨的协议语义（队长/成员/任务池/attempt 能力/邮箱/归档），而非具体代码——把该协议映射到 Sati 的地基上，即获得"专利工作流中的多角色并行协作"能力。

**已确认决策**：
1. **范围**：全量（含 durable 成员底座，不砍跨重启恢复）
2. **成员会话模型**：独立成员会话——转录即真源，followup = 从转录重建 + 提交 turn（与 always-on/cron 提交 gateway turn 同构）
3. **首发用例**：专利多角色并行（技术专家 / 事实调研员 / 规则调研员 / 检索员 / 分析师 / 撰写人 / 审查员，7+ 角色），需扩展角色配置
4. **活动面板**：右上角浮层（popover）+ 手写 SVG 曲线 DAG（hover 上下游高亮）
5. **DAG 实现**：手写 SVG + 自研分层布局，零新增依赖
6. **验收**：故障注入验证矩阵 + 真实专利案例 E2E + 面板全程可视化

## 一、架构总览

新模块 `src/agent/team/`（protocol/ + runtime/ + storage/ 结构，遵循现有模块惯例）：

```
src/agent/team/
├── protocol/        # TeamEvent 契约 + 团队/任务/成员类型
├── member/          # 成员会话运行时（注册/唤醒/冷恢复/路由快照）
├── taskpool/        # 任务池（状态机 + attempt 并发安全）
├── mailbox/         # 成员邮箱（投递租约 + 冷恢复重投）
├── scheduler/       # 事件驱动调度器（idle 边 → 原子认领）
├── storage/         # teams.db（node:sqlite + db-version 迁移）
└── index.ts         # barrel
```

工具面：10 个 `team_*` 工具（`src/tool/builtin/team*.ts`，domain: team）。
UI：`ui/src/components/team-panel/`（feature-folder）。

**复用不重造**（既有设施直接承接）：

| 需求 | 复用 |
|---|---|
| 成员会话执行 | gateway.submitTurn 整条链（TurnRunner + PatentOutputGate + 事件广播），与 always-on/cron 同构（`src/agent/turn/TurnRunner.ts`，`src/gateway/`） |
| 转录即真源 | JsonlTranscriptWriter（`src/session/transcript/`），成员转录独立子目录（见 L0） |
| 冷恢复重放 | TaskResumeScanner 的 `restoreState`/`replayTranscriptEntries` 思路（`src/session/resume/`） |
| 成员回合事件 | 成员内部复用 AgentEvent 流（`subagent_*` 执行语义），对外映射为 TeamEvent 广播 |
| LLM 路由快照 | `resolveModelInfo`（`src/model/resolveModelInfo.ts`） |
| 权限 | PermissionRuntime + ToolGuard 链 + visibleDomains 裁剪（`src/permission/`、`src/agent/sub/scopeTools.ts`） |
| 审批冒泡 | GatewayApprovalBus + 新增跨会话转发层（见 L0）+ 现有审批卡片 |
| 事件推送 | gateway 广播 `broadcastToSessionWatchers`（`ui/server/websocket/broadcast.js`） |
| 成员-角色映射 | SKILL.md role 注册表（成员注册机制）+ WORKER_ROLE_MAP 仅作映射参考（`src/patent/worker-contract.ts:244`） |

**一回合数据流**：队长 `team_create_task` → teams.db（磁盘真相）→ 成员回合结束 emit `member_idle` → 调度器 withTeamLock 原子认领 → `beginTaskAttempt(attemptId)` 写盘 → 邮箱投递 + followup 唤醒成员 → 成员从转录重建跑新一轮（独立会话）→ `team_update_task(attemptId)` 落盘 → 依赖解锁 → 下一轮认领。全程 TeamEvent 进事件矩阵 + gateway 广播 → UI 浮层渲染。

## 二、L0 · durable 成员底座（最大新原语）

**成员 = 独立持久化会话**（与主会话平级，非 sidechain）：

- **创建**（`team_add_member`）：成员记录写入 teams.db（memberId、角色 slug、LLM 路由快照），首次唤醒创建转录。**转录隔离**：成员转录写独立子目录（项目 chatDir 下 `members/<memberId>.jsonl`，`listProjectSessions` 不枚举子目录）——TaskResumeScanner 扫不到成员转录，成员的冷恢复由团队调度器独家负责，两个冷恢复机制互不打架
- **唤醒**（followup）：从成员转录重建消息列表 → 追加 followup 消息 → 构造成员 sessionKey 的 `gateway.submitTurn`（与 TaskResumeScanner 的 `submitResumeTurn` 接线同构）跑一轮。**不直接拼 AgentLoop**——必须走 submitTurn 整条链，保住 TurnRunner 内的 PatentOutputGate（审批门禁）、事件广播与 usage 记账。turnId 单调递增（`${memberId}-t{n}`，与现有 `${subagentId}-t0` 格式同构）
- **LLM 路由快照**：创建时 `resolveModelInfo` 解析 provider/model/reasoningEffort 持久化；冷恢复时同步读取恢复同一路由；跨路由用目标模型默认档（不继承不适用 effort）
- **冷恢复**：gateway 启动时调度器扫描 teams.db——成员状态从磁盘重建（idle/working）；stranded 任务（claimed/in_progress 但成员 idle 或不在）→ invalidate 旧 capability → 生成新 attempt 重新认领
- **退休 deny-list**：`team_remove_member` 记录到 `retired_members`，拦截冷恢复意外复活；转派 quiesce 与归档也复用此表拒绝迟到 update（见 L2）
- **成员回合事件**：成员回合内部仍是 AgentEvent 流（subagent_* 执行语义保留），回合结束（无 pending followup）由调度器映射为 TeamEvent `member_idle` 广播——不在 subagent_* 事件面上扩展语义，避免"一次性 fork"与"持续成员"两套语义混用
- **审批冒泡转发层**（新增组件，非纯复用）：GatewayApprovalBus 按 sessionKey 分桶，成员挂起的审批不会自动出现在队长 UI。新增转发层：成员 approval_pending → 转发到队长会话 watcher（审批卡片标注成员身份）→ 队长 approve/reject 经 `approvalDecide` 回写成员 sessionKey。M1 随底座落地（无审批场景可先空转）

## 三、L1 · 持久化 + 事件面

**teams.db**（`~/.sati/teams/teams.db`，node:sqlite `DatabaseSync` + `db-version` 迁移模式，参照 `src/knowledge/shared/db-version.ts`）。知识库 knowledge.db 语义为只读消费，团队状态独立成库。

表结构（首版最小集）：
- `teams`（id、name、captainSessionId、maxConcurrentMembers、createdAt、archivedAt?）
- `members`（id、teamId、roleSlug、modelRoute JSON、status、sessionId）
- `tasks`（id、teamId、title、description、status、dependencies JSON、assigneeId?、attempt、attemptId、handoffId?、blockedByCount、maxAttempts、createdAt、updatedAt）
- `messages`（teamId、from、to、body、deliveryClaimedAt?、deliveredAt?、readAt?）— 邮箱
- `retired_members`（sessionId、memberId、reason）— 冷恢复 deny-list / quiesce 迟到写拒绝

**TeamEvent 事件族**（`src/agent/team/protocol/events.ts`，进事件矩阵门禁）：`team_created` / `member_added` / `member_removed` / `member_status` / `member_idle` / `task_created` / `task_claimed` / `task_updated` / `task_completed` / `task_failed` / `message_delivered` / `team_archived` 等。全部事件入事件矩阵（`pnpm gen:event-matrix` 重新生成 + `check:event-matrix` 门禁），gateway 广播按会话扇出。**gateway 协议不升版**：TeamEvent 复用现有事件广播通道（agent_event 帧），无新增方法，协议保持 1.3。

**归档而非删除**：`team_delete` 前先 quiesce 全部活跃成员（cancel 当前回合 + retired 标记，同转派路径），随后把团队及任务/消息 move 到 archive（表内 `archivedAt` 标记或归档表），历史可回放复盘。

## 四、L2 · 任务池协议内核

**状态机**：`pending → claimed → in_progress → completed | failed | cancelled`，合法转移表 + 终态不可变（参照 `src/patent/plantask.ts` 的 TRANSITIONS 白名单模式）。依赖未满足的 pending 任务不可认领（blockedByCount > 0）。

**attempt 能力机制**（dsh 最硬核设计，存储换 SQLite）：
- 每次执行携带单调 `attempt` 计数 + 唯一 `attemptId`；`team_update_task` 必须携带当前 `attemptId`
- **转派/重试**：先 `invalidateTaskAttempt`（清 attemptId、生成 `handoffId`、状态回 pending）→ cancel 旧成员当前回合 + 写入 retired 标记（其后续 update 一律拒绝）→ 新 attempt 才开启。**quiesce 有收敛保证**：旧成员死循环不安静时超时（默认 60s）强制开启新 attempt，迟到更新由 stale-attempt 拒绝兜底——不依赖"旧成员主动安静"

**并发安全**：per-team 内存锁（promise 链串行化，`withTeamLock`，参照 dsh scheduler 的原子认领）。Sati 单 gateway 进程常驻，无 dsh 的多进程文件不一致问题；SQLite 事务兜底持久层一致性。

**事件驱动调度器**（非轮询，`member_idle` 事件 + 任务图变更双触发）：
- 每次触发在锁内重读最新状态，找该成员的 owned open task（冷恢复重试）或 next ready task（依赖已满足，优先指派给自己的、其次未指派的）→ `beginTaskAttempt` 写盘 → 邮箱投递 + followup 唤醒
- 唤醒失败回滚：仅回滚自己那次派发的 ticket（校验 attemptId），不覆盖并发队长的转派
- **消息投递优先于新任务**：先 flush 未读邮箱（投递租约 60s 内不重复投递），成功才 ack；损坏行跳过不阻塞团队
- **并发闸**：认领受 `teams.maxConcurrentMembers`（默认 4）限制，超闸任务保持 pending 排队——token 成本可控，不只靠"建议 3-5 成员"
- **队长离线**：队长会话关闭时调度暂停认领（在途成员回合跑完即停）；队长会话恢复后调度自动恢复

## 五、L3 · 工具面 + 角色注册表

**10 个 `team_*` 工具**（domain: team，全部带 outputSchema；`requireOutputSchema` 已强制）：

| 工具 | 可见性 |
|---|---|
| `team_create` / `team_add_member` / `team_remove_member` / `team_create_task` / `team_claim_task` / `team_reassign_task` / `team_delete` | 仅队长 |
| `team_update_task` / `team_send_message` / `team_status` | 队长 + 成员 |

- `team_create_task` 支持 `dependencies` + `assignee`
- `team_claim_task` 仅队长：语义 = 指派任务给指定成员（提前锁定 assignee）。成员侧不暴露——认领由调度器独家负责，消除手动 claim 与自动认领的双路径竞态（dsh 是纯手动 claim；Sati 自动为主，队长 claim 仅作指派）
- `team_reassign_task` `assignee=captain` 即队长接管
- `team_send_message` 拒绝冒名 from
- 成员工具面按角色 domain 裁剪（沿用 `visibleDomains`/`hiddenDomains`，scopeTools.ts 逻辑）；`team_*` 管理类工具在成员侧隐藏

**协议即提示词**：团队使用协议注入 system prompt 段（建队→拉人→拆任务→调度→监控→转派→归档）；成员 persona 自包含（工作规则写死：claim → 带 attemptId update → 报告 → 空闲等待）。"真相源在存储、不在模型回执"。

**成员角色注册表**：扩展 SKILL.md `type: role` 体系（`registerRoleDefinition` + `ROLE_DEFINITIONS`）。首发 7 角色：**技术专家 / 事实调研员 / 规则调研员 / 检索员 / 分析师 / 撰写人 / 审查员**，与现有 `WORKER_ROLE_MAP`（6 个 defaultPatentWorkers）对齐映射：

| 团队角色 | 现有 worker/角色 | 动作 |
|---|---|---|
| 检索员 | patent-search-commander | 对齐 |
| 分析师 | patent-novelty-analyzer / patent-inventiveness-analyzer | 对齐 |
| 撰写人 | patent-oa-writer / drafting-claims / drafting-spec | 对齐 |
| 审查员 | quality_checker | 对齐 |
| 技术专家 | patent-technical-analyzer | 对齐 |
| 事实调研员 | — | 新增 SKILL.md 角色 |
| 规则调研员 | — | 新增 SKILL.md 角色 |

角色定义 = tools/domains/omitTools/systemPrompt；成员实例参数 = model/reasoningEffort（路由快照）。

**注册机制（两套体系不混用）**：成员角色一律经 SKILL.md `type: role` 注册表注册（`registerRoleDefinition`）——上表「现有 worker/角色」列仅表示对齐关系。WORKER_ROLE_MAP 属专利 workflow 的 worker 契约（`validateWorkerOutput` 语境），不是成员注册机制，只作映射参考不直接复用。

## 六、L4 · 活动面板

**位置与形态**：右上角浮层（`ChatHistorySearchBar` top-4 right-4 定位先例）+ 折叠浮标（团队进度 + 活跃成员点）；展开浮层：团队进度条 + 成员列表（状态/当前任务/未读邮箱角标）+ 紧凑任务 DAG + 归档回放入口。Esc 或点击外部收起。

**DAG 渲染**（手写 SVG，零新增依赖）：
- 布局：longest-path 分层 + 层内拓扑序排列（纯函数，可单测）
- 连线：quadratic bezier 曲线，hover 高亮上下游链（上游/下游节点 + 连线），点击固定、Esc 取消
- `prefers-reduced-motion` 尊重；键盘可聚焦

**数据通道**：gateway 事件推送——TeamEvent 经 `broadcastToSessionWatchers` 按会话扇出。**全部走 `subscribe()` 逐帧通道**，不走 `latestMessage` 单槽（latestMessage 是覆盖语义，7 成员状态突发时会丢帧）；流式噪声过滤逻辑下沉到 team-panel 自己的消费层。**不轮询**（与 dsh 1s 轮询的妥协区别）。

**组件**：`ui/src/components/team-panel/`（view/hooks/types/constants/utils feature-folder），状态管理沿用 Context + useState（无 zustand，参照 `TaskMasterContext` 模式）；i18n 新增 `team.json` namespace（en + zh-CN 双注册，注意 zh-CN 现有 tasks namespace 未注册的坑）。

## 七、错误处理

| 场景 | 处理 |
|---|---|
| 迟到更新 | stale-attempt 拒绝（attemptId 不匹配） |
| 转派竞争 | 全程持锁 + handoffId 校验后才提交 |
| 唤醒失败 | 只回滚自己的 ticket（校验 attemptId），不覆盖并发转派 |
| 模型不守仪式 | 面板如实反映磁盘真相，队长以 status/文件为准汇总 |
| 成员回合失败 | 任务回 pending + per-task `maxAttempts`（默认 3，可配）→ 超限转派/队长接管 |
| 成员死循环 | doomloop_signal 硬断 + repeatToolReminder 软提醒（沿用） |
| 权限 | PermissionRuntime + ToolGuard 链沿用；成员审批经转发层冒泡到队长会话 → 用户审批卡片（标注成员身份） |
| 队长离线 | 调度暂停认领；审批挂起超时（默认 30 分钟）自动转派回队长队列；会话恢复后调度自动恢复 |
| 邮箱损坏行 | 跳过不阻塞团队 |
| 进程重启 | 冷恢复扫描（见 L0） |

## 八、测试与验证

1. **单元测试**：任务状态机转移表（非法迁移拒绝）、attempt 迟到写拒绝、邮箱投递租约、调度器认领顺序（含并发闸/队长离线暂停）、maxAttempts 超限转派、DAG 分层布局纯函数、成员转录与 TaskResumeScanner 的隔离（不被误扫）
2. **故障注入验证矩阵**（`scripts/team-stress-verify.mjs`，dsh 式）：8 成员 × 31 节点多层 DAG + 并发接管/移除 + 迟到写入风暴（50 次）+ 冷重启（4 开放任务）+ 认领竞争（7 路）+ 终态覆盖（40 次）+ 消息突发（42 条）+ 最终归档
3. **真实专利案例 E2E**：申请案 4-7 角色并行（检索→分析→撰写→审查）跑通 + 面板全程可视化 + 归档回放
4. **UI 单测**：浮层组件渲染 + DAG 布局纯函数 + mock gateway 事件（参照 `useChatRealtimeHandlers.test.tsx` 模式）
5. **门禁**：`check:event-matrix`（新 TeamEvent 必须进矩阵，重新生成 `docs/event-producer-consumer.md`）；llm-replay fixture 在 team_* 工具 schema 稳定后重录（⚠️ inputSchema 改动破坏请求键）

## 九、里程碑

| 里程碑 | 内容 | 验证出口 |
|---|---|---|
| M1 | L0 durable 成员底座（创建/唤醒/冷恢复/路由快照/转录隔离/审批转发层 + 单测） | 成员会话冷恢复单测 + 与 TaskResumeScanner 的隔离测试（成员转录不被误扫）+ 手动续聊 |
| M2 | L1+L2 协议（任务池/attempt/邮箱/调度 + teams.db + TeamEvent） | 单测 + 故障注入矩阵 |
| M3 | L3 工具面 + 角色注册表（7 角色对齐/新增 + 提示词协议） | 工具单测 + llm-replay 重录 |
| M4 | L4 活动面板（浮层 + SVG DAG + 事件推送 + i18n） | UI 单测 + 真实案例 E2E |

每里程碑独立可合并，依赖串行（L0→L1→L2→L3→L4）。

## 十、风险与边界

- **durable 原语是全新概念**（最大工程风险）——M1 先行验证，失败则回退方案：成员退化为"一次性 fork + 任务状态持久化补偿"
- **LLM 不守仪式**——已设计存储真相容忍，不引入"模型必须走工具仪式"的强依赖
- **token 成本**：成员并行 = 多会话消耗，面板明示用量；成员数上限建议 3-5（dsh 最佳实践）
- **不照抄项**（调研文档 §5）：文件级状态存储（Sati 用 SQLite）、成员默认全工具（沿用域裁剪 + ToolGuard）、任务状态机照搬（以 Sati 契约为准）、1s 轮询浮层（走事件推送）、DSH 式插件宿主层（Sati 已有自己的插件系统）

## 参考

- `docs/community-agent-teams-research.md`（主调研报告，含差距分析与可借鉴点清单）
- `docs/research/dsh-ecosystem-research.md` / `multiagent-frameworks-research.md` / `agent-os-open-source-research.md`
- NanmiCoder/dsh-agent-teams（v0.1.7，MIT）— 协议语义来源
- Claude Code Agent Teams 官方文档 — 权限冒泡/计划审批参照
