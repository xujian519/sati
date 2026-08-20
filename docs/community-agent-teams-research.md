# 开源社区多智能体团队项目调研：dsh-agent-teams 及同类项目对 Sati 的可借鉴性分析

> 调研日期：2026-08-19
> 调研对象：[NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams)（v0.1.7，MIT）+ 同类开源项目（多智能体编排框架 / Agent OS / DSH 生态）
> 目标读者：Sati 核心维护者
> 结论摘要：dsh-agent-teams 提供了一整套"单会话驱动的多智能体团队协作"协议（队长-成员模型、共享任务池 + 事件驱动调度、attempt 能力机制、成员邮箱、磁盘真相 + Web 活动面板），其**编排协议与容错机制**值得 Sati 借鉴，但**实现底座（durable continuation 子代理）是 Sati 当前不具备的原语**；同类框架提供了任务模型、HITL、持久化、生态等方面的补充参照。详见 §4（可借鉴点清单）与 §5（不借鉴/边界）。

---

## 1. dsh-agent-teams 深度分析

### 1.1 定位与总体架构

dsh-agent-teams 是 DeepSeek Harness（DSH，开源 AI agent 宿主，cordis 插件框架）的一个**宿主平面插件**：把当前 DSH 会话变成一个"队长（captain）"，队长可招募持久成员（durable sub-agents），把目标拆成带依赖的任务，通过 10 个 `agent_teams_*` 工具 + 事件驱动共享调度器协调工作，并在 Web UI 提供实时活动面板。README 的一句话定位："One prompt. A working team."

关键架构特征（与"再造一个 workflow 引擎"刻意区分）：

| DSH 能力接缝 | AgentTeams 用法 |
|---|---|
| `ctx.tools` 注册表 | 注册 10 个 `agent_teams_*` 工具 |
| `ctx.subagents.startContinuable()` | 创建成员：durable 可续聊子代理 + 成员 persona |
| `ctx.subagents.followup()` | 唤醒收件成员（消息进入其下一轮次；可冷恢复） |
| `listChildren()` + `ctx.agents` | 前者发现 durable 成员，后者提供真实 `running/idle/ready` 活动状态 |
| `agent/status` 事件 | 成员进入 idle 后触发共享任务池自动续领与下一轮唤醒 |
| `ctx.systemPrompt.section()` | 注册"AgentTeams 使用策略"提示段（协议即提示） |
| Web server 路由 | 活动面板数据路由 + 静态资产 |
| 文件系统 | 团队状态持久化在 `<workspace>/.agent-teams/<teamId>/` |

数据链路：**工具执行 → 磁盘状态（唯一真相源）→ host 快照路由 → 浮层 1s 轮询渲染**；会话日志同时写入 `agent-teams/*` 事件用于审计/重放/复盘。

### 1.2 持久状态模型（`src/state.ts`，882 行）

```
<workspace>/.agent-teams/<teamId>/
├── team.json            # 团队记录：成员、任务（含依赖）、任务序号
└── inbox/
    ├── captain.jsonl    # 队长邮箱（成员 → 队长）
    └── <member>.jsonl   # 每个成员一个邮箱（JSONL）
```

- **任务状态机**：`pending → claimed → in_progress → completed | failed | cancelled`，每状态只有合法转移表（`TASK_TRANSITIONS`），终态不可变。
- **attempt 能力机制**（核心设计）：每次执行携带单调 `attempt` 计数 + 唯一 `attemptId`。成员更新任务必须携带当前 `attemptId`；转派/重试先 `invalidateTaskAttempt`（清空 attemptId、生成 `handoffId`、状态回 pending），再中断旧成员并**等待其安静（quiesce）**后才开启新 attempt——因此迟到的更新永远无法覆盖新结果（stale-attempt 拒绝）。
- **转派并发安全**：reassign 全程持 per-team 内存锁（promise 链串行化），转派后校验 `handoffId` 未变才提交，防止队长接管与调度器竞争。
- **成员邮箱**：JSONL 每成员一个；消息带 `deliveryClaimedAt`（投递租约，60s 超时后可重试）/`deliveredAt`/`readAt` 三态；损坏行跳过不阻塞整个团队可读。
- **冷恢复**：`agent/status` 事件 + 磁盘状态联动——若 idle/ready 成员仍持有 `claimed/in_progress` 任务（模型中断、进程重启），调度器撤销旧 capability、生成新 attempt 重新唤醒同一成员；转派前中断旧 worker 并等待收敛。
- **退休成员 deny-list**：`retired-members.json` 持久化记录 removed 成员 session id，拦截 `listChildren`/`followup`，防止被意外冷恢复（因为 DSH 的 `interrupt()` 会保留 continuable 会话，上游没有针对性 forget 接口）。
- **归档而非删除**：`agent_teams_delete` 把整个团队目录 move 到 `archive/`（成员、任务依赖图、邮箱完整保留），历史会话可回放复盘。
- **原子写**：同目录临时文件 + rename（Windows EPERM 重试降级为直写，3 次重试 + 50ms 间隔）；目录级 rename 同样重试。
- **key 消毒**：`sanitizeKey` 保留 Unicode 字母数字（CJK 成员名可读可区分），超长截断 + digest。

### 1.3 事件驱动共享调度器（`src/scheduler.ts`，265 行）

与 Claude Code 团队"成员轮询共享任务列表"不同，DSH continuable agent 暴露显式 idle/running 边，因此调度器**关闭循环但不保活轮询**：

- 每个 idle 边（`agent/status` → idle）与每个任务图变更（工具执行后 `kickTeam`）触发一次**原子认领**：`withTeamLock` 内重读最新状态，找该成员的 owned open task（冷恢复重试）或 next ready task（已满足依赖的 pending 任务，优先指派给自己的、其次未指派的），`beginTaskAttempt` 后写盘，再 `deliverToMember`（followup 唤醒）。
- 唤醒失败回滚：仅回滚自己那次派发的 ticket（校验 attemptId），不覆盖并发队长的转派。
- 消息投递优先于新任务：先 flush 未读邮箱（投递租约内不重复投递），成功才 ack。
- 成员状态同步：`agent/status` 事件把成员 status 写回 team.json（working/idle）。

### 1.4 成员生命周期与 LLM 路由（`src/members.ts`，490 行）

- 成员 = 队长的 durable continuable 子代理（`startContinuable` + persona 替换 + `toolFilter.deny` 隐藏队长专属工具）。
- **LLM 路由快照**：成员创建时解析 provider/model/reasoningEffort 并写入 team.json；冷恢复时同步读取（`readTeamSync`，child 设置阶段要求同步）恢复同一路由。成员沿用队长当前 provider/model 时继承队长 reasoning effort；跨路由则用目标模型默认档；显式 `reasoning_effort` 优先（"default" 强制模型默认）。
- 成员 persona 自包含：团队身份、状态文件只读定位、工作规则（claim → 带 attemptId update → 报告 → 空闲等待调度）写死在 persona 里——**协议即提示词**。

### 1.5 工具面（`src/tools.ts`，1160 行）与使用协议

10 个工具：create / add_member / remove_member / create_task（支持 dependencies + assignee）/ reassign_task（`assignee=captain` 即队长接管）/ claim_task / update_task（校验 attempt_id）/ send_message（成员直连，拒绝冒名 from）/ status / delete（归档）。每个工具带 `output` schema + `render`（工具结果渲染），队长/成员按 session 身份做工具可见性裁剪。

使用协议注入 system prompt 段（`promptSectionOrder: 117`）：建团队 → 按角色拉成员 → 拆任务声明依赖 → 共享调度器自动认领唤醒 → 队长监控/引导 → 阻塞先安全转派或接管 → 汇总后 delete 归档。**模型不遵守工具"仪式"（如完成时不 update_task）时，面板如实反映磁盘真相，队长以 status/文件为准汇总**——容错设计刻意允许模型偷懒。

### 1.6 Web 活动面板（`src/client/ActivityPanel.tsx`，730 行）

- body-portal 浮层（右上角），团队创建后自动展开；会话跟随（只显示当前会话的团队）；折叠态小浮标。
- 分段总进度、状态统计、可折叠成员树 + **紧凑任务 DAG**（真实 SVG 曲线连接依赖，悬停/键盘聚焦预览上下游链，点击固定，Esc 取消；选中节点显示负责人/未满足前置/下游解锁信息）。
- 成员行：职业插画头像（8 角色 + 6 动作，状态动作小图带动画，`prefers-reduced-motion` 尊重）、实时状态、任务标签，点击打开成员子会话。
- 数据：`/plugins/dsh-agent-teams/state` 1s 轮询，服务端组装（磁盘真相 + `ctx.agents` 实时活动 + 未读邮箱计数 + `taskVisualState` blocked/open/running/completed + `taskDepthsById` 分层深度）；归档路径 `?archived=1` 回放完整历史。

### 1.7 工程实践亮点

- **验证方法论**（`scripts/stress-verify.mjs` 等 3 个 verify 脚本，共 ~2000 行）：8 成员、31 节点多层 DAG（运行中扩展至 38 任务）的故障矩阵——并发接管/移除、50 次迟到写入风暴、4 个开放任务冷重启、7 路认领竞争、40 次终态覆盖、42 条消息突发、最终归档。多智能体编排代码的正确性靠这种故障注入矩阵背书。
- 双服务键探测兼容（webServer/httpServer 新旧版 DSH）、事件写入前检查 harness 词汇表（不认识的类型跳过）、同步/异步双读路径（child 组成阶段的同步读）。
- 明确记录已知限制（事件驱动非轮询导致队长离线无法冷恢复、单队长单团队、文件级多进程不一致、模型不总是走工具仪式）。

### 1.8 值得注意的边界与取舍

- **不造 workflow 引擎**：复用 DSH 能力接缝，任务 DAG 是模型在工具调用中"涌现"出来的，而非预声明图。
- 一个队长同时只带一个团队（与 Claude Code AgentTeams 一致）。
- 成员拥有完整工具集（bash/fs/web 等），persona 只替换部署默认 persona。
- 状态文件级持久化 + 进程内锁串行；多进程并发编辑同一团队不保证一致。

---

## 2. Sati 现状对照（差距分析）

### 2.1 Sati 已具备的相关能力

| 能力面 | Sati 现状 |
|---|---|
| 子代理 | `agent` 工具（`src/tool/builtin/agent.ts`）+ `subagent_type` 预设 / SKILL.md 角色，`SubAgentSession`（`src/agent/sub/`）fork 一次性运行：子代理跑完一个循环后返回 5 字段报告回流父代理，sidechain 转录 |
| 工作流 | 声明式 workflow（`src/workflow/`：DAG + SafeEvaluator + checkpoint + worker-contract），flexible-plan 阶段级计划，plantask HITL 状态机（以上通用）；专利域 `JsonFileManifestCheckpointStore` 断点续跑（`src/patent/workflow/checkpoint.ts`，`resumeCheckpointId` / `approveStageIds`） |
| 任务 | `src/task/` 是**后台 bash 任务运行时**（`BackgroundTaskRuntime`：spawn 分离进程 + 输出环形缓冲），不是多智能体任务池 |
| 常驻执行 | `src/always-on/`：Discovery 计划/报告/工作周期 + workspace 隔离；`src/cron/` 定时任务 |
| 记忆 | 白盒记忆（`src/context/memory/`，EdgeClawMemoryProvider + edgeclaw-memory-core 子包）、知识库 `knowledge.db`（图谱/判例/法规/wiki）、Dream Mode 压缩与回滚 |
| 会话持久化 | `JsonlTranscriptWriter` 写入即落盘 + `flushCheckpoint`；`TaskResumeScanner` 形态断点续算（request_header 后无 durable 消息自动续算）；`retry_schedule` 重试轨迹 |
| 事件/网关 | AgentEvent + GatewayEvent 62 事件（事件矩阵门禁）、gateway 协议 1.3、输出门禁 HITL 审批闭环（GatewayApprovalBus + approvalDecide） |
| UI | `ui/src/components/task-master/`（任务看板：dependencies/subtasks/status）、workflow-run 相关组件、审批卡片 |

### 2.2 关键差距：Sati 缺"团队编排层"及其底座

| 维度 | dsh-agent-teams | Sati 现状 | 差距性质 |
|---|---|---|---|
| 成员模型 | durable **continuable** 子代理（跨轮次/跨重启恢复、FIFO followup） | fork 一次性子代理（跑完即止，结果回流） | **底座缺失**：Sati 无 startContinuable/followup 原语（已有 durable session + resume 扫描，但无"可唤醒的持续子代理"语义） |
| 团队协议 | 队长-成员、角色、任务依赖、邮箱、消息 | 无团队概念；工作流是预声明 DAG，子代理是单次调用 | 缺失一整层 |
| 任务池调度 | 事件驱动自动认领（idle 边 + 任务图变更触发，非轮询） | workflow 按 DAG 顺序执行 + plantask HITL；无"空闲成员自动认领下一个 ready 任务" | 缺失 |
| 并发安全 | attempt/attemptId + handoffId + 转派 quiesce + per-team 锁 | workflow checkpoint 防重放；plantask 有 HITL 状态机；但无多 worker 竞争同一任务池的机制 | 缺失 |
| 成员通信 | 直连邮箱 + 投递租约 | 无（子代理单次、父代理中转） | 缺失 |
| 可视化 | Web 活动面板：任务 DAG SVG、成员状态、归档回放 | task-master 看板（静态任务列表）；无团队实时面板 | 部分可复用 task-master |
| LLM 路由 | 成员路由快照 + 冷恢复 | 子代理沿用父配置（`parentConfig`），无独立成员路由持久化 | 缺失 |
| 事件审计 | 团队事件写入 captain session | 事件矩阵完备，可承载团队事件 | 基础设施已有 |

### 2.3 结论

Sati 的"硬地基"（durable 会话、事件矩阵、HITL 审批、checkpoint 续跑、工具契约、渠道接入）比 dsh-agent-teams 更厚；缺的是**上层的团队编排语义**：可唤醒的持续成员、共享任务池的自动认领、任务 attempt 能力与安全转派、成员邮箱直连、以及团队级可视化。这两者不是竞争关系——dsh-agent-teams 的协议层设计可以直接映射到 Sati 已有的地基上。

---

## 3. 同类项目横向调研

### 3.1 Claude Code Agent Teams（概念源头，v2.1.178+，实验性）

来源：[官方文档](https://code.claude.com/docs/zh-CN/agent-teams)。dsh-agent-teams 明确以它为蓝本（mailbox 布局、单队长单团队、任务依赖、直接消息都一脉相承）。

- **组成**：Team lead（负责人会话）+ Teammates（独立 Claude Code 实例，各自 context window）+ 共享 Task list（`~/.claude/tasks/{team-name}/`）+ Mailbox（`~/.claude/teams/{team-name}/inboxes/{agent}.json`）。
- **任务模型**：pending / in-progress / completed 三态 + 依赖；有未解决依赖的任务不可认领；**认领用文件锁防竞态**；负责人显式分配或队友自我认领；任务依赖系统自动管理（依赖完成后自动解除阻塞）。
- **通信**：队友直接互发消息（SendMessage），无负责人中转；空闲通知自动上报负责人（API 错误结束时上报失败原因）。
- **权限**：队友从负责人权限设置继承；队友权限提示**冒泡到负责人**；队友无法互相批准权限（转发批准声明视为不受信任）；plan approval 是例外（负责人可直接批准计划）。
- **质量门 hooks**：TeammateIdle / TaskCreated / TaskCompleted，以 exit code 2 拦截并反馈（相当于"保持工作/禁止创建/禁止完成"）。
- **角色复用**：subagent 定义（tools 白名单 + model）可直接作为队友角色；team coordination 工具（SendMessage/任务管理）始终对队友可用。
- **限制（值得抄的诚实清单）**：每会话一个团队、无嵌套团队（队友不能再生成队友）、负责人固定不可转移、in-process 队友无会话恢复（/resume 不恢复队友）、任务状态可能滞后（队友不总是标记完成）、令牌成本显著更高、关闭慢。
- **最佳实践**：3-5 名队友起步、每人 5-6 个任务、任务自包含、从研究/审查类任务开始、避免同文件冲突、负责人"等待队友完成后再动手"。

### 3.2 dsh 生态与其他 Agent 宿主

（详细笔记见 [docs/research/dsh-ecosystem-research.md](research/dsh-ecosystem-research.md)）

- **DeepSeek Harness（DSH）**：DeepSeek 开源的 agent 宿主（2026-08-13 公测，5 天内 165k+ stars / 17.5k forks，MIT，**无 release tag**、自认 developer preview），定位"一切皆插件"的微内核——基于 cordis 插件框架（时空可组合、注册即 effect、卸载回滚）；**无特权内核**（连 agent loop 本身都可替换插件）；**能力接缝三角色**（Service Definition / Provider / Consumer，换 fs/subprocess provider 即把 Bash/PTY/LSP 搬进远程沙箱）；**事件域三分类**（Session durable 日志 / Agent 活体拦截 / Capability 策略挂接）且 turn/step 流水线有明确 **waterfall 拦截点**（agent/pre-step、agent/request、llm/stream、tools/*）；**事件溯源不变量"模型可见 ⟺ 已记录"**（deriveMessages() 从日志投影模型历史）；host/client 双面包 + slot/Conversation Node UI 接缝（要求确定性重放）；**extensions 支持 agent 运行时自修改（模型自己挂载/卸载插件）**；双向适配器（hooks 桥接 Claude Code/Codex、ACP 出站委派）；profile/bundle 分层 patch + `--dump-config` 逐行可换（[架构文档](https://github.com/deepseek-ai/DeepSeek-Harness/blob/HEAD/docs/architecture.zh.md)、[深度解析](https://github.com/xiaonancs/deepseek-harness-deep-dive)、[拆解文章](https://www.leiphone.com/category/ai/u43j44fx6Rly10nI.html)）。→ 对 Sati：Sati 的插件系统（plugin.json + 7 种贡献点）与 Cordis 插件树同构；"模型可见 ⟺ 已记录"不变量与 Sati 请求重建不变式同向；差距在"分层可覆盖配置 + 可 dump 组合视图"、"waterfall 拦截点语义"与"插件安装门禁"。
- **DSH 插件生态**：`topic:dsh-plugin` 实测 ~7,946 仓库、官方零审核导致约 1/6 换皮/蹭热度；记忆、Vision 桥、插件市场管理器竞争最激烈；**团队类插件已成独立子赛道**（[dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) 599 stars / [huxint/dsh-team](https://github.com/huxint/dsh-team) 2.5D 协作室 + 防横向循环预算 / [toolclub/dsh-agent-team-gui](https://github.com/toolclub/dsh-agent-team-gui) 每成员独立模型/工具策略 + 有界 DAG + 质量门 / [dsh-forge](https://github.com/alex04130/dsh-forge) 跨会话邮箱+团队+插件市场），另有生态清单 [awesome-dsh-plugin](https://github.com/Anil-matcha/awesome-dsh-plugin)。→ 对 Sati："agent 宿主 + 插件生态"是当前主流形态；团队模式被 3-4 个插件验证为需求旺盛。
- **NanmiCoder 的布局**：MediaCrawler（59k stars）→ cc-haha（Claude Code 桌面工作区，含 **Agent Teams workbench**：成员/任务/通信流/依赖泳道画布）→ dsh-agent-teams（比 dsh 公测早一天发布）→ **dsh-plugin-development**（387 行执行型插件开发 SKILL，目前最完整的 dsh 插件开发实操文档）——"跨宿主团队理念 + 方法论输出"卡位路线。→ 对 Sati：可借鉴"把自家开发方法论沉淀为 SKILL/skills.sh 分发"的社区运营方式。
- **Agent Skills 生态**：Anthropic 2025-10-16 发布 SKILL.md 标准，GitHub Copilot（2025-12）与 Cursor（2026-01/02）均已对齐；skills.sh **无需注册**自动索引 + `npx skills add` + leaderboard；dsh 官方有 skill provider 族。→ 对 Sati：Sati 的 SKILL.md 体系（type: role 等）与社区标准同构，缺的是 skills.sh 式分发与安装 CLI。
- **同类宿主对照**：opencode（primary/subagent + Task 工具 + `permission.task` 细粒度权限；**团队原语 PR #18753 已关闭未合并**、Issue #12711 仍开放）；crush（终端搭档，MCP/LSP 扩展，**无团队能力**）；Qoder/Better Harness（"harness 的 harness"，5 维 Agent Work Loop 评估 + 10+ 宿主适配器）。→ 对 Sati：**"命名常驻成员 + 邮箱 + 共享任务 DAG"的团队模式目前只有 dsh 生态真正落地成产品**——是 Sati 的差异化机会；Better Harness 的"宿主评估/治理产品化"可作为 Sati 治理能力的参照。

### 3.3 主流多智能体编排框架

（详细笔记见 [docs/research/multiagent-frameworks-research.md](research/multiagent-frameworks-research.md)，含 8 框架逐项深挖 + 横向对比表；以下为关键机制核实与对 Sati 的启示）

- **AutoGen（Microsoft，v0.4 起）**：actor 事件驱动运行时（asyncio + 异步事件总线），团队抽象（RoundRobin / Selector / Swarm / MagenticOne）；全组件 `save_state/load_state` + `CheckpointManager`；**Termination 条件对象**（MaxMessage/TextMention/TokenUsage/Timeout/External/Handoff）声明式控停；HITL 靠 `UserProxyAgent.input_func` 与 `HandoffMessage`；失败按 `OnExceptionPolicy`（raise/stop）处理（[架构演进综述](https://zhuanlan.zhihu.com/p/2013728518073247564)、[v0.4 全景解析](https://blog.csdn.net/wayle123/article/details/158586399)）。→ 对 Sati：事件驱动底座与 gateway 事件矩阵同构；`save_state/load_state` 组件级快照与 Termination 对象化控停值得借鉴。
- **CrewAI**：role/goal/backstory 角色工厂 + sequential / **hierarchical（manager 动态分配）** 双 process；task 输出经 `context` 管道 + `output_pydantic` 类型化衔接；四类 memory（SQLite + 向量库）+ `replay()`；**Flows（@start/@listen/@router）** 事件驱动补足静态 process（[官方文档](https://docs.crewai.com/v1.14.7/en/learn/hierarchical-process)）。→ 对 Sati：hierarchical 流程与队长-成员同思路；`context` 管道 + `replay()` 可对照 Sati 的 workflow 输入解析与重放。
- **MetaGPT（70k+ stars）**：SOP 编码角色；**环境消息池黑板 pub/sub**（按消息类型 + 来源订阅）；`ActionNode` 定义结构化输出，"结构化中间产物即通信"（PRD→Design→Code）（[README](https://github.com/mannaandpoem/MetaGPT/blob/801490516b61503b4160fdef90e757db585d5f1a/README.md)）。→ 对 Sati：黑板模型 + 结构化产物通信与 Sati 的文书/证据产物体系高度契合。
- **LangGraph**：StateGraph + 可插拔 checkpoint（Memory/Sqlite/Postgres/Redis）+ `interrupt()/Command(resume)` HITL 原语 + threads 会话模型 + `Send` map-reduce 扇出 + 时间旅行（get_state/update_state）；**HITL 与持久化组合最完整**（[Checkpointers](https://docs.langchain.org.cn/oss/javascript/langgraph/checkpointers)、[Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)、[Durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution)）。⚠️ 注意 [diagrid 分析](https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows)：**checkpoint ≠ durable execution**——进程崩溃后的副作用恢复仍需自行处理；Sati 的 `flushCheckpoint`（工具副作用前显式 checkpoint，fail-closed）正是对这一点的正确应对。→ 对 Sati：Sati workflow checkpoint/plantask HITL 已实现同类能力；可对照其 interrupt 一等原语 API 形态与 threads 会话模型。
- **OpenAI Agents SDK（原 Swarm）**：**handoff 一等控制流原语** + triage 路由 + Session 持久化（InMemory/Sqlite/Redis/File）+ guardrails（input/output 双端）+ 内建 tracing。→ 对 Sati：handoff/triage 与 Sati 智能路由有交集，可作概念参照。
- **CAMEL-AI**：角色扮演 + task inception + TaskPlanning→TaskSolving 两级拆解 + MessageHub 通道黑板。→ 对 Sati：两级拆解与 Sati flexible-plan 阶段级计划可对照。
- **ChatDev**：ChatChain(YAML) 阶段链 + 每阶段双角色对话 + chat_env 产物交接 + ECL 经验库。→ 对 Sati：串行流水线形态与 Sati 声明式 workflow 重叠，借鉴价值低。
- **Magentic-One（Microsoft）**：编排器-专才架构（Orchestrator + WebSurfer/FileSurfer/Coder…），**task ledger + progress ledger 双账本**自适应计划（facts/guesses/plan + progress），`Task`/`TaskOutcome`（success/failed/incomplete）回报，失败换策略/换 agent/重拆分重试，`human_in_the_loop` 开关。→ 对 Sati：双账本进度追踪（防重复、可审计）值得借鉴。
- **补充框架（简）**：Google ADK（FlowsAgent/ParallelAgent + SessionService 多后端持久化 + transfer handoff）；LlamaIndex Workflows（纯事件驱动 @step + StartEvent/StopEvent + 事件类型校验）；AG2（AutoGen 继承者，GroupChat + manager 选发言人）；Microsoft Agent Framework（AutoGen+Semantic Kernel 合并继任，threads + GroupChatManager，1.0 GA）。→ 对 Sati：均与既有判断一致（事件驱动/会话持久化/HITL 方向），无需新增借鉴。

**横向对比表**

| 项目 | 定位 | 任务模型 | 通信 | 持久化 | HITL | 失败恢复 | 最值得借鉴点 |
|---|---|---|---|---|---|---|---|
| AutoGen v0.4 | 事件驱动 actor 多 agent 框架 | Team 抽象（轮询/selector/swarm）+ Termination 对象控停 | 运行时 topic pub/sub（团队管理中转） | 全组件 save_state/load_state + CheckpointManager + StateStore(多后端) | UserProxyAgent.input_func + HandoffMessage + ExternalTermination | OnExceptionPolicy(raise/stop) + 模型重试 + 上限控停 | 组件快照 + Termination 对象化 |
| CrewAI | 角色化 crew 框架 | sequential 管道 / hierarchical manager 委派；Flows 事件驱动 | task context 管道 + 共享短期记忆 | 四类 memory(SQLite+向量) + TaskOutputStorageHandler + Flows SQLite 持久态 | human_input=True + HumanInputTool/Agent | litellm 重试 + replay() | context 管道 + replay + manager 委派 |
| MetaGPT | SOP 化软件公司 | Team.run_project + Role(Action 链) + ActionNode 结构化产物 | 环境消息池黑板 pub/sub（按类型订阅） | Role.memory（向量库）+ 上下文可序列化 + 产物落盘 | UserRequirement / 对话注入 | n_round 防循环 + LLM 重试 | 结构化产物即通信 |
| LangGraph | 图状态机 | StateGraph 节点/边 + Send map-reduce + threads 会话 | 共享图 state（channels） | 可插拔 checkpoint（多后端）+ BaseStore 长期记忆 + 时间旅行 | interrupt()/Command(resume) 一等原语，四模式 | recursion_limit + retry_policy + checkpoint 恢复 | HITL+持久化组合（⚠️ checkpoint≠durable） |
| OpenAI Agents SDK | 轻量 agent + handoff | 单 agent 循环 + handoff/triage | AgentHandoff 转移控制权 | Session(id/state/items) + 多后端 session store + tracing | 无（工具/guardrail 模拟） | max_turns + session 续跑 | handoff/triage 一等原语 |
| CAMEL | 角色扮演 | TaskPlanning→TaskSolving 两级 + Society | MessageHub 通道黑板 | LongtermAgentMemory（向量库） | 弱 | 工具纠错重试 | 两级拆解 + 通道黑板 |
| ChatDev | 流水线 chat chain | ChatChain(YAML) 阶段链 + 双角色对话 | 阶段内对话 + chat_env 黑板 | Record + chat_env 快照落文件 + ECL 经验库 | 人类扮演 user | LLM 重试（弱） | —（与 workflow 重叠） |
| Magentic-One | 编排器-专才 | 双账本（facts/plan + progress）+ Task/TaskOutcome | 编排器中转（agent 不互聊） | ledger 落盘；V2 线程持久化 | human_in_the_loop 开关 | 失败→换策略/换 agent/重拆分 | 双账本进度追踪 + 工具域隔离 |

### 3.4 Agent OS / 记忆 / 常驻执行类

（详细笔记见 [docs/research/agent-os-open-source-research.md](research/agent-os-open-source-research.md)，含 8 项目横向对比表）

- **Letta（原 MemGPT）**：有状态 agent 平台。**MemFS**（git 版记忆文件系统：记忆即 agent 的 git 仓库，写入即 commit，天然版本历史/回滚/审计）；`system/` 目录每轮注入 system prompt、`reference/` 按需读取、文件树常驻作"路标"（分层上下文契约）；**Dreaming**（sleep-time 后台子代理整理记忆 + worktree 并发 + 二次复核）；云/本地**双轨 cron 调度**（目标机离线回退 cloud sandbox）（[Docs](https://docs.letta.com/llms.txt)）。→ 对 Sati：git 记忆基质与 Sati 白盒记忆（审计/回滚）高度同向；Dreaming 与 Sati Dream Mode + always-on 同构。
- **AutoGPT Platform**：可视化"块即节点、图即 agent"低代码平台；block 以 **async generator 契约 yield 输出**（增量产出/流式持久化）、`BlockSchema` 强校验 I/O；执行状态机含 **REVIEW 人工态**；独立 **Scheduler 微服务（:8003）** 管定时 + webhook 触发（[DeepWiki](https://deepwiki.com/Significant-Gravitas/AutoGPT/3-autogpt-platform)）。→ 对 Sati：REVIEW 人工态与 Sati 输出门禁 HITL 同思路；独立调度服务与 Sati cron/always-on 可对照。
- **AgentScope（Alibaba）**：消息中心化多 agent 平台。v1 = Msg/Actor/pipeline/msg-hub；v2 的 **Context 构建块做成中间件挂进循环**（自动压缩/工具结果卸载/注入各阶段钩子）、记忆后端可切换（ReMe/Mem0）、**后台任务卸载 + 结果到达唤醒 agent 续谈**；**v2 内建 Agent Team（leader 生成 worker + 团队工具 + 任务规划）**；channels 支持飞书/Discord（[GitHub](https://github.com/agentscope-ai/agentscope)、[论文](https://arxiv.org/abs/2402.14034)）。→ 对 Sati：**AgentScope v2 是"团队 + 常驻 + 多渠道"与本项目最接近的对照物**；其"中间件式循环钩子"与 Sati 的 ToolGuard/输出门禁可对照。
- **Dify / Flowise / n8n**：低代码 agent 编排。核心强项——**定时触发器（cron）是一等图节点**、确定性节点与 agent 节点同图混合（可测试可审计）、会话变量承载跨步状态（[Dify Schedule Trigger](https://enterprise-docs.dify.ai/en/3.7.x/use/workflow/node/trigger/schedule-trigger)）。→ 对 Sati：定时触发可视化与 Sati 的 cron/always-on 可视化可对照。
- **OpenClaw**：自托管**常驻个人 AI 网关**——一个 Gateway 进程（WebSocket）挂 20+ IM 渠道（含微信/企业微信/QQ/飞书）统一接入编码 agent；**automations = cron + webhook + Gmail PubSub 统一进 Gateway 调度器**；SQLite 记忆引擎（词/向量/混合 + 层级/来源/召回通道 + **Active memory 分级升级召回** + Dreaming light/deep/REM 三阶段）；**standing orders**（长期操作授权 + 审批）；background tasks 台账；**main session 跨渠道连续会话**（[Docs](https://docs.openclaw.ai/llms.txt)）。→ 对 Sati：**渠道网关 + 常驻 + 调度器统一入口**与 Sati 的 21 渠道适配器 + always-on + cron 是同类架构；其"跨渠道单一会话连续性"是 Sati 可对照的产品点。
- **OpenHands**：软件开发 agent（SDK + Agent Canvas）。**事件流即真相**（Event History → Condenser → LLM → SecurityAnalyzer → Tool Executor → ObservationEvents）；**Condenser 可插拔压缩器**返回 View（本轮继续）/ Condensation（先落事件）两种决策语义；单步 `step()` 无状态可暂停/恢复；Automation Server 与 Agent Server 分离（[SDK 架构](https://docs.openhands.dev/sdk/arch/agent.md)）。→ 对 Sati：Condenser 决策语义与 Sati 的上下文压缩（shadowed compaction replay）可对照；SecurityAnalyzer 分级与 Sati ToolGuard/宪法规则可对照。
- **互操作标准**：Linux Foundation 已同时接纳 **MCP 与 A2A/AGNTCY**（[公告](https://www.linuxfoundation.org/press/linux-foundation-welcomes-the-agntcy-project-to-standardize-open-multi-agent-system-infrastructure-and-break-down-ai-agent-silos)）。A2A v1.0：**AgentCard 能力声明**（`/.well-known/agent-card.json`，可签名）+ **Task 状态机**（submitted/working/input-required/completed/failed/canceled/rejected）+ Artifact + 推送通知；Async-first、opaque execution（只交换能力与结果，不暴露内部状态）（[规范](https://a2a-protocol.org/latest/specification/)）。AGNTCY：Agent Directory Service（发现注册表）+ SLIM（安全消息）+ OASF（能力描述）+ Identity。→ 对 Sati：MCP 已是 Sati 原生；A2A 作后续跨实例协作观察点（团队内通信以自有协议为准）。

### 3.5 专利领域相关

- [Patent-GPT](https://github.com/PatentTRIZbasedAI20260226110030/Patent-GPT)：TRIZ + Agentic RAG 的发明 copilot，LangGraph 实现自主规避设计，输出结构化专利草稿。
- [M-Cube](https://github.com/yycyyv/M-Cube)：多思维（Multi-thinking）、多模态、多重验证的专利撰写助手。
- 参考论文 [ToC: Tree-of-Claims Search with Multi-Agent Language Models](https://ar5iv.labs.arxiv.org/html/2511.16972)（AAAI 2026）：用多智能体做权利要求树检索。

> 此类项目聚焦"专利内容生成"单点能力，与 Sati 的"专利执行管线 + 团队编排"定位不同层；其可借鉴点主要在领域提示词与评估方法，不在团队协议。

---

## 4. 对 Sati 的可借鉴点清单（按价值排序）

> 判定原则：**Sati 已有地基能承载的、且与专利域工作流（检索→分析→撰写→审查→OA/无效）匹配的机制优先**；纯框架工程炫技不引入。标注 [P0 建议立项] / [P1 可选] / [P2 观察]。

### 4.1 团队编排协议层（P0 建议立项）——来自 dsh-agent-teams / Claude Code Agent Teams

1. **队长-成员 + 共享任务池模型**：一个会话作为队长，把目标拆成带依赖的任务进入共享池，空闲成员自动认领下一个 ready 任务。Sati 的 `agent` 工具（fork 一次性子代理）与 workflow（预声明 DAG）之间正好缺这一层"动态团队"形态——它比 workflow 更灵活（任务由模型实时拆解），比单次子代理更持久。
2. **任务 attempt 能力机制（attempt/attemptId + handoffId + 转派 quiesce）**：dsh-agent-teams 最硬核的设计——转派/接管先撤销旧 capability、中断旧 worker 并等待安静，迟到更新永远被拒绝。Sati 的 workflow checkpoint 防重放解决了"断点续跑"，但**没有解决"多 worker 并发写同一任务"的竞争**（当前 worker 由 DAG 静态指派）。若 Sati 引入共享任务池，此机制是必需的并发安全件。
3. **事件驱动认领调度（agent idle 边 + 任务图变更触发，非轮询）**：利用"成员进入 idle"这一既有事件推进共享任务池。Sati 已有完备事件矩阵 + gateway，天然具备实现条件；比"常驻轮询任务列表"（Claude Code 的做法）更省 token。
4. **成员邮箱 + 直连消息（JSONL/存储 + 投递租约 + 冷恢复重投）**：成员之间直接互发消息、不经过队长中转；消息落盘、投递租约防重、失败重试。Sati 的渠道适配器/transcript 已有消息化基础，团队邮箱可复用其存储与事件面。
5. **成员 LLM 路由快照 + 冷恢复**：成员的 provider/model/reasoningEffort 在创建时解析并持久化，跨重启恢复同一路由（且跨路由时自动用目标模型默认档，不继承不适用的 effort）。Sati 的 `resolveModelInfo` 能力解析可直接支撑。
6. **协议即提示词（system prompt 段）+ 容忍模型不守仪式**：团队使用协议写进提示段（建队→拉人→拆任务→调度→监控→转派→归档），且明确"模型不调用 update 工具时以存储真相为准"。Sati 的角色/技能体系（SKILL.md）可承载此协议；"真相源在存储、不在模型回执"的原则应与 Sati 现有 outputSchema 契约精神合并。

### 4.2 团队级可视化（P1 可选）

7. **活动面板 + 任务 DAG 可视化**：成员状态/进度/当前任务/未读消息 + 任务依赖 DAG（SVG 曲线、hover 高亮上下游、点击固定、Esc 取消、归档回放）。Sati UI 已有 task-master 看板与 workflow-run 组件，可扩展为"团队面板"；但 Sati 走 **gateway WebSocket 事件推送**而非 1s 轮询（dsh-agent-teams 轮询是插件无推送通道的妥协）。

### 4.3 工程方法（P1 可选）

8. **多智能体编排的故障注入验证矩阵**：dsh-agent-teams 用 8 成员 + 31 节点 DAG + 并发接管/迟到写入风暴/冷重启/认领竞争/终态覆盖/消息突发 + 最终归档的脚本化验证。Sati 若引入团队层，应配套同类 `stress-verify` 式故障矩阵（现有 llm-replay/event-matrix 门禁可扩展）。
9. **"结构化产物即通信"（MetaGPT 启示）**：团队成员间的中间交付物应是结构化文档/证据（专利域：检索报告、特征对比表、权利要求草稿），而非仅自然语言消息——这正符合 Sati 的产物/证据体系（claim-chart、文书模板、evidence）。
10. **任务上下文管道 + 类型化输出 + replay（CrewAI 启示）**：task 的输出经 `context` 管道成为下游任务输入，类型化契约可校验、可回放——与 Sati 的 workflow `WorkflowStepOutput`/worker 契约同构，团队层任务间传递应显式声明产物类型与来源，而非只靠自然语言描述。
11. **编排器-专才工具域隔离（Magentic-One 启示）**：编排器只暴露"计划/委派/汇总"类工具，专才只暴露其领域工具——Sati 已有 `visibleDomains`/`hiddenDomains`，团队层可把"队长 vs 成员"视作域裁剪的更高层（队长域 = 团队管理工具 + 审批；成员域 = 领域工具）。

### 4.4 观察项（P2）

12. **handoff 移交原语 + triage 路由（OpenAI Agents）**：角色间移交会话控制权；Sati 已有智能路由，可观察其与路由/角色切换的边界。
13. **sleep-time compute / 后台记忆处理（Letta）**：agent 空闲时后台压缩/整理记忆；Sati 的 always-on + Dream Mode 已覆盖，继续跟踪其跨会话模式检测做法。
14. **消息中心 actor 底座（AgentScope/AutoGen v0.4）**：与 Sati 事件矩阵同构，仅作架构参照，无需照搬。
15. **HITL 计划审批（Claude Code plan approval）**：队友先只读规划、负责人批准后再动手。Sati 的 plantask HITL 已覆盖同类场景（`approveStageIds`），团队层可直接复用。
16. **双账本进度追踪（Magentic-One task ledger + progress ledger）**：任务账本（是什么/谁做）+ 进度账本（做到哪/验证过什么）分离，防重复工作、可审计——与 Sati 的 evidence/事实黑板（reasoning 事实黑板）思想接近，团队层可把"任务状态"与"已达成事实"分开记录。
17. **组件级状态快照（AutoGen save_state/load_state）**：任意时刻对整个团队（成员+任务+消息）做快照并恢复——Sati 已有 workflow checkpoint 与 JsonlTranscript，团队层可提供"团队级快照"作为归档/回放的高级形态（比 dsh-agent-teams 的目录归档更结构化）。
18. **宿主层启示（DSH 生态）**：a) "模型可见 ⟺ 已记录"日志强约束——Sati 已有 requestInvariant 对拍，可推广到团队事件（任何模型可见状态变更必须落日志），并补"新模型可见输入未落日志即 fail-loud"门禁；b) 分层可覆盖配置 + 可 dump 组合视图（DSH profile/bundle patch + `--dump-config`）——Sati 的 PilotConfigStore/lastGoodFacts 可对照；c) **waterfall 事件拦截点**（DSH `agent/pre-step`、`llm/stream`、`tools/*` 等必须 next() 让渡）——Sati 事件面多为广播型，可对照补充"拦截式"事件语义用于门禁/守卫；d) **extensions 运行时自修改**（DSH 允许模型自己挂载/卸载插件）——Sati 的 extension 系统可观察该能力（需权限与审计约束）；e) 插件安装门禁（DSH allowBuilds 显式授权第三方构建脚本）——Sati 插件系统应内置"构建产物白名单/签名"校验，避免生态无序（DSH 7,946 个 topic 仓库约 1/6 换皮即前车之鉴）；f) SKILL.md 即分发物——Sati 的角色/方法论 skills 可按 skills.sh 标准对外发布。
19. **中间件式循环钩子（AgentScope v2）**：把压缩/权限/记忆注入做成可插拔中间件挂进 agent 循环各阶段——Sati 已有 ToolGuard/输出门禁/上下文预算等钩子，可对照其"统一中间件注册面"形态（避免各自为政）。
20. **后台任务卸载 + 结果唤醒（AgentScope）**：长时工具调用转后台执行、结果到达唤醒 agent 续谈——Sati 的 always-on/background task 已有基础，可对照"工具级卸载 + 唤醒"的原语化。
21. **跨渠道单一会话连续性（OpenClaw main session）**：多渠道共享同一条滚动会话——Sati 有 21 个渠道适配器，可观察是否需要"跨渠道连续会话"产品能力（当前各渠道会话隔离）。
22. **git 记忆基质（Letta MemFS）**：记忆写入即 commit，版本历史/回滚/审计一步到位——Sati 白盒记忆已有审计与回滚，可对照其"以 git 仓库为记忆容器"的实现（若未来需要分布式记忆同步）。

### 4.5 一句话总结

dsh-agent-teams 及其概念源头 Claude Code Agent Teams，给 Sati 的最大价值是**一套经过实战打磨的"动态多智能体团队"协议语义（队长/成员/任务池/attempt 能力/邮箱/归档）**，而非具体代码——Sati 有更厚的地基（durable 会话、事件矩阵、HITL、checkpoint、存储），把该协议映射到 Sati 的地基上，即可获得"专利工作流中的多角色并行协作"能力（例如：检索员/分析师/撰写人/审查员四角色并行处理一个申请案）。

---

## 5. 不建议借鉴 / 边界（保持 Sati 自身架构）

1. **不做 DSH 式插件宿主层**：Sati 已有自己的插件系统（plugin.json + lifecycle hooks + 7 种贡献点）；dsh-agent-teams 的"cordis 服务键探测、bundle patch"等是 DSH 特有的宿主适配，对 Sati 无意义。
2. **不引入"成员拥有全部工具"的默认**：dsh-agent-teams 成员默认持完整工具集（bash/fs/web），只靠 persona 约束；Sati 已有 domain 裁剪 + visibleDomains/hiddenDomains + ToolGuard + 宪法规则，团队成员的工具体现应沿用 Sati 的域裁剪与权限体系，而不是照抄"默认全量 + persona 约束"。
3. **任务状态机不必照抄 pending→claimed→in_progress**：Sati 的 plantask/workflow 已有自己的状态机与 HITL；团队层只需复用其"attempt 能力 + 转派 quiesce"思想，状态机应以 Sati 现有契约为准。
4. **文件级状态存储是降级方案**：dsh-agent-teams 用 `team.json` + JSONL 是因为它是无自有数据库的插件；Sati 有 better-sqlite3 与既有存储层（knowledge.db、transcript、workflow-runs），团队状态应入 SQLite/既有存储，不照抄文件方案（其原子写/Windows EPERM 处理可作参考）。
5. **不引入"模型必须走工具仪式"的强依赖**：面板/汇总需容忍模型不调 update 工具（dsh-agent-teams 与 Claude Code 都承认此问题）；Sati 应沿用其"磁盘/存储真相 + 服务端组装快照"思路，而不是相信模型回执。
6. **1s 轮询浮层**：是插件在无推送通道下的妥协；Sati 有 gateway WebSocket + 事件矩阵，团队面板应走事件推送而非轮询。

---

## 6. 参考来源

- [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams)（README / docs/usage.md / src 全量源码，v0.1.7）
- [Claude Code Agent Teams 官方文档](https://code.claude.com/docs/zh-CN/agent-teams)
- [多智能体编排框架详细调研笔记](research/multiagent-frameworks-research.md)（AutoGen / CrewAI / MetaGPT / LangGraph / OpenAI Agents / CAMEL / ChatDev / Magentic-One 对比表）
- [Agent OS / 记忆 / 常驻执行类详细调研笔记](research/agent-os-open-source-research.md)（Letta / AutoGPT / AgentScope / Dify / OpenHands / OpenClaw / A2A 对比表）
- [DSH 生态与周边项目详细调研笔记](research/dsh-ecosystem-research.md)（deepseek-harness 插件体系 / NanmiCoder 布局 / dsh-plugin 生态 / Agent Skills 标准 / opencode/crush/Better Harness 对照）
- [awesome-dsh-plugin（DSH 插件生态清单）](https://github.com/Anil-matcha/awesome-dsh-plugin) / [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) / [dsh-forge](https://github.com/alex04130/dsh-forge)
- [DeepSeek Harness 架构文档](https://github.com/deepseek-ai/DeepSeek-Harness/blob/HEAD/docs/architecture.zh.md) / [deepseek-harness-deep-dive](https://github.com/xiaonancs/deepseek-harness-deep-dive)
- LangGraph [Checkpointers](https://docs.langchain.org.cn/oss/javascript/langgraph/checkpointers) / [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) / [Durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution)；CrewAI [Hierarchical Process](https://docs.crewai.com/v1.14.7/en/learn/hierarchical-process)；MetaGPT [README](https://github.com/mannaandpoem/MetaGPT/blob/801490516b61503b4160fdef90e757db585d5f1a/README.md)；AutoGen [架构综述](https://zhuanlan.zhihu.com/p/2013728518073247564)；AgentScope [论文](https://arxiv.org/abs/2402.14034)；A2A [规范 v1.0](https://a2a-protocol.org/latest/specification/)；AGNTCY [LF 公告](https://www.linuxfoundation.org/press/linux-foundation-welcomes-the-agntcy-project-to-standardize-open-multi-agent-system-infrastructure-and-break-down-ai-agent-silos)
- [Patent-GPT](https://github.com/PatentTRIZbasedAI20260226110030/Patent-GPT) / [M-Cube](https://github.com/yycyyv/M-Cube) / [ToC (AAAI 2026)](https://ar5iv.labs.arxiv.org/html/2511.16972)
