# Legacy Always-On 产品与功能文档

本文对照 `third-party/claude-code-main` 中的旧实现，整理 Always-On 的产品形态和可观察行为。本文只描述旧项目已经存在的事实，不代表 PolitDeck 必须逐项照搬。

## 1. 产品定位

Always-On 的目标是在用户不持续输入的情况下，仍能围绕一个项目产生有边界的后台智能行为：

- 定时执行用户已经创建的 cron 任务。
- 在项目空闲时主动发现值得跟进的后续工作。
- 把发现结果保存为结构化 discovery plan，而不是立即执行高风险任务。
- 通过 `/ao` 命令查看 cron 任务、discovery plan，并手动运行其中一项。
- 在项目目录内留下可审计的状态、日志和历史记录。

旧项目中还有一条源码注释称为 “Always-on bridge” 的 remote control / `replBridge` 能力，但它与本文讨论的 EdgeClaw Always-On 调度系统没有直接配置耦合。PolitDeck 重写 Always-On 时，应把 remote control 视为另一个 gateway/remote-control 议题，不纳入第一阶段 parity。

## 2. 用户可见功能

### `/ao` 命令

旧项目在 `src/commands/ao/` 实现 `/ao` 命令，并在命令注册表中注册为 `ao`。用户可执行：

- `/ao list`：展示 cron jobs 与 discovery plans 的合并列表。
- `/ao list cron`：仅展示 Always-On cron jobs。
- `/ao list plan`：仅展示 discovery plans。
- `/ao status cron <id>`：查看指定 cron job。
- `/ao status plan <id>`：查看指定 discovery plan。
- `/ao run cron <id>`：手动触发指定 cron job。
- `/ao run plan <id>`：把指定 discovery plan 标记为运行，并把执行 prompt 作为下一条输入提交。

命令输出使用 Markdown 系统消息，列表标题包含 `# Always-On`。命令异常时返回 `Always-On command failed: ...`。

### 主动发现

主动发现不是直接修改代码的自动执行器。旧实现生成的 prompt 明确要求：

- 只做发现和规划。
- 如果没有值得跟进的工作，说明原因并停止。
- 如果有值得跟进的工作，最多用 `AlwaysOnDiscoveryPlan` 保存 3 个计划。
- 保存的计划必须包含 `## Context`、`## Signals Reviewed`、`## Proposed Work`、`## Execution Steps`、`## Verification`、`## Approval And Execution`。
- 除非工作明显安全且适合自动执行，否则使用 `approvalMode: "manual"`。
- 不调用 `CronCreate`，不立即执行工作，不启动后台任务。
- 语言优先跟随近期聊天记录。

相关实现位于 `src/utils/alwaysOnDiscoveryPrompt.ts` 与 `src/tools/AlwaysOnDiscoveryPlanTool/AlwaysOnDiscoveryPlanTool.ts`。

### Cron 运行历史

旧项目把 cron 运行痕迹写入项目内 `.claude/always-on`：

- `.claude/always-on/runs/<runId>.log`
- `.claude/always-on/runs/<runId>.events.jsonl`
- `.claude/always-on/run-history.jsonl`

日志行使用 `[AlwaysOnCronRun]` 前缀，并记录 `runId`、`taskId`、`phase`、`message` 等字段。history 事件包含 `relativeTranscriptPath`、`transcriptKey`、`manualOnly`、`recurring`、`durable` 等信息。

## 3. 配置模型

旧配置入口位于 `edgeclaw-config.ts`。默认配置为：

```yaml
alwaysOn:
  discovery:
    trigger:
      enabled: false
      tickIntervalMinutes: 5
      cooldownMinutes: 60
      dailyBudget: 4
      heartbeatStaleSeconds: 90
      recentUserMsgMinutes: 5
      preferClient: webui
    projects: {}
```

要真正触发 discovery，必须同时满足：

- `alwaysOn.discovery.trigger.enabled === true`
- `alwaysOn.discovery.projects[resolvedProjectRoot].enabled === true`
- 项目路径存在
- 有新鲜 heartbeat
- agent 不忙
- 最近用户消息超过冷却窗口
- 未处于 discovery cooldown
- 当日次数未超过 `dailyBudget`
- 没有其他 discovery lock 占用

旧配置还支持把历史键 `agents.alwaysOn.discovery.trigger` 迁移到顶层 `alwaysOn.discovery.trigger`。合并完成后会删除 `agents.alwaysOn`。

## 4. 运行机制

### Heartbeat

TUI 侧通过 `useAlwaysOnHeartbeat` 每 30 秒写一次 heartbeat：

```json
{
  "schemaVersion": 1,
  "writerKind": "tui",
  "writerId": "<pid>",
  "writtenAt": "<iso timestamp>",
  "agentBusy": false,
  "processingSessionIds": [],
  "lastUserMsgAt": null
}
```

heartbeat 写入 `.claude/always-on/heartbeats/tui-<pid>.beat`。写完后，TUI 还会向 cron daemon 发送 `register_project`，使 daemon 知道该项目需要参与调度。hook cleanup 时会删除当前 heartbeat 文件。

### Discovery scheduler

`DiscoveryScheduler.ensureProject(projectRoot)` 会：

1. 规范化项目路径。
2. 为项目注册一个 `setInterval`，间隔来自 `tickIntervalMinutes`。
3. 立即执行一次 `tickProject`。
4. 每次 tick 调用 `evaluateDiscoveryGates`。
5. gate 通过后调用 `notifyDiscoveryFire`。

`notifyDiscoveryFire` 会写入 discovery request，并调用 `markDiscoveryFireStarted` 更新 `.claude/always-on/discovery-state.json`。

### Discovery request 消费

旧项目的 TUI 侧通过 `useAlwaysOnDiscoveryRequests` 每 5 秒扫描 daemon 的 `discovery-requests` 目录。只有当请求同时满足以下条件时才被消费：

- `targetWriterKind === "tui"`
- `targetWriterId === String(process.pid)`
- `projectRoot` 等于当前项目根目录

消费后，TUI 会把 `buildAlwaysOnDiscoveryPrompt(projectRoot)` 放入 pending notification 队列，随后向 daemon 发送 `discovery_fire_complete`，状态为 `started`，最后删除 request 文件。

一个重要旧行为是：仓库内当前可见路径只在 TUI 消费请求时发送 `started` ack；daemon 端仍会通过 `markDiscoveryFireComplete` 写入 `lastFireCompletedAt` 并释放 discovery lock。因此旧实现里的 “complete” 更接近“请求已经投递给客户端”，不是 discovery plan 执行完成。

### Gate 与状态文件

项目内状态路径由 `src/utils/alwaysOnPaths.ts` 定义：

```text
.claude/always-on/
  heartbeats/
  discovery.lock
  discovery-state.json
```

`discovery-state.json` 的结构为：

```json
{
  "schemaVersion": 1,
  "lastFireStartedAt": "...",
  "lastFireCompletedAt": "...",
  "todayKey": "2026-05-08",
  "todayRunCount": 1,
  "consecutiveFailures": 0
}
```

Gate block reason 取值包括 `disabled`、`project_disabled`、`project_missing`、`no_fresh_heartbeat`、`agent_busy`、`recent_user_msg`、`cooldown`、`daily_budget`、`lock_busy`。

## 5. Discovery Plan 数据模型

旧项目通过 `AlwaysOnDiscoveryPlan` 工具持久化 discovery plan。工具权限固定为 `allow`，工具本身 `shouldDefer: true`，并且每次最多保存 3 个计划。

Discovery plan index 存放在：

```text
.claude/always-on/discovery-plans.json
.claude/always-on/plans/<planId>.md
```

核心字段包括：

- `id`
- `title`
- `approvalMode`: `auto` 或 `manual`
- `status`: `draft`、`ready`、`queued`、`running`、`completed`、`failed`、`superseded`
- `summary`
- `rationale`
- `dedupeKey`
- `sourceDiscoverySessionId`
- `executionSessionId`
- `executionStatus`
- `contextRefs`
- `planFilePath`
- `structureVersion`

Markdown 正文必须包含固定章节，否则旧实现视为无效 plan。

## 6. Daemon 职责

旧项目 cron daemon 是 Always-On 的常驻宿主。它负责：

- 监听本地 socket。
- 管理 project registry。
- 通过 `register_project` 为项目注册 runtime，并调用 discovery scheduler。
- 调度 cron tasks。
- 管理 session-scoped cron tasks。
- 在无新鲜 client lease 后延迟自停。
- 处理 `discovery_fire_complete`，释放 discovery lock 并更新 discovery state。
- 停止时关闭 scheduler、runtime、session task store，并删除 socket。

## 7. Feature Matrix

| Legacy feature | 旧行为 | PolitDeck 重写状态建议 |
| --- | --- | --- |
| `/ao list/status/run` | 统一入口管理 cron 与 discovery plan | 第一阶段实现 |
| discovery trigger config | 默认关闭，项目级 opt-in | 第一阶段实现 |
| heartbeat | TUI/WebUI 写入项目内 heartbeat | 第一阶段实现，但 writer 由 gateway channel lease 替代或兼容 |
| discovery gates | disabled/project/busy/recent/cooldown/budget/lock | 第一阶段实现 |
| discovery request file | daemon 写 request，TUI/WebUI 轮询消费 | 第一阶段建议替换为 gateway 内部队列，legacy parity 用兼容报告验证 |
| discovery prompt | 中英文 prompt，保存 plan 不执行 | 第一阶段实现 |
| `AlwaysOnDiscoveryPlan` | 保存最多 3 个 plan，权限 allow | 第一阶段实现 |
| cron run log/history | `.claude/always-on/runs` 与 `run-history.jsonl` | 第二阶段实现 |
| daemon socket | cron daemon 本地 socket | PolitDeck 中由 `politdeck server` + WS/API 替代 |
| empty-client shutdown | 无 client lease 后延迟自停 | 第二阶段或 intentional difference |
| remote-control bridge | `replBridge` 状态机与远程控制 | 不纳入本 Always-On 第一阶段 |

## 8. Parity 可观察点

可用于后续双边测试的旧项目可观察输出包括：

- 同一 YAML 配置解析出的 discovery trigger config。
- 给定 heartbeat/state/lock 时，`evaluateDiscoveryGates` 返回的 `ok` 或 block reason。
- gate 通过后生成的 discovery request JSON 结构。
- `markDiscoveryFireStarted` 和 `markDiscoveryFireComplete` 对 `discovery-state.json` 的更新。
- `buildAlwaysOnDiscoveryPrompt(projectRoot, language)` 的文本。
- `AlwaysOnDiscoveryPlan` 工具保存后的 index JSON、plan markdown 路径和工具返回内容。
- `/ao` 参数解析、缺失 plan、queued plan、running plan 的错误或状态变化。
- cron run log 行和 `run-history.jsonl` 的归一化结构。

只有上述共享场景在旧项目和新项目中用同一输入执行并比较归一化输出后，才能声明对应 execution parity passed。
