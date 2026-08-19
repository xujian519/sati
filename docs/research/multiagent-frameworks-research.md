# 多智能体编排框架调研笔记（单会话驱动的多智能体团队协作视角）

> 调研日期：2026-08；调研口径：聚焦"一次用户会话/一个任务入口 → 驱动多个 agent 协作"的设计，逐项回答：定位与架构、团队/角色/任务建模、状态持久化、成员通信、人机协同（HITL）、失败处理与重试、代表性亮点。所有机制名均来自官方文档/源码/论文。

---

## 1. Microsoft AutoGen（v0.4 AgentChat / autogen-core）

- **定位一句话**：微软出品；`autogen-core` 是"基于 actor 模型的事件驱动分布式运行时"，`AgentChat` 在其上提供"一次 `run(task)` 驱动一组 agent 协作"的高层团队抽象。
- **团队/角色/任务建模**：agent 实现 `on_messages`/`on_messages_stream` 协议；团队类型：`RoundRobinGroupChat`（轮询发言）、`SelectorGroupChat`（LLM selector 选发言人）、`Swarm`（handoff 消息流转）、`MagenticOneGroupChat`（编排器式）；`run_stream(task)` 由团队管理器（`group_chat_manager`）单线程逐轮调度一个 agent，产出 `AgentEvent` 事件流（ModelClientStreamEvent / ToolCallExecutionEvent 等）。"任务"即一条 task 消息进入团队；何时停由 Termination 条件对象决定：`MaxMessageTermination`/`TextMentionTermination`/`TokenUsageTermination`/`TimeoutTermination`/`ExternalTermination`/`HandoffTermination`。
- **状态持久化**：AgentChat 每个组件实现 `save_state()`/`load_state()`，状态为版本化 dict（`TeamState{agent_states, current_turn}`），可序列化落 JSON 文件或 DB；`CheckpointManager` 支持按 checkpoint interval 自动保存/恢复；core 层 `Persistence` 协议 + `StateStore` 实现（PostgreSQL / MongoDB / SQLite / Redis）持久化运行时与订阅；`AgentMemory`（ListMemory / AssistantMemory）提供可选记忆。
- **成员通信**：无 P2P——agent 消息经运行时 topic 发布/订阅（`DefaultSubscription`、`MessageEnvelope`）或团队管理器中转；团队是"单线程调度器"，一次只驱动一个 agent。
- **HITL**：`UserProxyAgent`（`input_func` 同步/异步回调向人类索取输入）；`HandoffMessage` 把控制交回人或另一 agent；`ExternalTermination` 供外部（UI/人）终止；有官方 HITL 教程与 UI 集成讨论。
- **失败处理**：团队 run 捕获异常按 `OnExceptionPolicy`（raise / stop）处理；模型客户端内置重试；Termination 超时/消息数上限防死循环；MagenticOneGroupChat 用 ledger 重计划。
- **亮点**：事件驱动运行时与团队编排解耦；全组件 `save/load_state`；Swarm handoff；`run_stream` 事件流天然适配 UI 进度展示；官方 AutoGen Studio 可视化。

来源：[DeepWiki Agent Runtime System](https://deepwiki.com/microsoft/autogen/2.1-agent-runtime-system) · [autogen_core.AgentRuntime API](https://microsoft.github.io/autogen/0.4.3/reference/python/autogen_core.html) · [Managing State 教程](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/state.html)（已核对）· [Topic/Subscription 场景](https://microsoft.github.io/autogen/0.4.9/user-guide/core-user-guide/cookbook/topic-subscription-scenarios.html) · [v0.4 架构预告讨论](https://github.com/microsoft/autogen/discussions/3601) · [Teams 综述](https://gettingstarted.ai/blog/autogen-teams/) · [HITL with UI 讨论](https://github.com/microsoft/autogen/discussions/5324)

## 2. CrewAI

- **定位一句话**：面向业务编排的"crew"框架——把 agent（role/goal/backstory 提示词工厂）+ task（description/expected_output）+ process 组装成一次 `kickoff` 执行。
- **团队/角色/任务建模**：sequential process 按任务列表顺序执行，前一 task 输出成为后一 task 的 `context`；hierarchical process 由 manager agent（`manager_llm`/`manager_agent`）动态委派；任务间靠 `context` 与 `output_pydantic`/`output_json` 结构化衔接（无显式 DAG）；**CrewAI Flows**（`@start`/`@listen`/`@router` 装饰器）补充事件驱动编排。
- **状态持久化**：记忆子系统（short-term / long-term / entity / crew memory），SQLite + 向量库（Chroma / PGVector 等）双后端；task 输出可经 `TaskOutputStorageHandler`（SQLite / JSON / file）落盘；Flows 支持 `persistent_flow_state`（SQLite 实现于 `flow/persistence/sqlite.py`）；`crew.replay()` 从某 task 重放。
- **成员通信**：无 agent 间直接消息——数据经"task 输出 → 下游 context"管道 + 共享 crew 短期记忆传递。
- **HITL**：官方 HITL 文档；`human_input=True`（执行前/后暂停询问，经 `HumanInputTool`/`HumanInputAgent` 实现）；Flows 可监听事件人工介入。
- **失败处理**：LLM 调用重试依赖 litellm（`num_retries`）；task 级失败无强内置恢复，`replay` 是主要恢复手段。
- **亮点**：角色化 prompt 工厂；hierarchical manager 委派；任务上下文管道化；replay；Flows 事件驱动补足静态 process。

来源：[Processes](https://docs.crewai.com/v1.14.7/en/concepts/processes) · [Tasks](https://docs.crewai.com/v1.15.6/en/concepts/tasks) · [Human Input on Execution](https://docs.crewai.com/v1.12.0/en/learn/human-input-on-execution) · [HITL 工作流](https://docs.crewai.com/v1.11.0/en/learn/human-in-the-loop) · [DeepWiki Memory and Knowledge](https://deepwiki.com/crewAIInc/crewAI/7-memory-and-knowledge-systems) · [hierarchical 源码](https://github.com/crewAIInc/crewAI/blob/89454578/lib/crewai/src/crewai/crew.py#L443-L447) · [Flows SQLite 持久化](https://github.com/crewAIInc/crewAI/blob/e21c5062/lib/crewai/src/crewai/flow/persistence/sqlite.py#L74-L120)

## 3. MetaGPT

- **定位一句话**："软件公司"范式——SOP（标准作业程序）把角色（Role）固化为输入/输出契约明确的动作序列，`Team` 在共享环境里跑多轮协作。
- **团队/角色/任务建模**：`Team.hire(roles)` + `run_project(idea, send_to)`；`Role` 由多个 `Action` 组成（think/act 循环），`ActionNode` 定义结构化输出（PRD/Design/Code）；`n_round` 限制协作轮数；环境空闲检测（所有角色无新消息）自动停止。
- **状态持久化**：`Role.memory`（ContextMixin + MemoryStorage 可挂向量库 FAISS 等）；角色上下文可序列化恢复（DeepWiki "Context Serialization and Recovery"；[issue #1436](https://github.com/FoundationAgents/MetaGPT/issues/1436) 讨论 resume）；产物写文件系统。
- **成员通信**：黑板式——角色向环境消息池 publish 结构化消息，其他角色按"消息类型 + 来源"订阅（watch）；MGXEnv 新版本强化消息编排。
- **HITL**：`UserRequirement`/`AddRequirement` 动作与 human interaction 文档（用户在对话中注入指令）；非一等公民。
- **失败处理**：n_round 上限防无限对话；LLM 调用重试；无编排级恢复。
- **亮点**：SOP 编码角色 + 结构化中间产物（"写文档即通信"）；黑板 pub/sub；RoleZero 动态 SOP 生成。

来源：[DeepWiki Core Multi-Agent Framework](https://deepwiki.com/FoundationAgents/MetaGPT/2-core-multi-agent-framework) · [Team Orchestration and Environment](https://deepwiki.com/FoundationAgents/MetaGPT/2.4-team-orchestration-and-environment) · [Context Serialization and Recovery](https://deepwiki.com/FoundationAgents/MetaGPT/10.2-context-serialization-and-recovery) · [human_interaction 文档](https://github.com/geekan/MetaGPT-docs/blob/main/src/en/guide/use_cases/agent/interpreter/human_interaction.md) · [memory_storage.py](https://github.com/FoundationAgents/MetaGPT/blob/6dfa4e2c9e44d8db8e8e1c67646ae88d4547c968/metagpt/memory/memory_storage.py)

## 4. LangGraph

- **定位一句话**：低层图执行引擎 + 可插拔 checkpoint 持久化 + 部署层（langgraph-sdk / Platform）——多智能体/工作流表达为"带状态的图"，图状态每步 checkpoint，支持无限期暂停/恢复。
- **团队/角色/任务建模**：`StateGraph`（nodes / edges / conditional edges）；`Send` API 动态扇出（map-reduce）；subgraph 嵌套；langgraph-sdk 提供 Threads（`thread_id` 隔离会话）、Runs（stateful / stateless / cron / background）、SSE/WebSocket 流式。"单会话" = 一个 thread 上连续的多轮 run。
- **状态持久化**：`BaseCheckpointSaver` 实现族：`MemorySaver`/`SqliteSaver`/`AsyncSqliteSaver`/`PostgresSaver`/`RedisSaver`，每个 super-step 后落 checkpoint（状态快照 + 元数据）；`get_state`/`update_state`/`update_state_as_node` 支持时间旅行（fork/回放）；长期记忆用 `BaseStore`（InMemoryStore / PostgresStore，namespace 键）。
- **成员通信**：无 agent 间消息——一切经共享图 state（channels）与节点返回值；Send 分支子图写回同一 state。
- **HITL**：`interrupt()`（节点内动态暂停）、`interrupt_before`/`interrupt_after`（静态断点）、`Command(resume=...)` 恢复；官方四种模式：批准/拒绝、编辑图状态、审查工具调用、校验人工输入；sdk `/threads/{id}/runs` + webhook 支持异步人工审批。
- **失败处理**：`recursion_limit` 防死循环；Platform/CLI `retry_policy`（ExponentialBackoff / max_attempts）节点级重试；从 checkpoint 恢复/回退。注意 [diagrid 文章](https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows) 指出"checkpoint ≠ durable execution"——进程崩溃后的副作用恢复仍要自己处理。
- **亮点**：可插拔 checkpoint 后端；interrupt/Command 是业界最清晰的 HITL 原语；threads 模型天然支撑"单会话多轮多智能体"；Send map-reduce；时间旅行调试。

来源：[Human-in-the-loop 概念文档](https://raw.githubusercontent.com/langchain-ai/langgraph/7f08a6dafda133f0b4db9d169b0445a3dee7b466/docs/docs/concepts/human_in_the_loop.md)（已核对）· [Checkpointing](https://mintlify.wiki/langchain-ai/langgraph/concepts/checkpointing) · [Server API HITL](https://docs.langchain.com/langsmith/add-human-in-the-loop) · [Map-Reduce / Send API](https://machinelearningplus.com/gen-ai/langgraph-map-reduce-parallel-execution/) · [Fault tolerance](https://docs.langchain.org.cn/oss/javascript/langgraph/fault-tolerance) · [DeepWiki HITL capabilities](https://deepwiki.com/langchain-ai/langgraph/3-human-in-the-loop-capabilities)

## 5. OpenAI Agents SDK（原 Swarm）

- **定位一句话**：轻量 agent 循环框架——单 `Runner.run` 跑一个 agent 循环，用一等公民 `handoffs` 做跨 agent 控制权转移；前身是 Swarm。
- **团队/角色/任务建模**：agent = instructions / tools / handoffs / guardrails；triage 模式（路由 agent 按意图 handoff 到专业 agent）；`Agent.as_tool()` 把 agent 当工具嵌套；无显式任务图，全凭 LLM 选择 handoff；多语言（Python / JS / .NET）。
- **状态持久化**：`Session`（id / `state`(JSON) / `input_items` / `output_items`）经 session store（InMemory / Sqlite / Redis / File…）保存会话续跑；内建 tracing（Trace / Span + exporters）。
- **成员通信**：handoff 专用输出项（`AgentHandoff`）转移控制权；上下文靠 session items 累积 + `context_variables`（Swarm 遗留）。
- **HITL**：非一等公民——官方模式是用自定义"人工审批"工具或 guardrail 拦截实现。
- **失败处理**：`max_turns`；无内建编排级重试（tool 异常上抛）；session 续跑弥补跨进程。
- **亮点**：handoff 作为一等控制流原语；triage 路由；guardrails（input/output）双端校验；tracing 内建；极简多语言。

来源：[PyPI openai-agents](https://pypi.org/project/openai-agents/0.2.2/) · [Sessions 官方文档](https://openai.github.io/openai-agents-python/sessions/) · [DeepWiki Session Protocol](https://deepwiki.com/openai/openai-agents-python/8.1-session-protocol) · [Sessions Persistence 教程](https://turion.ai/blog/openai-agents-sdk-sessions-persistence-tutorial/) · [Agent Patterns Catalog](https://www.agentpatternscatalog.org/compositions/openai-agents-sdk/)

## 6. CAMEL-AI

- **定位一句话**：角色扮演（inception prompting）研究框架 → 通用多智能体平台：ChatAgent / RolePlaying / AgentSociety + 记忆 + 工具 + 工作流。
- **团队/角色/任务建模**：`RolePlaying`（assistant/user 双角色 + task inception 自动扩展任务与分工）；`TaskPlanningAgent`/`TaskSolvingAgent` 拆解-求解两级；`Society`/`AgentSociety`（`bootstrap`/`construct`）组建 agent 社会；`MessageHub` 支持多方会话。
- **状态持久化**：记忆层 `LongtermAgentMemory`（working + long-term，向量库 Qdrant/Milvus/Chroma 等后端）；对话历史内存态；无运行级 checkpoint。
- **成员通信**：`MessageHub`——通道注册 + publish/retrieve 的黑板式；角色扮演为直接对话。
- **HITL**：弱——无一等公民 HITL；可在对话中注入 User 消息。
- **失败处理**：工具调用错误纠正/重试；编排级弱。
- **亮点**：任务 inception；TaskPlanning→TaskSolving 两级拆解；MessageHub 通道化黑板；[OASIS](https://arxiv.org/html/2411.11581v5) 百万 agent 社会模拟。

来源：[CAMEL 官方文档（Society）](https://docs.camel-ai.org/key_modules/societies) · [memory.mdx](https://github.com/camel-ai/camel/blob/8a75a567/docs/mintlify/key_modules/memory.mdx) · [CAMEL 论文](http://arxiv.org/pdf/2303.17760) · [Agent Patterns Catalog](https://www.agentpatternscatalog.org/compositions/camel-ai/) · [LongtermAgentMemory](https://theneuralbase.com/camel-ai/learn/intermediate/longtermagentmemory/)

## 7. ChatDev

- **定位一句话**："聊天式软件开发公司"——ChatChain（YAML 配置的阶段链），每阶段两个角色对话完成一个环节（需求/设计/编码/测试/文档）。
- **团队/角色/任务建模**：`ChatChain` 由 `Phase` 组成；每 Phase 定义 `assistant_role_name`/`user_role_name` + 提示模板（如 CTO/CPO、instructor-assistant 对）；`phase_env`（阶段内）与 `chat_env`（全局共享环境 dict）跨阶段传递产物；静态顺序链，无并行。
- **状态持久化**：每阶段对话历史（`Record` 类）与 chat_env 快照写文件系统（logs/、Software/）；Memory Backends 可接向量记忆；Experiential Co-Learning（ECL）把经验写回复用库。
- **成员通信**：阶段间经 `chat_env` 黑板；阶段内两 agent 直接对话；语义记忆跨项目复用。
- **HITL**：交互模式允许人类扮演 user 角色参与阶段对话。
- **失败处理**：LLM 调用重试；无编排级恢复（论文原型阶段）。
- **亮点**：阶段链 SOP 用 YAML 声明（可改可复用）；两角色"指令-执行"对话模式；chat_env 产物交接；双环（semantic memory + ECL 经验库）。

来源：[ChatDev ACL 2024 论文](https://aclanthology.org/2024.acl-long.810/) · [DeepWiki Phase System](https://deepwiki.com/OpenBMB/ChatDev/11.3-phase-system) · [DeepWiki Memory Backends](https://deepwiki.com/OpenBMB/ChatDev/7.4-memory-backends) · [IBM watsonx 教程](https://www.ibm.com/think/tutorials/chatdev-chatchain-agent-communication-watsonx-ai)

## 8. Microsoft Magentic-One

- **定位一句话**：通用任务多智能体系统——Orchestrator 主循环 + 四个工具专才（WebSurfer / FileSurfer / Coder / ComputerTerminal），以双账本做自适应计划。
- **团队/角色/任务建模**：外循环=编排器（计划→任务拆分→委派→评估结果→重计划），内循环=各专才 agent 的"观察-思考-行动"任务循环；`Task` 对象 + `TaskOutcome`（success/failed/incomplete）回报；`task ledger`（facts/guesses/plan）+ `progress ledger` 双账本驱动下一步；AutoGen 版 `MagenticOneGroupChat` 用 selector + handoff 实现。
- **状态持久化**：ledger 内存态（v1）；MagenticOneGroupChat 可借 AgentChat `save/load_state`；V2（基于 Microsoft Agent Framework）支持线程持久化。
- **成员通信**：编排器中转——agent 不直接互聊，只与编排器交互（Task / TaskOutcome 消息）。
- **HITL**：编排器带 `human_in_the_loop` 开关——任务完成/关键节点请求人类确认。
- **失败处理**：编排器读 TaskOutcome：失败→换策略 / 换 agent / 拆分重试；ledger 提供进展审计避免重复劳动；内循环有 max_turns 约束。
- **亮点**：task/progress 双账本（可解释进度 + 防抖）；编排器-专才分工（工具域隔离）；双循环架构；V2 的 operators（deep research / document intelligence / browser automation / coding）。

来源：[Magentic-One 论文](https://ar5iv.labs.arxiv.org/html/2411.04468v1) · [AgentPatterns Magentic Orchestration](https://agentpatterns.ai/multi-agent/magentic-orchestration/) · [AutoGen Magentic-One 指南](https://microsoft.github.io/autogen/stable/_sources/user-guide/agentchat-user-guide/magentic-one.md.txt) · [Leeroopedia Orchestrator 实现](https://leeroopedia.com/index.php/?title=Implementation:Microsoft_Autogen_MagenticOne_Orchestrator)

## 9. 补充同类项目（简）

- **Google ADK**：`FlowsAgent`（DAG）/ `ParallelAgent` / `SequentialAgent` / `LoopAgent`；`transfer_to_agent` handoff；`session.state` 共享 + SessionService（InMemory / SQLAlchemy / Firestore / Spanner / Bigtable）持久化；`before_model_callback` / `after_model_callback` 做 HITL 钩子。来源：[ADK 多智能体 Codelab](https://codelabs.developers.google.com/codelabs/production-ready-ai-with-gc/3-developing-agents/build-a-multi-agent-system-with-adk)
- **LlamaIndex Workflows**：纯事件驱动——`@step` 装饰器、emit `StartEvent`/`StopEvent`/自定义事件、`Context` 在步骤间共享数据、事件类型校验、`draw_all_possible_flows` 可视化。来源：[Workflows 文档](https://developers.llamaindex.ai/python/llamaagents/workflows/customizing_entry_exit_points/) · [workflows-ts](https://github.com/run-llama/workflows-ts)
- **AG2**（AutoGen 继承者）：`GroupChat` + manager 动态选发言人、nested chats、自治 speaker selection。来源：[AG2 README](https://github.com/ag2ai/ag2/blob/main/README.md) · [DeepWiki GroupChat](https://deepwiki.com/ag2ai/ag2/2.4-groupchat-and-multi-agent-orchestration)
- **Microsoft Agent Framework**（AutoGen + Semantic Kernel 合并继任）：threads（`AgentThreadStore`）持久化会话、`GroupChatManager`、harness、1.0 GA。来源：[MS Learn 概览](https://learn.microsoft.com/en-us/agent-framework/overview/agent-framework-overview) · [InfoQ GA 报道](https://www.infoq.com/news/2026/08/agent-framework-harness-ga/)
- **A2A 协议**：Google 主导的 agent↔agent 开放协议（AgentCard / Task / messages / push notifications），与 MCP 互补，已并入 Agentic AI Foundation。来源：[google-A2A](https://github.com/wilsonsilva/google-A2A) · [A2A 加入 Agentic AI Foundation](https://www.enterpriseaiworld.com/Articles/News/News/Googles-A2A-Open-Standard-Joins-the-Agentic-AI-Foundation-Enabling-Collaboration-with-Other-Open-Agent-Infrastructure-Projects-176164.aspx)

---

## 10. 跨项目横向对比表

| 项目 | 定位 | 任务模型 | 通信 | 持久化 | HITL | 失败恢复 | 值得借鉴点 |
|---|---|---|---|---|---|---|---|
| **AutoGen v0.4 AgentChat** | actor 事件驱动运行时 + 高层团队抽象 | 团队类型（轮询/selector/swarm/orchestrator），单 task 驱动，Termination 对象控停 | 运行时 topic pub/sub（无 P2P），团队管理器中转 | 全组件 `save_state/load_state`（版本化 dict）、`CheckpointManager`、StateStore(Postgres/Mongo/SQLite/Redis)、AgentMemory | `UserProxyAgent.input_func`、`HandoffMessage` 交回人、`ExternalTermination` | `OnExceptionPolicy`(raise/stop)、模型客户端重试、Termination 上限 | 团队级状态快照；事件流驱动 UI；Termination 对象化 |
| **CrewAI** | 业务编排 crew（角色+任务+process） | sequential 管道 / hierarchical manager 委派；Flows 事件驱动 | task 输出→下游 `context` 管道 + 共享短期记忆 | 四类 memory(SQLite+向量库)、`TaskOutputStorageHandler`、Flows SQLite 持久态、`replay()` | `human_input=True` + HumanInputTool/Agent | litellm 重试、replay | 角色 prompt 工厂；manager 委派；任务输出管道+replay |
| **MetaGPT** | SOP 软件公司范式 | `Team.run_project`、Role(Action 链) + `ActionNode` 结构化产物、n_round 限轮 | 环境消息池黑板 pub/sub，按消息类型订阅 | Role.memory（向量库）、上下文可序列化、产物落盘 | UserRequirement / 对话注入指令 | n_round 防循环、LLM 重试 | 结构化中间产物=通信单元；SOP 固化角色 |
| **LangGraph** | 图执行引擎 + checkpoint 持久化 + SDK/Platform | StateGraph 节点/边/Send 扇出；threads 承载多轮会话 | 共享图 state（channels），无 agent 间消息 | `BaseCheckpointSaver`（Memory/Sqlite/Postgres/Redis）、`BaseStore` 长期记忆、时间旅行 | `interrupt()`/`interrupt_before/after` + `Command(resume)`，四模式 | `recursion_limit`、`retry_policy`(ExponentialBackoff/max_attempts)、checkpoint 恢复 | HITL 原语最完整；threads 会话模型；可插拔 checkpointer |
| **OpenAI Agents SDK** | 轻量 agent 循环 + handoff 控制流 | 单 agent 循环 + handoff 转移；triage 路由；`Agent.as_tool()` | `AgentHandoff` 消息转移控制权；session items 累积 | `Session`(id/state/items) + session store(InMemory/Sqlite/Redis/File)；tracing | 无一等公民（工具/guardrail 模拟） | `max_turns`；session 续跑 | handoff 一等原语；triage 模式；guardrails 双端校验 |
| **CAMEL-AI** | 角色扮演研究框架→通用平台 | `RolePlaying`+task inception；TaskPlanning→TaskSolving；Society | `MessageHub` 通道黑板 + 直接对话 | LongtermAgentMemory（向量库后端）；无运行级 checkpoint | 弱（User 消息注入） | 工具调用纠错重试 | 任务 inception；拆解-求解两级；通道化黑板 |
| **ChatDev** | 聊天式软件公司（阶段对话链） | `ChatChain`（YAML）→`Phase`（assistant/user 双角色），静态顺序 | 阶段内直接对话；阶段间 `chat_env` 黑板 | Record 对话历史 + chat_env 快照落文件；向量记忆；ECL 经验库 | 交互模式人类扮演 user | LLM 重试（弱） | 阶段链 SOP 声明式；双角色对话；产物交接 env |
| **Magentic-One** | 编排器-专才通用任务系统 | 外循环规划/委派 + 内循环执行；`Task`/`TaskOutcome`；双账本驱动 | 编排器中转（agent 不互聊） | ledger 内存态；V2 走 MS Agent Framework 线程持久化 | `human_in_the_loop` 开关，任务级确认 | 失败→换策略/换 agent/重拆分；ledger 防重复 | 双账本（facts/plan + progress）；工具域隔离专才；双循环 |

---

## 11. 对"专利智能体操作系统"最值得借鉴的 8 个设计点

1. **双账本（task ledger + progress ledger，Magentic-One）**：把"事实/猜测/计划"与"已做/结论/待办"分开记录，作为编排器的可解释记忆与审计线索——专利多阶段管线（检索→特征比对→撰写→质检）进度透明、可追溯、可防重复劳动。
2. **interrupt()/Command(resume) 双断点 HITL 原语（LangGraph）**：静态 `interrupt_before/after` + 节点内动态 `interrupt()` + `Command(resume=...)` 恢复，把"人工审批"变成语言级暂停-编辑-恢复，比现有 approval 总线更贴合"图内断点续跑"。
3. **全组件 save_state/load_state（AutoGen AgentChat）**：agent、team、终止条件都提供版本化状态序列化，支撑无状态 Web 端点与断点续跑——与 Sati 现有 `JsonlTranscriptWriter`/TaskResumeScanner 呼应，可补"团队级快照 + 自动 checkpoint"。
4. **handoff 作为一等控制流原语（OpenAI Agents SDK / AutoGen Swarm）**：成员间职责交接用显式 `HandoffMessage`/`AgentHandoff` + triage 路由，避免"所有成员看到所有消息"，适合专利管线中"检索员→比对员→撰写员"的角色交接。
5. **结构化中间产物=黑板消息（MetaGPT SOP）**：角色产出类型化文档（PRD/Design/Code）作为通信单元，成员订阅"产物类型"而非自由文本——专利域即"检索报告/特征对比表/权利要求初稿/质检报告"作为黑板消息类型。
6. **编排器-专才工具域隔离（Magentic-One / AutoGen 的 domain 机制）**：Orchestrator 只规划，专才 agent 各自只暴露一类工具（检索域/比对域/撰写域）——Sati 已有 `visibleDomains/hiddenDomains`，可升级为"专才只见其域工具"以降低模型工具噪音。
7. **任务上下文管道 + 类型化输出（CrewAI context + output_pydantic + replay）**：下游任务只消费上游任务的类型化输出，`crew.replay()` 从某任务重放——专利阶段间强依赖天然适配，且支持审计与局部重跑。
8. **线程/会话 = 持久化隔离单元（LangGraph threads + langgraph-sdk、OpenAI Session、ADK SessionService）**：把"一次专利委托"建模为 thread/session，多轮 run 共享 state，附带 cron / stateless / background run（langgraph-sdk cron jobs）能力——直接支撑"常驻续算"与"多委托并行隔离"。
