# Agent 操作系统 / 常驻智能体 / 记忆与上下文管理 — 开源项目调研笔记

> 调研日期：2026-08；调研方式：web_search + 官方文档逐页精读（优先 llms.txt / index.md 机器可读版）。
> 用途：为"白盒记忆 + 常驻执行 + 智能路由的 Agent 操作系统"（Sati）提供外部设计参照。
> 说明：文中机制/接口名均来自对应官方文档，链接为来源 URL。

---

## 0. 调研范围

按用户清单逐项调研：Letta、AutoGPT Platform、Alibaba AgentScope、Dify/Flowise/n8n、Claude Code Agent Teams（重点）、AGNTCY/A2A/MCP、OpenHands；第 8 项选取 **OpenClaw**（与"常驻后台执行 + 定时任务 + 多渠道接入"相关性最强的自托管网关类项目）。另补充 Mem0 / LangGraph / Temporal 三条同类观察。

---

## 1. Letta（原 MemGPT）

**来源**：[Letta Docs 索引 llms.txt](https://docs.letta.com/llms.txt) · [Memory & dreaming](https://docs.letta.com/configuration/memory/index.md) · [MemFS](https://docs.letta.com/concepts/memfs/index.md) · [Schedules](https://docs.letta.com/configuration/schedules/index.md) · [Sessions, turns, durability](https://docs.letta.com/agent-sdk/sessions/index.md) · [Memory (Agent SDK)](https://docs.letta.com/agent-sdk/memory/index.md) · [Why Memory Isn't a Plugin](https://www.letta.com/blog/why-memory-isnt-a-plugin/) · [Context Constitution](https://github.com/letta-ai/context-constitution)

- **定位与架构一句话**：面向"有状态、能持续学习"的 agent 平台（harness），核心是让 agent **主动管理自己的上下文**（把记忆/身份/连续性写进 token 空间而非改模型权重），由 [Context Constitution](https://github.com/letta-ai/context-constitution) 明文规定"什么进上下文窗口、什么顺序、什么详细度、留多久"。
- **记忆/上下文管理**：
  - **MemFS**（git 版记忆文件系统）：记忆本身就是属于 agent 的 git 仓库，投影成真实 checkout，agent 用普通文件工具读写；"记忆按路径寻址"，`system/` 目录（如 `system/persona.md`、`human.md`）**每轮注入 system prompt**，`reference/`、`skills/` 在上下文之外按需读取，**文件树常驻 prompt 作"路标"**（signposts）。
  - 每条记忆写入即 commit：天然获得版本历史、冲突解决、"已保存 vs 未提交"的边界（白盒审计）。
  - 默认**无向量索引**；`letta install npm:@letta-ai/memfs-search` 可加关键词/语义/混合检索（语义需 QMD 索引 `$MEMORY_DIR`）；云端 `letta messages search` 支持全文本/向量/混合检索会话历史。
  - **Dreaming（后台记忆整理）**：`/sleeptime` 配置，触发条件 = 完成 N 个 agent 步骤或上下文压缩时；用**后台子代理**审阅近期对话、沉淀教训、更新记忆；可开 "Agent reviews before applying" 二次复核；记忆子代理用 **git worktrees 并发更新记忆而不阻塞主 agent**。
  - `/init`（初始化/刷新记忆）、`/remember`（显式教导）、`/doctor`（审计放置/重复/system prompt token 用量）。
- **Agent 生命周期**：agent 有独立身份，跨模型、跨机器、跨会话保持状态（[stateful agents](https://docs.letta.com/concepts/stateful-agents/index.md)）；SDK 明确 agent / conversation / session 三层模型与连接间 durability 保证；自托管用 **Letta App Server**，WebSocket 协议生命周期为 `runtime_start → input → sync → abort`（[protocol-lifecycle](https://docs.letta.com/platform/app-server/protocol-lifecycle/index.md)）；云端 agent 跑在 "computers"（cloud sandbox / BYOM），支持 **teleportation 把活跃会话迁移到另一台机器**；CLI 有 headless 模式供脚本/CI 常驻。
- **任务/调度模型**：内置 **Schedules**——一次性或周期 prompt（如每天 9 点简报、每小时邮件分诊），**agent 可自己创建调度**；CLI：`letta cron add --agent … --cron "0 9 * * *" --at "in 45m" --every 1h --runner local --computer <deviceId>`，`letta cron list` / `letta cron runs --id`；**云调度**（计时器存云端、设备离线照跑、目标机器离线时回退到 cloud sandbox）vs **本地调度**（仅 app/`letta server` 会话在线时触发；单 agent 上限 50 个活跃任务；迟到 >5 分钟的 one-shot 标记 missed；cron 表达式目前按 UTC 评估）。
- **多 Agent 协同**：subagents（任务分解 + 并行执行）；sleep-time 子代理做反思/记忆整理；云 agent 之间可挂 **shared memory**（共享 git-backed 文件）；企业版 collaborators 支持团队共享 agent。
- **渠道接入与前端形态**：Channels 支持 Slack / Discord / Telegram / WhatsApp / Signal / 自定义渠道（消息全量回显到 app）；前端 = 桌面 app（macOS/Win/Linux）+ Web（chat.letta.com）+ CLI；对外暴露 **ACP（Agent Client Protocol）** 集成；自托管 App Server 供 Agent SDK 客户端接入。
- **值得借鉴**：git 作为记忆基质（版本/回滚/审计一步到位）；`system/` 常驻 + 文件树路标的"分层上下文契约"；Dreaming 子代理 + worktree 的后台记忆整理；云/本地双轨调度 + 失联兜底；App Server 的 `runtime_start/input/sync/abort` 协议生命周期。

---

## 2. AutoGPT Platform

**来源**：[DeepWiki: AutoGPT Platform](https://deepwiki.com/Significant-Gravitas/AutoGPT/3-autogpt-platform) · [Agent Builder Guide](https://agpt.co/docs/platform/using-the-platform/agent-builder-guide/) · [Data Flow & Execution](https://agpt.co/docs/platform/using-the-platform/data-flow-and-execution/) · [DeepWiki: Data and Control Flow Blocks](https://deepwiki.com/Significant-Gravitas/AutoGPT/3.2.10-data-and-control-flow-blocks) · 仓库 [Significant-Gravitas/AutoGPT](https://github.com/Significant-Gravitas/AutoGPT)

- **定位与架构一句话**：可视化"块（block）即节点、图即 agent"的低代码平台——前端 Next.js + React Flow 拖图，后端 Python/FastAPI 微服务执行，把 LLM 调用、集成、数据/控制流全部表达为可组合的 block 图。
- **记忆/上下文管理**：LLM 块内置 `compress_prompt`（prompt 压缩）；节点输入输出用 **Pydantic BlockSchema** 强校验；每次节点执行结果持久化为 `AgentNodeExecutionInputOutput` 记录（图内数据传递即"记忆"）；执行状态机 `AgentExecutionStatus`：`INCOMPLETE/QUEUED/RUNNING/COMPLETED/TERMINATED/FAILED/REVIEW`（REVIEW = 需人工介入）。
- **Agent 生命周期**：图执行是**异步、排队**的——`POST /api/graphs/{id}/execute` → 建 `AgentGraphExecution` 记录 → 投 RabbitMQ `GRAPH_EXECUTION_QUEUE` → ExecutionManager 派 `ExecutionProcessor` 线程 → 拓扑排序逐节点执行 → WebSocket 实时推送 `node_execution_event` / `graph_execution_event`；执行记录全量入库（可恢复/可查）。
- **任务/调度模型**：独立 **Scheduler 微服务（:8003，apscheduler）** 管理**定时 + webhook 触发**执行（`add_execution_schedule / remove_schedule / get_schedules`）；执行与通知均走 RabbitMQ 队列解耦；Redis 分布式锁防凭证并发复用。
- **多 Agent 协同**：非原生编排；`AgentExecutorBlock` 支持"图内嵌图"（一个 agent 调另一个 agent）；Copilot 系统用聊天方式构建/运行 agent。
- **渠道接入与前端形态**：Web（React Flow 画布 + WebSocket 实时状态）；REST API + WebSocket API；Agent Protocol；集成块覆盖 Slack/Discord/Email/GitHub/GoogleSheets（20+ 集成块，总计 50+ 块）。
- **值得借鉴**：block 以 **async generator 契约 yield 输出**（增量产出、流式持久化）；`BlockSchema` 输入/输出契约强校验；执行状态机含 REVIEW 人工态；调度器独立成服务 + 队列解耦；凭证分布式锁。

---

## 3. Alibaba AgentScope

**来源**：[GitHub agentscope-ai/agentscope](https://github.com/agentscope-ai/agentscope) · [论文 AgentScope v1 (arXiv:2402.14034)](https://arxiv.org/abs/2402.14034) · [AgentScope 1.0 (arXiv:2508.16279)](https://arxiv.org/abs/2508.16279) · [AgentScope Java 文档 v2](https://java.agentscope.io/v2/zh/intro.html)

- **定位与架构一句话**：阿里巴巴开源的"消息中心化"多 agent 平台——v1 以 **Msg（统一消息）+ Actor（agent 基类）+ pipeline/scheduler（顺序/并行编排）+ msg-hub（消息中心）** 为抽象，支持 `agentscope.rpc` 分布式部署；v2 演进为生产级 agent 框架 + 开箱即用的 agent service（FastAPI + Web UI）。
- **记忆/上下文管理**：v2 的 **Context 构建块**提供自动压缩（compaction）、**工具结果卸载**（tool-result offload）、上下文注入（system prompt / RAG / memory）——全部做成**中间件**（middleware）挂进循环（reply/reasoning/acting/model calling/permission/compression/system prompt 各阶段钩子）；**Memory 构建块**为 agentic memory，**后端可切换（ReMe / Mem0）**；事件系统把推理过程/工具调用/多模态内容流式推到前端。
- **Agent 生命周期**：ReAct 循环支持结构化输出、**实时中断与恢复（realtime interruption & resume）**；agent service 提供 SQL/NoSQL 状态与会话持久化；**后台任务卸载**：长时工具调用转后台执行，结果到达后**唤醒 agent 续谈**（wakeup），会话无缝恢复。
- **任务/调度模型**：agent service 的 **Scheduling** 能力 = 定时任务（scheduled tasks）+ **agent 唤醒（agent wakeup）** + 后台任务卸载；多租户、多会话隔离。
- **多 Agent 协同**：v1 pipeline/scheduler（sequential/parallel/while）；v2 **Agent Team**——leader 生成 worker 并通过内置团队工具（task planning/分配）协调；RAG service 支持多租户检索。
- **渠道接入与前端形态**：v2 channels 支持 **飞书（Feishu/Lark）、Discord**、自定义渠道；前端 = console（终端调试）+ 预置 Web UI（examples/web_ui）；对外 FastAPI backend；MCP & Skill Hub（GitHub MCP Registry / ClawHub）可装进 workspace。
- **值得借鉴**：**中间件式循环钩子**（把压缩/权限/注入做成可插拔阶段）；**workspace/sandbox 抽象**（local/Docker/Apple Container/Bubblewrap/E2B/OpenSandbox/Daytona/K8s 一键切换）；**后台任务卸载 + 结果唤醒**；**可插拔记忆后端**（ReMe/Mem0）；团队工具内建于服务层。

---

## 4. Dify / Flowise / n8n（低代码 agent 编排）

**来源**：[Dify Schedule Trigger](https://enterprise-docs.dify.ai/en/3.7.x/use/workflow/node/trigger/schedule-trigger) · [Dify Agent Node Lesson 8](https://docs.dify.ai/en/learn/tutorials/workflow-101/lesson-08) · [Dify Key Concepts](https://docs.bash-is-all-you-need.dify.dev/en/use-dify/getting-started/key-concepts) · [n8n Build and manage agents](https://docs.n8n.io/build/build-and-manage-agents) · [Agentic AI tools 对比（n8n/LangFlow/Flowise）](https://www.intellisoft.com.sg/comparing-agentic-ai-automation-tools-n8n-langflow-flowise-ai.html)

- **定位与架构一句话**：把"确定性节点 + LLM agent 节点"混合编排进同一张可视化图的可视化工作流平台（Dify 偏 LLMOps/应用、n8n 偏 iPaaS/自动化、Flowise 偏 LangChain 套壳）。
- **记忆/上下文管理**：
  - Dify：工作流内**会话变量（conversation variables）**承载跨步状态；agent 节点内置对话记忆；知识库 RAG（向量检索）作为外部上下文；上下文变量生命周期随会话。
  - n8n：AI Agent 节点 + chat memory 节点（buffer/向量存储）管理多轮上下文；工作流内变量持久化。
- **Agent 生命周期**：均为**请求/触发驱动的短生命周期**（一次运行 = 一次图执行）；n8n 支持 queue mode（Redis）横向扩容与失败重试；Dify 执行记录可查。
- **任务/调度模型**：三者的核心强项——Dify 工作流**定时触发器（Schedule Trigger，cron）**与 webhook 触发是**一等节点**；n8n cron/间隔触发 + webhook + 队列；Flowise 靠外部调度。
- **多 Agent 协同**：Dify agent 节点支持多策略（Function Calling / ReAct，及随版本演进的多智能体编排）；复杂协同靠"图内嵌 agent 节点 + 分支"；n8n 用 sub-workflow 组合多个 agent。
- **渠道接入与前端形态**：Dify 自带 WebApp/嵌入 widget/API；n8n 有 400+ 集成与自托管 Web；Flowise Web 画布 + API。
- **值得借鉴**：**定时触发作为一等图节点**（调度声明式、可视化）；确定性节点与 agent 节点同图混合（可测试、可审计）；会话变量承载跨步状态；插件市场（Dify plugin + MCP 工具接入）。

---

## 5. Claude Code Agent Teams（重点：生命周期与实现机制）

**来源**：[官方文档 code.claude.com/docs/zh-CN/agent-teams](https://code.claude.com/docs/zh-CN/agent-teams)（本笔记机制细节全部来自该页，v2.1.178+ 行为）· 相关解读 [腾讯云开发者社区](https://cloud.tencent.com/developer/article/2671463)

> 这是 dsh-agent-teams 的概念源头。核心机制：**一个主会话（Team lead）+ 多个独立 Claude Code 实例（Teammates）+ 共享任务列表 + 邮箱（Mailbox）**，全部落盘在用户目录，进程退出/恢复均有明确语义。

- **定位与架构一句话**：实验性多 Claude Code 实例协作——负责人会话生成队友，队友各自持有独立 context window、直接互发消息、通过**共享任务列表自组织认领**，负责人汇总。
- **启用与组成**：`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`（settings.json 或环境变量）启用；组件 = **Team lead / Teammates / Task list / Mailbox**；v2.1.178 起无需 TeamCreate/TeamDelete 工具（已移除），生成队友即自动成团。
- **落盘与持久化（关键机制）**：
  - 团队名 = `session-` + 会话 ID 前 8 字符；
  - **邮箱**：`~/.claude/teams/{team-name}/inboxes/{agent-name}.json`——agent 间消息总线；读取时逐条校验，格式错误的条目**报告错误并从文件删除**（v2.1.207 前单条坏消息会卡死该邮箱）；
  - **团队配置**：`~/.claude/teams/{team-name}/config.json`——含 `members` 数组（name/agent ID/agent type），队友读它**发现其他成员**；存运行时状态（会话 ID、tmux 窗格 ID），**会话结束时目录删除**，勿手改；
  - **任务列表**：`~/.claude/tasks/{team-name}/`——**本地持久化、永不上传**，恢复的会话保留任务，保留期由 `cleanupPeriodDays` 控制。
- **任务状态机与并发安全**：任务三态 pending / in-progress / completed，**支持任务间依赖**（有未决依赖的 pending 任务不可认领，依赖完成自动解锁）；**认领用文件锁**防多队友竞态。
- **通信机制**：队友消息**自动送达**收件人（负责人无需轮询）；完成/空闲自动通知（`TeammateIdle`）；**SendMessage 工具**按名字定向发消息（每收件人一条）；队友权限提示**冒泡到负责人**；auto 模式下分类器把"来自另一个 agent 的转述批准"视为**不可信输入**（防权限绕过）。
- **Hooks 质量门**：`TeammateIdle` / `TaskCreated` / `TaskCompleted`——exit code 2 = 发送反馈并保持工作 / 阻止创建 / 阻止完成。
- **计划审批（Plan approval）**：队友以**只读计划模式**工作，向负责人发计划批准请求；拒绝则留在计划模式按反馈修订重提；批准后退出计划模式开工——这是"权限冒泡"的**设计例外**。
- **关闭**：按名字请求关闭，队友可批准优雅退出或拒绝并解释；共享目录会话结束时自动清理。
- **显示形态**：in-process（同一终端内 agent 面板，方向键选择 + Enter 查看/私聊 + x 停止 + Ctrl+T 任务列表）或 split panes（tmux / iTerm2 + it2 CLI，`teammateMode: "auto|tmux|iterm2"`、`--teammate-mode`）。
- **模型与上下文**：队友**不继承**负责人 `/model`（可在 `/config` 设默认队友模型）；继承 effort 级别；生成时可用 **subagent 定义**作为队友角色（tools allowlist + model 生效，定义正文追加进 system prompt；`skills`/`mcpServers` frontmatter 不生效）；队友加载项目上下文（CLAUDE.md / MCP servers / skills）但**不继承负责人对话历史**。
- **已知限制**：in-process 队友**无会话恢复**（/resume、/rewind 不恢复队友）；每会话一队、不可嵌套（队友不能再生成队友）、负责人固定不可转移、权限在生成时固定。
- **值得借鉴**：磁盘即状态（JSON 邮箱/任务表/配置）+ 文件锁；**任务依赖自动解锁**；**消息传递与权限冒泡的信任边界**（跨 agent 批准不可信）；**计划审批例外**；hooks 质量门（TeammateIdle/TaskCreated/TaskCompleted）；会话结束自动清理 + 恢复保留任务。

---

## 6. AGNTCY / A2A 协议 / MCP 生态

**来源**：[AGNTCY 文档 docs.agntcy.org](https://docs.agntcy.org/) · [LF 接纳 AGNTCY 公告](https://www.linuxfoundation.org/press/linux-foundation-welcomes-the-agntcy-project-to-standardize-open-multi-agent-system-infrastructure-and-break-down-ai-agent-silos) · [A2A 规范 v1.0](https://a2a-protocol.org/latest/specification/) · [a2aproject/A2A](https://github.com/a2aproject/A2A) · [A2A 流式与异步](https://a2a-protocol.org/v0.1.0/topics/streaming-and-async/) · [MCP 生态增长追踪（ossinsight）](https://github.com/pingcap/ossinsight/issues/2265) · [2026 上半年 MCP 状态](https://www.scrapeless.com/zh/blog/state-of-mcp-h1-2026) · [MCP 2025 爆发与 2026 成熟](https://developer.aliyun.com/article/1725744)

### AGNTCY（思科捐赠给 Linux Foundation 的"agent 互联网基础设施"）
- 定位：为"跨框架、跨组织边界的 agent 互操作"提供**组件与服务**，组成：**Agent Directory Service（ADS）**——联邦式发布/验证/发现注册表；**SLIM**（Secure Low-Latency Interactive Messaging）——网络层安全消息，pub/sub + 流式 + **MLS 加密**；**OASF**（Open Agent Schema Framework）——跨 A2A/MCP 的能力描述数据模型；**Identity**——去中心化身份（标识符、可验证凭证、策略化访问）；Observability & Evaluation、CSIT 集成测试、CoffeeAGNTCY 参考实现。
- 借鉴：**发现注册表 + 能力卡 + 身份/策略**三位一体，是"智能路由"的外部化骨架。

### A2A（Agent2Agent，v1.0.0，Linux Foundation Agentic AI Foundation 旗下，与 MCP 并列）
- 架构分三层：**规范数据模型（spec/a2a.proto 为唯一权威）→ 抽象操作 → 协议绑定（JSON-RPC 2.0 / gRPC / HTTP+JSON/REST，可自定义绑定）**。
- 核心对象：**AgentCard**（JSON 能力声明，发现地址 `/.well-known/agent-card.json`，可 JWS 签名 AgentCardSignature）、**Task**（有状态工作单元：submitted/working/input-required/completed/failed/canceled/rejected）、**Message/Part**（TextPart/FilePart/DataPart）、**Artifact**、**Context**（逻辑分组）。
- 核心操作：`SendMessage` / `SendStreamingMessage` / `GetTask` / `ListTasks`（游标分页）/ `CancelTask` / `SubscribeToTask` / 推送通知配置（Create/Get/List/Delete）/ `GetExtendedAgentCard`；流式事件 `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`；长任务用**服务端 webhook 推送**（带鉴权、幂等、SSRF 防护要求）。
- 原则：**Async-first**（天然支持长任务与 human-in-the-loop）、**Opaque execution**（agent 间只交换声明能力与结果，不暴露内部状态/记忆/工具）；安全方案覆盖 APIKey/OAuth2/OIDC/mTLS；版本协商 `A2A-Version` 头、扩展 `A2A-Extensions` 头。
- **A2A 与 MCP 的关系（规范附录 B 明示）**：MCP = "agent 如何调用某个工具/资源"（连接 LLM 与工具层）；A2A = "agent 之间如何作为对等方协作/委派"（应用层协议）。一个 A2A Server agent 内部可再用 MCP 调工具。

### MCP 生态现状
- 2025 年爆发（工具/数据接入事实标准，聚合 30 万+ star 量级、被 Claude Code/Cursor/各类 IDE 内建），2026 年进入**成熟期**：协议迭代放缓、厂商内建为主、服务器形态收敛到 stdio/HTTP（Streamable HTTP）/SSE（如 Letta SDK 即支持 stdio/HTTP/SSE 三类 MCP server）。
- 借鉴：**协议分层与绑定化**（a2a.proto 单一权威 + 多绑定）、**能力声明卡 + 签名**、**Task 状态机 + 推送通知**适合常驻执行的任务可见性；**发现/身份/策略**适合智能路由的寻址基础。

---

## 7. OpenHands（含新 Agent Canvas / Software Agent SDK）

**来源**：[OpenHands SDK Agent 架构](https://docs.openhands.dev/sdk/arch/agent.md) · [OpenHands 主仓库 README（Agent Canvas）](https://github.com/OpenHands/OpenHands) · [software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) · [旧版 OpenHands 架构 README（镜像）](https://huggingface.co/spaces/Backup-bdg/OpenHands/blob/680c11c666ad03afd828289ba8422f0f9dae9902/openhands/README.md)

- **定位与架构一句话**：开源 AI 软件开发代理——当前产品形态为 **Agent Canvas**（自托管"agent 控制中心"：本地/Docker/VM/云运行 OpenHands、Claude Code、Codex、Gemini 等任意 **ACP** 兼容 agent），底层是 **Software Agent SDK** 的无状态、事件驱动推理-行动循环。
- **记忆/上下文管理（SDK 层，机制最清晰）**：
  - **事件流即真相**：`Event History → Condenser → LLM Query → SecurityAnalyzer → Tool Executor → ObservationEvents`，全链路事件追加（ActionEvent/ObservationEvent/MessageEvent）。
  - **Condenser（可插拔压缩器）**：token 逼近上限时调用 `condenser.condense()`；返回 `View`（本轮用压缩视图继续）或 `Condensation`（先发事件，下个 step 处理）；上下文超限时 emit `CondensationRequest` 中断等待。
  - **AgentContext**：skills（`repo` 型常驻注入 / `knowledge` 型触发词注入）+ system prompt 前缀/后缀/模板，按会话组装。
  - 工具执行严格 **action→observation** 模式；确认模式把动作存为 pending，状态置 `WAITING_FOR_CONFIRMATION`。
- **Agent 生命周期**：**单步 `step()` 模型**——无状态、每步原子、可暂停/恢复；Conversation 层驱动 step 并提供事件历史；Agent Server（REST API）在一台机器上跑多个 agent。
- **任务/调度模型**：**Automation Server（OpenHands/automation）**与 Agent Server 分离——agent 按**调度（schedule）或 webhook 事件**触发，集成 Slack/GitHub/Linear/Notion/Datadog；自动化预构建（报告发布到 Slack、GitHub issue 自动分解）。
- **多 Agent 协同**：单 Agent Server 多 agent；子代理（delegate）模式；Agent Canvas 负责前端编排与后端切换。
- **渠道接入与前端形态**：Web（Agent Canvas）、CLI、Cloud/自托管双形态；通过 **ACP** 统一驱动外部 harness。
- **值得借鉴**：**安全分析器分级**（Low 直跑 / Medium 记录+监控 / High 拦截要确认）；**压缩器返回 View/Condensation 的决策语义**；**Automation Server 与 Agent Server 分离**；**ACP 统一驱动异构 agent**。

---

## 8. OpenClaw（常驻后台 + 定时 + 多渠道的代表）

**来源**：[OpenClaw Docs 索引 llms.txt](https://docs.openclaw.ai/llms.txt) · [Automation 总览](https://docs.openclaw.ai/automation) · [Automations (cron/webhook/Gmail PubSub)](https://docs.openclaw.ai/automation/cron-jobs) · [Memory 架构](https://docs.openclaw.ai/concepts/memory-architecture) · [Active memory](https://docs.openclaw.ai/concepts/active-memory) · [Channels](https://docs.openclaw.ai/channels) · [Agent loop](https://docs.openclaw.ai/concepts/agent-loop)

- **定位与架构一句话**：自托管、**常驻**的个人 AI 网关——本机跑**一个 Gateway 进程（WebSocket 架构）**，把 20+ IM 渠道接入 Claude Code/Codex 等编码 agent（经 ACP），"在任何渠道随时喊到你的 AI 助手"。
- **记忆/上下文管理**：
  - 内置 **SQLite 记忆引擎**：关键词/向量/混合三种检索模式；记忆分**层级 + 来源（provenance）+ 召回通道（recall lanes）+ 用户模型 + standing intents（长期意图）**；
  - **Active memory**：深度会话历史召回，**仅当确定性记忆召回不足时才升级**（分级兜底）；
  - **Dreaming**：后台记忆整合，分 **light / deep / REM 三阶段** + Dream Diary；`openclaw memory` 子命令（status/index/search/promote/promote-explain/rem-harness/rem-backfill/session-backfill）；memory-wiki vault（Obsidian 可导入）；
  - **Compaction**：超长会话自动摘要；**Context engine**：可插拔上下文组装 + 压缩 + 子代理生命周期；会话存储 + transcripts 落盘（`openclaw transcripts`）。
- **Agent 生命周期**：Gateway 作为系统服务常驻（daemon）；**agent loop** 有明确的生命周期/流/等待语义；`openclaw sessions`（列出/归档/删除）、`openclaw resume`（把 TUI 挂回最近 Gateway 会话）；**background tasks 台账**统一跟踪 ACP runs / 子代理 / 自动化运行；**managed worktrees**（隔离 git checkout 跑任务 + 自动快照清理）。
- **任务/调度模型**：**Automations** = 定时任务（cron）+ webhook + **Gmail PubSub** 触发器，挂在 Gateway 调度器上；**Hooks** = 命令/生命周期事件驱动；**Standing orders** = 为自主 agent 程序定义"永久操作授权"（含审批）；**Task Flow** 编排层；`openclaw automations` CLI。
- **多 Agent 协同**：**subagents**（隔离后台运行、结果播报回发起会话）；**swarm**（Code Mode 脚本里并发 fan-out 子代理 + 结构化结果）；**agent bindings**（把渠道账号/会话路由到指定 agent）；**main session**（跨所有渠道的"一条滚动会话"）。
- **渠道接入与前端形态**：Discord / Google Chat / iMessage / Matrix / Teams / Signal / Slack / Telegram / WhatsApp / Zalo / **微信（openclaw-weixin 插件）/ 企业微信 / QQ / 飞书 / LINE / SMS(Twilio) / IRC / Nostr / Twitch / Mattermost** 等 20+ 渠道；前端 = **Control UI（Web）** + TUI + macOS app + iOS/Android。
- **值得借鉴**：**网关进程模型**（单常驻进程挂多 channel，channel 只做协议适配）；**active memory 分级升级召回**；**standing orders（长期操作授权）+ 审批**；**automations = cron + webhook + PubSub 统一进 Gateway 调度器**；**background task 台账**；**main session 跨渠道连续会话**。

---

## 9. 补充观察（同类重要项目）

- **[Mem0](https://github.com/mem0ai/mem0)**：agentic memory 中间层——从对话中**自动提取/更新**记忆，向量 + 图谱双检索，配记忆操作 API（add/search/update/delete）；适合做"记忆即服务"，AgentScope 已将其作为可切换后端。
- **[LangGraph](https://langchain-ai.github.io/langgraph/)**：图状态机 + **checkpointer**（每步状态落盘、线程级续跑）+ durable execution，是"可恢复长任务"的工程范式（常驻执行与恢复的参考实现）。
- **[Temporal](https://temporal.io)**（非 agent 专用）：**durable workflow 引擎**——时间编排（cron/sleep）、确定性重放、无限重试与断点续跑；常驻后台执行可借鉴其"执行即事件日志、重放即恢复"的模型。

---

## 10. 跨项目横向对比表

| 项目 | 定位 | 记忆管理 | 生命周期 | 调度 | 协同 | 借鉴点 |
|---|---|---|---|---|---|---|
| **Letta (MemGPT)** | 有状态、可自学习 agent 平台（harness） | MemFS（git 版记忆文件系统）+ `system/` 常驻 + 文件树路标 + Dreaming 子代理整理 + 可选向量/混合检索 | agent 身份跨模型/机器持久；App Server `runtime_start/input/sync/abort`；teleportation 迁会话 | `letta cron add`（--cron/--at/--every/--runner/--computer）；云/本地双轨，失联回退 sandbox | subagents + sleep-time 反思子代理 + shared memory | git 记忆基质、分层上下文契约、Dreaming+worktree、双轨调度 |
| **AutoGPT Platform** | 可视化块图 agent 构建平台 | BlockSchema 强校验 I/O + 执行结果持久化 + `compress_prompt`；状态机含 REVIEW | 图执行异步排队（RabbitMQ）+ 全量入库 | Scheduler 微服务(:8003, apscheduler) 定时+webhook | AgentExecutorBlock 图内嵌图 | block 即 async generator、执行状态机、调度独立服务、凭证分布式锁 |
| **Alibaba AgentScope** | 消息中心化多 agent 平台（v1 Msg/Actor/pipeline/msg-hub；v2 agent service） | Context 中间件（自动压缩/工具结果卸载/注入）+ 可切换记忆后端（ReMe/Mem0） | ReAct 实时中断/恢复；后台任务卸载+结果唤醒；SQL/NoSQL 持久化 | Scheduled tasks + agent wakeup + 后台任务卸载 | Agent Team（leader-worker + 团队工具 + 任务规划）；v1 msg-hub | 中间件式循环钩子、sandbox 抽象、后台任务唤醒、团队工具内建 |
| **Dify / Flowise / n8n** | 低代码 agent 编排平台（LLMOps/iPaaS） | 会话变量 + agent 节点对话记忆 + RAG 知识库 | 触发驱动短生命周期；n8n queue mode 扩容 | **定时触发为一等图节点**（cron）+ webhook + 队列 | 图内嵌 agent 节点 + 分支/sub-workflow | 定时触发可视化、确定性节点与 agent 同图、插件+MCP 市场 |
| **Claude Code Agent Teams** | 多 Claude Code 实例团队协作（实验性） | 各队友独立 context；只继承项目上下文不继承 lead 历史 | 磁盘落盘（config/tasks/inboxes）；会话结束清理、任务列表持久可恢复 | 共享任务列表（三态+依赖+文件锁认领） | Mailbox（JSON 邮箱）+ SendMessage + 任务依赖自动解锁 + 计划审批 | 磁盘即状态、任务依赖自动解锁、跨 agent 信任边界、hooks 质量门 |
| **AGNTCY / A2A / MCP** | agent 互操作基础设施与协议 | 不管理记忆；OASF 描述能力；A2A opaque execution | Task 状态机 + Artifact + 推送通知（长任务） | Async-first：流式/推送/轮询 | AgentCard 发现 + 委派协作；A2A Server 内用 MCP 调工具 | 能力卡+签名、发现/身份/策略、Task 状态机+推送、proto 单一权威多绑定 |
| **OpenHands** | 开源软件开发 agent（SDK + Agent Canvas 控制中心） | 事件流即真相 + Condenser 可插拔压缩（View/Condensation）+ skills 分型注入 | 单步 `step()` 无状态可暂停/恢复；Agent Server 常驻 | Automation Server 独立：schedule + webhook 事件 | 子代理 + 多后端 agent；ACP 统一驱动 | 事件流即真相、压缩器决策语义、安全分析器分级、自动化与服务分离 |
| **OpenClaw** | 常驻个人 AI 网关（多渠道接入编码 agent） | SQLite 记忆引擎（词/向量/混合）+ 层级/来源/召回通道 + Active memory 分级 + Dreaming(light/deep/REM) + compaction | Gateway daemon 常驻；sessions 归档/resume；background tasks 台账 | Automations（cron+webhook+Gmail PubSub 进 Gateway 调度器）+ Hooks + Standing orders | subagents/swarm + agent bindings 路由 + main session 跨渠道连续 | 网关进程模型、active memory 分级召回、standing orders 授权、调度器统一 |

---

## 11. 面向"白盒记忆 + 常驻执行 + 智能路由 Agent OS"的 8 个借鉴点

1. **MemFS：用 git 做记忆基质（Letta）**——每条记忆写入即 commit，天然获得版本历史、回滚、冲突解决与审计轨迹，恰好满足"白盒记忆可审计可回滚"；记忆子代理用 git worktree 并发更新，不阻塞主 agent。
2. **分层上下文契约：`system/` 常驻 + `reference/` 按需 + 文件树作路标（Letta）**——显式规定什么进上下文、什么顺序、留多久，记忆寻址即路径寻址，白盒可解释、可审计。
3. **Dreaming 后台记忆整理：sleep-time 子代理 + "reviews before applying"（Letta / OpenClaw）**——在空闲或压缩触发点用独立子代理沉淀长期记忆并二次复核，把记忆维护从主循环剥离开（OpenClaw 进一步分 light/deep/REM 三阶段）。
4. **磁盘即状态 + 文件锁认领 + 依赖自动解锁（Claude Code Agent Teams）**——邮箱（`inboxes/{agent}.json`）、任务列表（`tasks/{team}/`）、团队配置（`config.json`）全部落盘，任务认领用文件锁防竞态、依赖完成自动解锁，会话结束清理、恢复保留任务——用最简单持久化实现可恢复的多实例协同。
5. **事件流即真相 + 可插拔 Condenser（OpenHands SDK）**——agent 无状态、每步 `step()` 原子可暂停/恢复，上下文压缩器返回 View（本轮继续）或 Condensation（先落事件）两种决策，压缩本身也变成可审计的事件。
6. **调度器独立成服务 + 定时/webhook/PubSub 统一入口 + 失联兜底（AutoGPT / Letta / OpenClaw）**——AutoGPT Scheduler(:8003, apscheduler) 独立于执行器；Letta 云调度在目标机器离线时回退 cloud sandbox；OpenClaw 把 cron+webhook+Gmail PubSub 统一挂到 Gateway 调度器——常驻执行的最短路径。
7. **AgentCard 能力声明 + 发现/身份/策略（A2A + AGNTCY）**——agent 用签名的 JSON 卡声明能力、接口、鉴权方案（`/.well-known/agent-card.json`），ADS 注册表 + DID/可验证凭证做寻址与授权——让"智能路由"从硬编码变成按能力卡匹配的可审计决策。
8. **渠道网关进程模型 + 跨渠道单一会话（OpenClaw / Letta Channels）**——一个常驻 Gateway 进程挂 20+ 渠道、渠道只做协议适配（agent bindings 决定消息路由到哪个 agent），全部渠道共享同一条滚动会话（main session）——多接入形态下保持对话连续性与恢复能力。

---

### 附：本次调研未覆盖/建议后续
- Letta 的 Context Constitution 仓库正文、Letta Cloud 具体实现未逐行精读；
- n8n/Flowise 仅做概要对比（重点给了 Dify）；
- AutoGPT Copilot 系统（聊天式构建）只提及未深挖；
- 若需落地建议，可再对比 LangGraph checkpoint 机制与 Sati `resume/TaskResumeScanner` 的异同。
