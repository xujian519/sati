# Agent Note: 系统提示分桶——逐轮可变的注入段下沉到消息尾部

Status: implemented

## Problem

system prompt 整体是一个**缓存前缀块**：Anthropic 的 `cache_control` 打在整个 system 块上
（`src/model/providers/anthropic/request.ts`），OpenAI / DeepSeek 的隐式前缀缓存同样按前缀匹配。
因此任何逐轮变化的内容落在 system prompt 里，被作废的不是那一小段，而是它**之前**的全部前缀
（工具 schema + 整个 system prompt）。而实际有三类逐轮可变的段落都落在里面：

1. **账本块**（`<workspace-state>`）：`modelRequest.ts` 经 `appendSystemPrompt` 拼进 system
   prompt。`src/context/cache/CachePlan.ts` 的模块注释早已声称「逐调用可变的注入（workspace-state
   账本块、steer 消息、repeatToolReminder 提醒）必须位于最近 N 条断点之后」——**这句声称对账本块
   是假的**，只是没人接线，注释与实现对不上。
2. **plan-todo 追加段**：`PlanTodoState.buildPromptAddendum` 在「已批准计划且距上次 todo 更新
   ≥10 次工具调用」时返回**带计数器文本**的追加段（`${toolCallsSinceLastTodoWrite}`），意味着
   10 次之后**每一次工具调用都会改写 system prompt**。
3. **记忆附件**（`<memory-context>`）：`MemoryAttachmentBuilder.build` 的 query 取自最近用户文本，
   逐轮变化；压缩后的重注入路径（`CompactionEngine.buildPostCompactMessages`）本来就把它当**消息**
   追加，只有实时装配这条路把它塞进 system prompt——两条路径形态原本就不一致。

**实现过程中暴露的耦合面（值得记住）**：把上下文从 system prompt 搬到消息尾部，等于让它进入
「扫描 messages 找用户意图」的旁路逻辑的视野。system prompt 此前不在这些扫描范围内，所以有两处
生产代码会被尾部注入误导，属于**本改动必须一并修的回归**：

- `src/router/tokenSaver/extractLastUserMessage.ts`：token-saver 分类取「最后一条 user 文本」，
  会把注入的账本/记忆文本当成用户意图（该文件此前已专门为跨日通知打过同样的补丁）；
- `src/router/scenario/subagentDetector.ts`：扫描全部 user 消息找 `<sati-subagent-model>` 标记，
  注入文本里出现该字样会误判为子代理场景（进而改变路由与工具面）。

测试侧同类：`tests/tool/builtin/team/team-tools-integration.spec.ts` 的假模型用「请求最后一条消息
是否含 tool_result」判断回合进度——尾部注入排在工具结果之后，导致该 fixture 反复发同一个工具调用、
回合不收敛（B 任务不再收敛到 `failed`）。三处都已改为「跳过 `metadata.synthetic` 消息」（生产侧用
`isTailInjection`，只跳过本通道，不误伤 steer 这类承载真实用户输入的合成消息）。

量化（`scripts/measure-assembly-stability.ts`，工作区路径固定后同一场景跨次运行可比）：

| 场景 | 改动前 | 改动后 |
|---|---|---|
| `default`（无动态段） | 5097 tok，digest `496c986fde83` 逐轮稳定 | 相同（未受影响） |
| `project-instructions` | 5199 → 5210（外部改 SATI.md，Δ+11） | 相同（未受影响，见下） |
| `ledger-empty` | 5099 tok 稳定 | 相同（未受影响） |
| `ledger-live`（脚本化模型真写 `workspace_note`） | 5099 → **5143**（digest 变，Δ+44，块在 system prompt 内） | **5099 三轮逐字节稳定**，块落在末条 `context_injection` 消息里 |

## Decision

新增 `src/context/prompt/tailInjection.ts`（`buildTailInjectionMessage` / `isTailInjection` /
`TAIL_INJECTION_PURPOSE`），把逐调用可变的段落合成为**一条** synthetic user 消息追加在请求消息末尾，
形状与既有尾部注入一致（`promptDateNotice` / `plan_mode_reminder` / `repeat_tool_reminder` / `steer`）：
只存在于请求投影，不落 transcript、不进消息历史。

分桶判据（写在模块头注释里，作为后来人加注入时的规则）：

- **进尾部**：账本块、plan-todo 追加段、记忆附件（运行时经 `ModelContext.tailInjections` 交出）、
  方法论追加段（随请求按首条 user 文本重算）。
- **留 system prompt**：会话内静态的产品框架与指令（默认系统提示、user/system context、调用方
  `appendSystemPrompt`、`<project-instructions>`、`<memory-tools>` 清单）与元认知提示。

配套两处：

1. `CachePlan.selectRecentMessageBreakpoints` 跳过尾部注入——以它为断点的缓存前缀在后续请求里
   不可能重现（每轮重建、位置永远在末尾），占掉 1 个断点名额却永不命中；跳过它后 3 个断点全部
   落在会重现的消息上（实测 `cachePlan.messages` 从 `[0,1,2]` 变为 `[1,2,3]`）。
2. 删除 `applyMethodologyAddendum`（唯一调用点已改为尾部注入），避免留下「两处拼法」。

`<project-instructions>` 有意**不搬**：它是权威指令，语义上属于 system prompt；改动它的代价是
一次性缓存重写（用户改动文档时发生，极低频），而收益与风险（`applySystemPromptFilters` 的 S7/S8
按标签从 system prompt 剥离）不成比例。

## Alternatives considered

- **只把账本块搬到尾部，其余不动** — 落选：plan-todo 的计数器追加段是**逐次工具调用**变化，比账本
  更频繁；只搬一处会让注释里的「布局约束」继续半真半假。
- **给尾部注入加环境开关（`SATI_PROMPT_TAIL_INJECTION=off`）回退旧布局** — 落选：模型可见布局的
  双路径正是这类漂移的温床（旧布局本身就是「注释声称 A、实现是 B」的产物）；本改动用测试钉住落点，
  并保留回退能力的是**内容**（关掉账本/元认知/记忆即无段可注入），不是布局。
- **把某个段落单独作为一条消息（每段一条 synthetic 消息）** — 落选：与今天「一段 system 文本块」
  最接近的形态是一条消息内空行连接，模型看到的内容除位置外完全不变；多条消息会引入相邻 user 消息
  堆叠，且每段都会被当作可锚定消息参与其他判定。
- **把元认知提示一并搬到尾部** — 落选：它在开关开启后内容恒定（会话内静态），搬它没有缓存收益，
  却把「行为指令」从 system prompt 里挪走，收益/风险倒挂。
- **搬走后同时给尾部内容加 `<context-update>` 包裹标签** — 落选：`injected_context` 审计逐段记录
  原文（「模型可见 = 已记录」），加包裹会让模型看到未记录的文本。段落原文逐字节保留即两者一致。
- **同时把 `<project-instructions>` 搬到尾部** — 落选：见 Decision 末段（一次性 vs 逐轮的成本收益，
  以及 S7/S8 的剥离 seam）。
- **把 plan-todo 追加段的计数器改成不带数字的固定文案（不改布局）** — 落选：治了 plan-todo 一处，
  账本与记忆附件照旧逐轮打穿前缀；且丢掉「多久没更新 todo」的量化提示，是行为回退。
- **用 `mkdtemp` 随机工作区继续测量** — 落选（测量工具侧）：`cwd` 会进 `<user-context>`，随机后缀
  让同一场景跨次运行的 system digest 必然不同，前后对比失去意义。改为固定路径
  `<tmp>/sati-assembly-measure/<场景名>`（每次运行前清空）。
- **让尾部注入排在工具结果之前（避免「user 消息紧跟 tool_result」的形态）** — 落选：注入的语义是
  「本次请求前的当前状态」，放到工具结果之前会读成「工具结果之前的旧状态」；且既有四条注入通道
  （跨日通知、plan 提醒、重复工具提醒、steer）都在消息尾部，其中重复工具提醒就是紧跟工具结果的
  synthetic user 消息，形态早已在生产里通行。代价是上面的「扫描旁路可见性变化」，用排除修，不靠挪位。
- **把三处受影响判定统一改成「跳过所有 synthetic 消息」** — 落选：steer 消息是 synthetic 但承载真实
  用户输入（插话），一并跳过会让它不再参与分类/标记判定。按 `purpose` 精确排除尾部注入通道。

## Consequences

- 换来了：账本/记忆/plan-todo/方法论的变化不再作废 system prompt 及其之前的前缀；`CachePlan` 注释里
  的布局约束变成事实；压缩重注入与实时装配的记忆形态一致。
- **行为面变化（需留意）**：这些段落出现在消息末尾而非 system prompt 里，模型看到的位置变了。方法
  论与 plan-todo 属行为引导型文本，改位置可能影响遵循度——本次以「尾部 = 更强的近因」判断为不劣，
  但**未做真实模型对照实验**（重放 fixture 的录制场景不含这些段落，无法给出前后行为对比）。若线上
  观察到遵循度下降，回退路径是逐段改回 `appendSystemPrompt`。
- **审计不变**：`injected_context` 的 source 集合与文本逐字节不变（记忆/方法论/账本/元认知照旧，
  plan-todo 追加段仍**不**落审计——与改动前一致，属既有边界，未在本次扩大）。
- **扫描旁路的可见性变化**：注入进 system prompt 时，任何「扫描 messages 找用户意图」的逻辑都看不见
  它；进尾部后它们看得见（本轮修了 token-saver 分类与子代理标记两处）。这是尾部注入通道的固有代价，
  新增同类旁路时需用 `isTailInjection` 排除（或统一走「用户撰写文本」抽取函数——本轮未做该重构）。
- **尾部注入不计入缓存断点**：`selectRecentMessageBreakpoints` 跳过 `purpose="context_injection"`
  的消息；日期通知与 plan 模式提醒不在跳过之列（它们的位置会重现：通知在同一前缀下停在原下标，
  提醒每轮在同一相对位置重建）。
- **测量工具的两点修正**：工作区路径固定（跨次运行可比，之前是「±1 token」的模糊说法，实际是
  digest 必然不同）；`--json` 改走 stderr——Sati 自身日志写 stdout，混流后 JSON 无法解析。
- 未覆盖：网关层无法注入自定义 `MemoryResolver`（无测试钩子），故记忆附件的**端到端**落点由
  spec（`tests/context/memory-tail-injection.spec.ts`）在运行时层钉住，账本则由真实网关 + 脚本化
  模型（`tests/cli/prompt-tail-injection.spec.ts`）端到端钉住。
