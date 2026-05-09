# 运行模式分析

本文只分析当前项目中与 agent loop 紧密相关的两类模式：权限模式和功能模式。

主要参考：

- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/QueryEngine.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/query.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/utils/permissions/PermissionMode.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/utils/permissions/permissionSetup.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/commands/plan/index.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/utils/ultraplan/ccrSession.ts`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/tools/AgentTool/*`
- `~/Codes/work/modelbest/PilotDeck/third-party/claude-code-main/src/utils/worktreeModeEnabled.ts`

## 模式分类

当前项目里与 agent loop 直接相关的模式可以收敛为两类：

- 权限模式：工具执行时如何处理确认、拒绝、自动允许或计划模式。
- 功能模式：plan、subagent、worktree、remote session、assistant、voice 等会改变 agent loop 行为边界的功能开关或运行状态。

这两类模式会影响工具集合、权限判断、上下文附加信息、是否允许副作用、是否需要用户确认、以及 agent loop 何时继续或停止。

## 权限模式总览

`PermissionMode.ts` 中定义的主要权限模式包括：

- `default`：默认模式。
- `plan`：计划模式。
- `acceptEdits`：自动接受编辑类操作。
- `bypassPermissions`：绕过权限确认。
- `dontAsk`：不询问。
- `auto`：在 `TRANSCRIPT_CLASSIFIER` feature 下出现的自动模式。

权限模式会影响：

- `hasPermissionsToUseTool()` 的决策。
- 工具是否直接执行。
- 是否弹出权限 UI。
- 是否允许自动判断。
- 是否需要 classifier。
- 是否允许危险命令或任务委派。
- 是否要记录权限决策和拒绝原因。

权限模式是 agent loop 和工具系统之间最关键的控制面之一。

## Default 权限模式

`default` 是基础权限模式。该模式下，工具调用会按照配置规则、工作区边界、工具类型和已有 allow/deny/ask 规则进行判断。

该模式的典型行为：

- 读类工具通常更容易被允许。
- 写类、shell、副作用类工具可能触发确认。
- 已配置的 always allow / always deny / always ask 规则会影响最终决策。
- 权限结果会影响工具是否执行，以及是否向模型回填拒绝结果。

## Plan 权限模式

`commands/plan/index.ts` 定义 `/plan` 命令，用于启用 plan mode 或查看当前 session plan。`PermissionMode.ts` 中的 `plan` 映射为外部 permission mode `plan`。

该模式的特征：

- 权限模式进入 plan。
- agent 更偏向提出计划而不是直接修改。
- 与 `ExitPlanMode` / `ExitPlanModeV2` 工具配合。
- 在远端 CCR 场景中，plan mode 会影响浏览器侧是否等待用户审批计划。
- plan mode 下模型和权限逻辑可能有不同处理。

Plan 模式直接影响工具是否可执行、何时退出计划状态，以及用户确认流程。

## Accept Edits 权限模式

`acceptEdits` 更偏向允许编辑类工具执行。它改变的是权限层对编辑动作的处理方式，而不是改变 agent loop 本身的结构。

该模式的影响：

- 文件编辑类工具更容易自动通过。
- 非编辑类工具仍可能受普通规则约束。
- 适合用户已经明确希望 agent 修改代码的场景。

## Bypass Permissions 权限模式

`bypassPermissions` 强化自动执行能力，风险最高。

该模式的影响：

- 工具确认环节被大幅弱化或绕过。
- shell、文件写入、任务委派等副作用操作的安全边界依赖外部约束。
- agent loop 中工具执行阻塞减少，但错误或危险操作的后果更大。

## DontAsk 权限模式

`dontAsk` 避免交互式确认，适合非交互或受控环境。

该模式的影响：

- 遇到需要询问的工具调用时不会走普通交互确认。
- 具体是拒绝、允许还是按规则处理，取决于权限 runtime 的决策。
- 对 headless、SDK 或后台任务等无法弹出 UI 的场景有意义。

## Auto 权限模式

Auto mode 受 `TRANSCRIPT_CLASSIFIER` 等 feature 影响。`permissionSetup.ts` 中包含对 auto mode 的安全限制，例如危险 Bash/PowerShell 规则、Agent 任务委派规则、模型是否支持 auto mode 等。

该模式的特征：

- 依赖 classifier 自动判断部分工具是否可执行。
- 对危险命令、解释器、PowerShell 执行、Agent 委派等有额外限制。
- 可能记录 auto mode denial。
- 与用户配置中的 allow rule 交互时需要检测危险规则。

Auto mode 的核心是降低确认成本，但同时保留安全边界。

## 功能模式总览

功能模式不是单纯权限策略，而是会改变 agent loop 的上下文、工具集合、执行边界或输出组织方式。当前项目中与 agent loop 关系较近的功能模式包括：

- plan mode。
- subagent / AgentTool。
- worktree mode。
- remote session / bridge / CCR。
- assistant / Kairos。
- voice mode。
- bare/simple 运行功能开关。

这些功能模式通常不重写 agent loop，但会改变 agent loop 所处的运行环境。

## Plan 功能模式

Plan 同时也是权限模式和功能模式。作为功能模式时，它还涉及计划产物、计划确认和退出计划状态。

相关行为：

- `/plan` 可以进入计划模式或查看当前计划。
- `ExitPlanMode` / `ExitPlanModeV2` 工具负责从计划状态切换到可执行状态。
- 在远端 CCR 场景中，计划可能需要浏览器侧审批。
- 计划内容会影响后续 agent turn 的执行前提。

## Subagent / AgentTool 功能模式

当前项目中 AgentTool、forked agent、swarm/in-process teammates 等路径都会创建子 agent 或隔离运行上下文。

该模式的特征：

- 子 agent 有自己的 agent id 和 agent type。
- 工具上下文中会区分主线程和子 agent。
- 权限、hooks、transcript、tool result budget、file state cache 可能需要继承或隔离。
- 子 agent 输出通过 parent tool use id 关联回主 agent。

Subagent 模式使 agent loop 形成嵌套结构，而不是单一线性会话。

## Worktree 功能模式

Worktree mode 会改变 agent 执行任务时的文件系统和 git 工作区边界。

该模式的特征：

- agent 可能进入独立 worktree。
- 文件读写、shell、git 操作都受新工作区影响。
- 工具权限中的 workspace roots 和路径校验会随之变化。
- session、任务状态和 UI 需要知道当前是否处于 worktree。

## Remote Session / Bridge / CCR 功能模式

Remote session、bridge、CCR 等功能模式会把 agent loop 的输入输出和会话状态延伸到远端环境或外部客户端。

该模式的特征：

- session source 可能被标记为 remote-control。
- 权限请求可能通过 bridge callbacks、browser 或外部控制通道完成。
- 消息和工具结果需要通过远端协议传输。
- session id 兼容层可能介入。
- 计划模式、权限模式和远端 UI 审批可能组合出现。

## Assistant / Kairos 功能模式

Assistant/Kairos 相关 feature 会引入额外命令、工具、通知、channel 或 agent 行为。

该模式可能影响：

- 可用命令集合。
- 可用工具集合。
- channel permission callbacks。
- prompt 附加信息。
- 后台任务或主动行为。

## Voice 功能模式

Voice mode 相关代码会把语音输入、语音状态或语音服务接入会话运行时。

该模式可能影响：

- 用户输入来源。
- prompt input 状态。
- turn 触发方式。
- 语音转文本服务状态。

## Bare / Simple 功能开关

`--bare` 会设置简单模式相关环境，减少外围功能加载。

该模式会跳过或弱化：

- hooks。
- LSP。
- plugin sync。
- attribution。
- auto-memory。
- background prefetches。
- keychain reads。
- CLAUDE.md auto-discovery。

Bare/simple 不改变核心模型-工具循环，但会减少 agent loop 外围上下文来源和副作用。

## 功能模式之间的组合

功能模式经常叠加，例如：

- remote-control + bridge permission callbacks。
- plan mode + CCR browser approval。
- subagent + 非交互权限策略。
- worktree + subagent。
- bare/simple + reduced context loading。
- auto permission mode + AgentTool 限制。

因此，当前项目的功能模式不是互斥枚举，而是多个运行特性叠加后的状态。

## 对 agent loop 的影响面

权限模式和功能模式主要影响：

- 是否需要加载 hooks、plugins、skills、memory。
- 工具集合和工具权限规则如何生成。
- transcript 何时写入和如何 replay。
- 模型、thinking、fast mode、permission mode 如何选择。
- 文件系统边界和 workspace roots。
- 是否允许副作用工具直接执行。
- 是否需要计划审批或退出计划状态。
- 子 agent 是否继承或隔离主会话上下文。
- 远端协议是否参与权限和消息传输。

当前项目通过 `main.tsx`、`cli/print.ts`、`QueryEngine.ts`、`query.ts`、`ToolUseContext` 和 permission runtime 共同处理这些模式差异。