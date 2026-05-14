# TUI Session Dashboard 设计方案

> 从 "一次看一个 session" 进化到 "一屏管理所有 session"。
> 基于 Claude Code Agent View 调研 + PilotDeck 架构现状，定义分阶段实现路径。

---

## 用户视角的变化

**之前**：用户在 TUI 里一次只看一个 session。想知道"另一个任务跑完了没"要手动 `/sessions` → `/switch 2` → 看完 → `/switch 1` 回来。如果有后台 cron 任务在跑，TUI 完全不知道。

**之后**：用户按一个键（如 `Esc` 或 `/dashboard`）进入 Dashboard 视图。所有 session 按状态分组排列——"等你回复" 排在最上面，"正在工作" 其次，"已完成" 折叠在底部。Peek 一下就能看到最新输出，直接回复不用切换。需要深入时 Enter 进去，`←` 退回来。后台 cron 任务也出现在列表中。

---

## 第一部分：Claude Code Agent View 完整调研

### 1.1 整体架构

Agent View（2026-05-11 发布，v2.1.139+）是一个全终端 Dashboard，管理所有后台 Claude Code session。核心架构：

```
用户终端
  └── claude agents (Agent View TUI)
        ├── 显示所有后台 session，按状态分组
        ├── Peek 面板（Space）
        ├── Reply 输入（在 peek 中直接回复）
        └── Attach（Enter 进入完整对话）

Supervisor 进程（独立于终端）
  ├── 托管所有后台 session 进程
  ├── session 完成 1h 后自动回收进程
  ├── 监听 Claude Code 二进制更新，热重启
  └── 状态持久化到 ~/.claude/jobs/<id>/state.json
```

**关键设计决策**：Agent View 本身不是一个 session，而是一个"面板"。它不持有对话上下文，只是对 supervisor 管理的后台 session 的可视化。

### 1.2 Session 状态模型

Agent View 的每行 session 携带两个独立信号：

**工作状态**（决定分组）：

| 状态 | 图标 | 含义 | 分组位置 |
|------|------|------|----------|
| Working | 动画 ✽ | 正在执行工具或生成回复 | Working 组 |
| Needs input | 黄色 ✻ | 等待用户回答问题或权限决策 | Needs input 组（置顶） |
| Idle | 暗色 | 等待下一条 prompt | 不显眼 |
| Completed | 绿色 | 任务完成 | Completed 组（底部折叠） |
| Failed | 红色 | 出错终止 | Completed 组（但始终可见） |
| Stopped | 灰色 | 用户手动停止 | Completed 组 |

**进程状态**（图标形状）：

| 形状 | 含义 |
|------|------|
| ✻ / ✽ | 进程存活，可即时响应 |
| ∙ | 进程已退出，peek/reply/attach 时自动重启 |
| ✢ | `/loop` session 在迭代间休眠，显示运行次数和倒计时 |

**分组排列**（从上到下）：

1. **Pinned** — 手动置顶
2. **Ready for review** — 有 open PR 的 session
3. **Needs input** — 等待用户输入
4. **Working** — 正在工作
5. **Completed** — 完成/失败/停止（旧的折叠为 "… N more"）

可按 `Ctrl+S` 切换为"按目录分组"。分组选择跨 session 持久化。

### 1.3 三级交互深度

这是 Agent View 最精妙的设计——不需要 attach 就能完成大部分管理操作：

**Level 1: 扫一眼（Row summary）**
- 每行显示 session 名 + 一行摘要 + 时间戳
- 摘要由 Haiku 级模型生成，Working 状态每 15s 刷新一次
- PR 状态点（黄/绿/紫/灰）显示在行右侧

**Level 2: Peek + Reply（Space 键）**
- 弹出面板显示最近输出或 pending 问题
- 多选题可按数字键直接选择
- Tab 键填入建议回复（可编辑后发送）
- `!` 前缀发送 Bash 命令而非消息
- 上下箭头切换 peek 不同 session

**Level 3: Attach（Enter/→）**
- 进入完整对话界面
- Claude 自动发一段 recap 告诉你离开期间发生了什么
- `←`（空 prompt 时）或 `Ctrl+Z` detach 回 Dashboard
- Detach 不会停止 session

### 1.4 Session 派发

**从 Agent View 内**：
- 底部输入 prompt 按 Enter 启动新后台 session
- 每次 Enter 都是新 session，不是续聊
- 支持 `@subagent` 指定代理、`@repo` 指定仓库
- 支持 `/skill` 触发技能
- `Shift+Enter` 派发并立即 attach

**从已有 session 内**：
- `/bg` 或 `/background` 将当前对话送入后台
- 可附加指令：`/bg run tests and fix failures`

**从 Shell**：
- `claude --bg "task description"` 直接后台启动
- `claude --agent code-reviewer --bg "review PR 1234"` 指定 agent

### 1.5 自治工作流命令

这些命令让 session 在无人值守时持续工作：

| 命令 | 触发方式 | 停止条件 | 适用场景 |
|------|----------|----------|----------|
| `/goal` | 每个 turn 结束后自动开始下一个 | Haiku 模型判断目标条件达成 | 模块迁移直到测试全过 |
| `/loop` | 定时/动态间隔触发 | 用户停止或 7 天过期 | 轮询 CI、监控 PR |
| `/batch` | 一次性派发 5-30 个 subagent | 所有 subagent 完成 | 批量重构 |
| `/bg` | 即时送入后台 | 任务完成 | 长时间调查 |

**`/goal` 的工作原理**：设定完成条件后，每个 turn 结束时 Haiku 模型评估条件是否满足。未满足则自动开始下一个 turn，并把评估理由作为下一轮引导。可设置 turn 上限。

**`/loop` 的工作原理**：定时重复执行 prompt。支持固定间隔（`/loop 5m check deploy`）或动态间隔（Claude 自行判断等多久）。无 prompt 时执行内置维护脚本（续未完成工作、处理 PR review、清理代码）。

### 1.6 文件隔离

每个后台 session 在首次需要编辑文件时自动迁移到独立 git worktree（`.claude/worktrees/`）。并行 session 可以同时读取同一个 checkout，但各自写入独立副本。删除 session 时 worktree 也被删除。

### 1.7 Session 筛选

在 Agent View 输入栏输入筛选语法：
- `a:<agent-name>` — 按 agent 筛选
- `s:<state>` — 按状态筛选（`s:working`、`s:blocked`）
- `#<number>` 或 PR URL — 找到处理该 PR 的 session

### 1.8 Side Chat（`/btw`）

在不打断当前对话的情况下提问。能看到完整对话上下文，但没有工具访问权限。答案是临时的，不进入对话历史。可在 Claude 正在工作时使用。

### 1.9 Session Recap

离开 3 分钟以上后回来，自动显示一行摘要告诉你发生了什么。也可 `/recap` 手动触发。

### 1.10 PR Review Status

每个 session 的 footer 显示关联 PR 链接，颜色编码状态（绿=approved，黄=pending，红=changes requested，灰=draft，紫=merged）。Agent View 中也在行末显示 PR 状态点。

### 1.11 Task List

复杂多步骤任务时，Claude 创建任务列表显示在终端状态区。`Ctrl+T` 切换显示。最多同时显示 5 个。可通过 `CLAUDE_CODE_TASK_LIST_ID` 跨 session 共享。

---

## 第二部分：PilotDeck 架构现状分析

### 2.1 与 Agent View 的架构对应

| Claude Code 概念 | PilotDeck 对应 | 现状 |
|-----------------|---------------|------|
| Supervisor 进程 | Gateway Server（`pilotdeck server`） | **已有**。`SessionRouter` 管理 session 生命周期 |
| 后台 session 进程 | `AgentSession` in `SessionRouter.sessions` Map | **已有**。session 在 gateway 内存中存活 |
| Session 状态 | `AgentSessionState.status`: `idle/running/aborted/failed` | **已有**但粗粒度。缺 `needs_input` 等 |
| 文件隔离（worktree） | 无 | **未实现**。所有 session 共享同一工作目录 |
| 事件流 | `GatewayEvent` 联合类型 via WebSocket/InProcess | **已有**。`turn_started/completed`、tool events、permission events |
| Cron 调度 | `CronRuntime` + `GatewayCronController` | **已有**。通过 `cron_*` tools 暴露 |
| 后台 Shell 任务 | `BackgroundTaskRuntime` + `task_*` tools | **已有** |
| Session 列表 | `gateway.listSessions()` | **已有**。返回 `SessionInfo[]` |
| Session 切换 | `/new` 创建，无 `/switch` | **不完整**。TUI 只有 `SessionHint` 显示摘要 |

### 2.2 Gateway 已有的关键能力

**Session 生命周期**：
- `SessionRouter.getOrCreate()` — 按 sessionKey 获取或创建 session
- `resumeAgentSession()` — 从 JSONL transcript 恢复 session 状态
- `sweepIdle()` — 闲置超时（默认 30 分钟）自动回收
- `beginTurn()/endTurn()` — 并发控制，一个 session 同时只能有一个 turn

**事件流**：
- `submitTurn()` — 返回 `AsyncIterable<GatewayEvent>`
- `emitForSession()` — 注入 permission/elicitation 事件到同一 queue
- WebSocket 传输：`WsEventFrame` 带 `seq/final`
- 通知机制：`WsNotificationFrame` 用于 `config_changed` 等推送

**TUI 当前状态模型**（`applyGatewayEventToTuiState`）：
- `isRunning: boolean` — `turn_started` 置 true，`turn_completed/error` 置 false
- `pendingPermission` — permission_request 时设置
- `activity` — 正在执行的工具名列表
- 没有 "需要用户输入" 的细分状态

### 2.3 PilotDeck 的独特优势

1. **Gateway Server 架构**：session 天然在服务端运行，不需要额外 supervisor。Gateway 本身就是"supervisor"。
2. **多频道支持**：TUI 只是 channel 之一（还有 CLI、Web、飞书）。Dashboard 可以看到所有频道的 session。
3. **Cron 和后台任务已有雏形**：`CronRuntime` 和 `BackgroundTaskRuntime` 已经存在，只是 TUI 没有暴露可视化。
4. **插件系统**：后台任务可以是插件钩子触发的，比 Claude Code 的 `/loop` 更灵活。
5. **远程 session 天然支持**：`pilotdeck server` 模式下 TUI 通过 WebSocket 连接，session 在服务器上运行，不受客户端 sleep 影响。

### 2.4 关键差距

1. **Session 状态粒度不够**：`idle/running/aborted/failed` 不区分 "working"（正在跑工具）和 "needs_input"（等权限决策）。
2. **TUI 无 Dashboard 视图**：一次只能看一个 session，没有全局鸟瞰。
3. **无 Peek/Reply**：切换 session 必须完整加载历史，没有轻量级查看和回复。
4. **后台任务对用户不可见**：Cron 任务在 gateway 运行但 TUI 无法感知。
5. **无 Session 摘要生成**：列表只显示 sessionId 或首条消息截断，不会生成有意义的 one-liner。
6. **无自治工作流**：没有 `/goal`、`/loop` 等让 session 自动持续工作的命令。

---

## 第三部分：设计方案

### 3.0 设计原则

1. **Gateway-first**：所有 session 状态都由 gateway 维护，TUI 只是一个视图。这意味着 Dashboard 在 Web UI 中也能复用。
2. **渐进增强**：Phase 1 改 TUI 显示层，Phase 2 增强 gateway 事件，Phase 3 加自治工作流。
3. **不破坏现有命令**：`/new`、`/sessions` 保持向后兼容，Dashboard 是新增视图。

### Phase 1：Session Dashboard 视图

> 目标：用户在 TUI 中一键切换到 Dashboard 视图，看到所有 session 的状态概览，能 peek 和切换。

#### 1.1 新增 TUI 视图模式

TUI 新增两种模式：

```
Chat 模式（现有）         Dashboard 模式（新增）
┌──────────────────┐     ┌────────────────────────┐
│ Header           │     │ Header: Dashboard      │
│ ─────────────── │     │ ─────────────────────  │
│ [message flow]   │     │ Needs input            │
│ [message flow]   │     │   ✻ API audit   等你回复│
│ [message flow]   │     │ Working                │
│                  │     │   ✽ 重构 auth   2m     │
│ ─────────────── │     │ Idle                   │
│ > prompt input   │     │   ∙ default    5m ago  │
└──────────────────┘     │ Completed              │
                         │   ∙ fix #481   result  │
                         │ ─────────────────────  │
                         │ > dispatch / filter    │
                         └────────────────────────┘

切换方式：
  Chat → Dashboard:  /dashboard 命令 或 Esc（空 prompt 时）
  Dashboard → Chat:  Enter 选中行 attach，或 Esc 返回上一个 session
```

#### 1.2 Session 状态增强

在 `AgentSessionState` 基础上，gateway 增加对外暴露的 session 状态：

```typescript
type SessionDisplayStatus =
  | "working"        // status === "running" && !pendingPermission && !pendingElicitation
  | "needs_input"    // status === "running" && (pendingPermission || pendingElicitation)
  | "idle"           // status === "idle"
  | "completed"      // turn 已结束且有明确结果
  | "failed"         // status === "failed"
  | "stopped"        // status === "aborted"
  | "scheduled"      // cron 任务在等待下一次触发
```

`SessionRouter` 在 session 状态变化时计算 `SessionDisplayStatus`，通过 `WsNotificationFrame` 广播给所有连接的客户端。

#### 1.3 Session 列表增强

`gateway.listSessions()` 的返回值从 `SessionInfo`（仅含 transcript 元数据）增强为 `SessionDashboardInfo`：

```typescript
type SessionDashboardInfo = SessionInfo & {
  displayStatus: SessionDisplayStatus;
  activity?: string;           // 当前正在执行的工具或操作描述
  lastOutput?: string;         // 最近一条 assistant 输出（截断）
  pendingQuestion?: string;    // 如果 needs_input，等待的问题文本
  cronInfo?: {                 // 如果是 cron 触发的 session
    interval: string;
    nextFireAt: number;
    runCount: number;
  };
};
```

#### 1.4 分组与排序

Dashboard 列表分组逻辑：

```
优先级从高到低：
1. Needs input — 需要用户介入的 session
2. Working — 正在执行的 session
3. Scheduled — 定时任务（显示下次执行时间）
4. Idle — 空闲等待的 session
5. Completed — 已完成（最近 N 个，其余折叠）
```

组内按 `lastModified` 降序排列。

#### 1.5 Peek 面板

在 Dashboard 中选中一行按 Space：

```
┌─────────────────────────────────┐
│ Needs input                     │
│   ✻ API audit   等你回复   3m   │  ← 选中行
│                                 │
│ ┌─ Peek ──────────────────────┐ │
│ │ 🔧 正在执行 read_file...    │ │
│ │                              │ │
│ │ 需要确认：是否允许执行       │ │
│ │ shell_command: npm test?     │ │
│ │                              │ │
│ │ [1] 允许  [2] 拒绝  [3] 总是 │ │
│ └──────────────────────────────┘ │
│                                 │
│ > 输入回复或按数字键选择         │
└─────────────────────────────────┘
```

Peek 面板显示：
- 最近的 assistant 输出（最后 5-10 行）
- 如果有 pending permission/elicitation，显示问题和选项
- 用户可以直接输入回复或按数字键选择

实现方式：peek 不加载完整历史，而是通过 `gateway.getSessionPeek(sessionKey)` 获取最近 N 条事件。

#### 1.6 Reply Without Attach

在 peek 面板中输入回复后：
- 如果是 permission 决策：调用 `gateway.permissionDecide()`
- 如果是 elicitation 回复：调用 `gateway.elicitationRespond()`
- 如果是新 prompt：调用 `gateway.submitTurn()` 但不 attach（session 继续后台运行，TUI 回到 Dashboard）

#### 1.7 键盘快捷键

| 快捷键 | 动作 |
|--------|------|
| `↑/↓` | 在行间移动 |
| `Enter` | Attach 到选中 session（进入 Chat 模式） |
| `Space` | 打开/关闭 Peek 面板 |
| `Esc` | 关闭 Peek / 退出 Dashboard |
| `/new` | 在 Dashboard 中创建新 session |
| `d` | 删除选中 session |
| 数字键 | 在 Peek 面板中快速选择选项 |

---

### Phase 2：后台 Session 与实时状态推送

> 目标：session 在 gateway 中持续运行，TUI 离开 Chat 模式后 session 不中断，Dashboard 实时更新状态。

#### 2.1 Gateway 状态广播

`SessionRouter` 在以下时机广播 `session_status_changed` 通知：

```typescript
type SessionStatusNotification = {
  sessionKey: string;
  displayStatus: SessionDisplayStatus;
  activity?: string;
  summary?: string;        // Haiku 级模型生成的一行摘要
  lastOutput?: string;
  pendingQuestion?: string;
};
```

触发时机：
- `turn_started` → status 变为 `working`
- `tool_call_started/finished` → 更新 `activity`
- `permission_request` → status 变为 `needs_input`
- `turn_completed` → status 变为 `idle` 或 `completed`
- `error` → status 变为 `failed`

#### 2.2 Session 后台化

当用户从 Chat 模式切换到 Dashboard（或切换到另一个 session）时：
- 如果当前 session 有正在运行的 turn，它在 gateway 中继续运行
- TUI 停止消费该 session 的事件流（不再渲染 message flow）
- Dashboard 行通过状态广播更新

当用户 attach 回来时：
- TUI 重新加载历史消息（`gateway.readSessionMessages()`）
- 重新连接事件流
- 如果有 pending permission，立即显示

#### 2.3 Cron 任务在 Dashboard 的可见性

Gateway 的 `CronRuntime` 创建的定时任务在 Dashboard 中显示为独立行：

```
Scheduled
  ✢ 每日代码审计    run 3 · 下次 in 45m    ● PR#12
  ✢ 监控部署状态    run 7 · 下次 in 12m
```

`cron_create` 时 gateway 广播新 session 信息到 Dashboard。`cron_fire` 时 session 状态变为 `working`，完成后回到 `scheduled`。

#### 2.4 摘要生成

对于状态变化的 session，gateway 可选使用配置的小模型生成一行摘要（类似 Agent View 的 Haiku 摘要）。摘要随 `session_status_changed` 通知一起推送。

首期可以不用模型生成，直接用以下启发式：
- 首条用户消息的前 40 字符
- 如果有工具在执行，显示工具名
- 如果有 pending question，显示问题前 40 字符

---

### Phase 3：自治工作流命令

> 目标：让 session 自动持续工作，用户只需要在 Dashboard 中偶尔查看和介入。

#### 3.1 `/goal` — 目标驱动

```text
/goal 所有 test/auth 下的测试通过且 lint 无错误
```

实现：
- 在 `AgentSession` 层面增加 `activeGoal` 状态
- 每个 turn 结束后，用小模型评估目标条件
- 未达成则自动开始下一个 turn
- 达成后清除 goal，session 状态变为 `completed`
- Dashboard 中 goal session 显示目标条件和当前进展

#### 3.2 `/loop` — 定时重复

```text
/loop 5m 检查 CI 状态并报告
```

实现：
- 复用已有的 `CronRuntime`
- 创建 session-scoped 的 cron 任务
- 每次 fire 时以设定的 prompt 调用 `submitTurn()`
- Dashboard 中显示 ✢ 图标和迭代信息

#### 3.3 `/bg` — 后台化当前对话

```text
/bg 跑完测试后修复所有失败的 case
```

实现：
- 将当前 Chat 模式的 session 标记为后台
- 可选附加一条指令作为下一个 turn 的 prompt
- TUI 自动切换到 Dashboard 视图
- session 在 gateway 中继续运行

---

### Phase 4：高级特性（远期）

#### 4.1 Peek 中的 Side Chat

类似 `/btw`——在 peek 面板中针对某个 session 的上下文提问，但不影响该 session 的对话历史。不需要工具访问权限，只需基于现有上下文回答。

#### 4.2 Session Recap

attach 到一个离开超过 3 分钟的 session 时，自动生成一段摘要告诉用户发生了什么。首期可用简单的"最近 N 条消息"替代模型生成。

#### 4.3 多目录 / 多项目支持

Dashboard 显示所有项目的 session，支持按项目分组（类似 Agent View 的 `Ctrl+S` 按目录分组）。这对使用 `pilotdeck server` 管理多个项目的用户特别有价值。

#### 4.4 Web UI Dashboard

因为所有状态都在 gateway，Web UI 可以复用同一套 `SessionDashboardInfo` 接口实现自己的 Dashboard。侧边栏按状态分组显示 session 列表，点击切换。

---

## 第四部分：实现优先级

### 依赖关系

```
Phase 1.2 (状态增强) ← Phase 1.1 (Dashboard 视图) ← Phase 1.4 (分组排序)
                    ↖                               ↙
                     Phase 1.3 (列表增强)
                              ↓
                     Phase 1.5 (Peek 面板) ← Phase 1.6 (Reply)

Phase 2.1 (状态广播) ← Phase 2.2 (后台化) ← Phase 2.3 (Cron 可见性)

Phase 3.* 依赖 Phase 2 全部完成
```

### 推荐执行顺序

| 阶段 | 内容 | 前置条件 | 预估工作量 |
|------|------|----------|-----------|
| **P1a** | `/switch N` 命令补全（09 文档的核心需求） | 无 | 小 |
| **P1b** | Session 状态增强 + `SessionDashboardInfo` 类型 | 无 | 小 |
| **P1c** | Dashboard TUI 视图（静态列表 + 分组） | P1a + P1b | 中 |
| **P1d** | Peek 面板（只读查看最近输出） | P1c | 中 |
| **P1e** | Peek 中 Reply（permission 决策 + 文本回复） | P1d | 中 |
| **P2a** | Gateway `session_status_changed` 通知 | P1b | 中 |
| **P2b** | Dashboard 实时更新（WebSocket 推送刷新行） | P1c + P2a | 中 |
| **P2c** | Chat → Dashboard 切换时 session 后台化 | P2a + P2b | 小 |
| **P2d** | Cron 任务在 Dashboard 显示 | P2b | 小 |
| **P3a** | `/bg` 命令 | P2c | 小 |
| **P3b** | `/loop` 复用 CronRuntime | P2d | 中 |
| **P3c** | `/goal` 自治循环 | P2c | 大 |

### 最小可交付产品（MVP）

**P1a + P1b + P1c** 即可交付一个有意义的 MVP：

用户在 TUI 中 `/dashboard` 进入 Dashboard，看到所有 session 按状态分组，Enter 切换过去。这比现有的 `/sessions` + `/switch` 体验好一个量级：

```
之前：/sessions → 看编号列表 → /switch 2 → 等加载 → 看完 → /sessions → /switch 1

之后：/dashboard → 一眼看到所有状态 → Enter 切换 → ← 退回来
```

---

## 第五部分：与 09 文档的关系

09 文档定义的 7 个用例仍然成立。本文档不替代 09，而是：

1. **09 的用例 1-7 是 Phase 1a 的验收标准**——`/switch` 基础命令。
2. **本文档的 Phase 1c-1e 是 09 的体验升级**——从命令式交互到 Dashboard 可视化。
3. **Phase 2-3 是全新能力**——后台 session + 自治工作流，09 未涉及。

如果实现顺序是先做 09 再做本方案，两者不冲突。09 的 `/switch` 命令在 Dashboard 实现后仍然保留（用户可能习惯命令式操作）。

---

## 附录：Claude Code Agent View 完整键盘快捷键

| 快捷键 | 动作 |
|--------|------|
| `↑/↓` | 行间移动 |
| `Enter` | Attach（有文本时为派发） |
| `Space` | Peek 面板切换 |
| `Shift+Enter` | 派发并立即 attach |
| `→` | Attach |
| `←` (空 prompt) | Detach / 后台化当前 session |
| `Alt+1…9` | 快速 attach 到组内第 N 个 session |
| `Tab` | 浏览 subagent 列表 / 应用建议 |
| `Ctrl+S` | 切换分组方式（状态 vs 目录） |
| `Ctrl+T` | 置顶/取消置顶 |
| `Ctrl+R` | 重命名 session |
| `Ctrl+G` | 在 $EDITOR 中编辑 dispatch prompt |
| `Ctrl+X` | 停止 session（2 秒内再按删除） |
| `Shift+↑/↓` | 重新排序 |
| `Esc` | 关闭 peek / 清空输入 / 退出 |
| `?` | 显示所有快捷键 |
| `!<cmd>` | 在 peek 中发送 Bash 命令 |

筛选语法（在 dispatch 输入框中）：
- `a:<agent>` — 按 agent 筛选
- `s:<state>` — 按状态筛选
- `#<PR>` 或 PR URL — 按 PR 筛选
