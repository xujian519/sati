# PolitDeck Always-On 重写方案

本文给出 PolitDeck Always-On 模块的完整重写方案。本文是开发设计文档，不实现代码。

Always-On 在 PolitDeck 中只保留一条主线：在合适的时机，对一个项目自动执行一次主动发现；每次发现最多产出 1 份结构化 plan，并立即在该项目的隔离环境中自动执行该 plan，产出工作报告。

## 1. 架构

Gateway-native Always-On。Always-On 是 `politdeck server` 进程内的一个 runtime 模块，不引入独立常驻进程，不引入新的本地 socket。

```text
politdeck server
  -> GatewayServer / WebSocket
  -> SessionRouter
  -> AlwaysOnRuntime
       -> DiscoveryScheduler
            -> Gates
            -> SignalWatcher
       -> ChannelLeaseRegistry
       -> WorkspaceProviderRegistry
       -> DiscoveryStore
            -> state.json
            -> plans/<planId>.md
            -> reports/<runId>.md
            -> run-history.jsonl
  -> Gateway.submitTurn()
       -> AgentSession
```

依赖事实：

- `politdeck server` 已是常驻进程入口。`src/cli/politdeck.ts` 在 `server` 子命令中调用 `createLocalGateway` + `startPolitDeckServer`，并用永不 resolve 的 Promise 保持进程存活。
- `Gateway` 抽象在 `src/gateway/protocol/types.ts` 中已定义。Always-On 只通过 `Gateway.submitTurn()` 进入 `AgentSession`，不绕过权限、上下文与工具运行时。
- `SessionRouter` 负责 `sessionKey -> AgentSession` 缓存、同 session 并发拒绝（`session_busy`）、idle 回收。Always-On 必须复用，不重新实现。
- `AgentRuntimeConfig.cwd` 控制 agent 的工作目录。本方案的隔离环境通过把 plan 执行 turn 的 `cwd` 切换到隔离工作区路径来实现，而不是 fork 单独的 agent 内核。
- `src/polit/paths.ts` 已定义 `~/.politdeck`、`.politdeck/` 项目目录与 `createProjectId`。Always-On 的所有路径必须经过 `AlwaysOnPaths` 模块集中解析，不在业务代码里散落拼接。

## 2. 模块结构

```text
src/always-on/
  protocol/
    types.ts                  AlwaysOnDiscoveryState / AlwaysOnChannelLease /
                              DiscoveryPlanRecord / DiscoveryRunReport / GateResult
  config/
    parseAlwaysOnConfig.ts    YAML -> 强类型配置
  runtime/
    AlwaysOnRuntime.ts        生命周期入口，绑定 Gateway、watcher、provider
    DiscoveryScheduler.ts     单项目 tick 循环，dormancy 与重新激活
    DiscoveryGates.ts         纯函数 gate，输出结构化结果
    DiscoveryFire.ts          一次 fire 的状态机：plan 生成 -> 隔离 -> 执行 -> 报告
    SignalWatcher.ts          fs.watch 包装与节流去重，过滤 .gitignore
    ChannelLeaseRegistry.ts   server 内存 lease，由 channel adapter 更新
    PlanContract.ts           plan markdown 结构校验，0/1 plan 解析
    ReportContract.ts         work report markdown 结构校验
  workspace/
    WorkspaceProvider.ts      接口：prepare / publish / dispose
    GitWorktreeProvider.ts    git 仓库且 worktree 可用的实现
    SnapshotCopyProvider.ts   非 git / worktree 不可用时的 COW 拷贝实现
    WorkspaceProviderRegistry.ts  按项目类型解析 provider
  storage/
    AlwaysOnPaths.ts          所有路径解析入口
    DiscoveryStateStore.ts    state.json 读写
    DiscoveryPlanStore.ts     plan markdown index 与文件读写
    DiscoveryReportStore.ts   work report markdown 与 run-history.jsonl
  tool/
    AlwaysOnDiscoveryPlanTool.ts  agent 用来产出 plan 的内置工具
    AlwaysOnReportTool.ts          agent 用来落 work report 的内置工具
```

接入点：

- `src/cli/politdeckServer.ts`：在 server 启动时构造 `AlwaysOnRuntime` 并 start；在 server 停止时 stop。
- `src/tool/builtin/`：注册 `AlwaysOnDiscoveryPlanTool` 与 `AlwaysOnReportTool`。
- `src/polit/config/`：解析 `alwaysOn` 配置段。
- `src/gateway/`：不修改协议；Always-On 仅作为 server-side 服务调用 `Gateway`。

## 3. 配置

`~/.politdeck/politdeck.yaml`：

```yaml
alwaysOn:
  enabled: false
  trigger:
    enabled: false
    tickIntervalMinutes: 5
    cooldownMinutes: 60
    dailyBudget: 4
    heartbeatStaleSeconds: 90
    recentUserMsgMinutes: 5
    preferChannel: web
  dormancy:
    enabled: true
    debounceMs: 2000
    ignoreGlobs:
      - "**/.git/**"
      - "**/node_modules/**"
      - "**/.politdeck/**"
      - "**/.politdeck-always-on/**"
      - "**/dist/**"
      - "**/.DS_Store"
  workspace:
    gitWorktreeBaseDir: "${POLIT_HOME}/always-on/worktrees"
    snapshotBaseDir: "${POLIT_HOME}/always-on/snapshots"
    maxConcurrentEnvs: 1
    retainSuccessfulEnvs: false
    retainFailedEnvs: true
  execution:
    maxTurns: 30
    maxToolCalls: 200
    timeoutMinutes: 20
  projects:
    /absolute/project/root:
      enabled: true
```

关键点：

- 配置不存在 `discovery` 包装层，`trigger`、`dormancy`、`workspace`、`execution`、`projects` 与 `alwaysOn.enabled` 同级。
- `dailyBudget` 沿用旧语义：每天最多触发的 fire 次数。
- 每次 fire 至多产出 1 份 plan，是协议层硬约束（见 §7），无对应配置项。
- `dormancy.enabled` 控制是否启用“产出 0 plan 后转入静默并监听文件变化”的机制（见 §6）。
- `workspace` 段只描述资源参数（基址、并发上限、保留策略等）；具体使用哪种隔离方式由 `WorkspaceProviderRegistry` 按 provider 注册顺序自动判定（见 §9），不提供 `strategy` 配置。
- `workspace.maxConcurrentEnvs` 控制单项目同时存在的隔离环境上限，超出则后续 fire 进入 cooldown。
- `execution` 段只描述运行边界（轮次、工具次数、超时）；执行 turn 的权限模式由本方案固定为 `bypassPermissions`，不可配置（见 §5）。
- `projects.<absoluteProjectRoot>` 仅保留 `enabled` 一项。`sessionKey` 由 runtime 用稳定函数派生，不允许逐项目配置。

## 4. 状态与存储

所有状态写入 `${POLIT_HOME}/always-on/projects/${createProjectId(projectRoot)}/`，由 `AlwaysOnPaths` 集中解析，不再写入项目根。

```text
${POLIT_HOME}/always-on/projects/<projectId>/
  state.json
  plans/
    <planId>.md
    index.json
  reports/
    <runId>.md
  runs/
    <runId>.events.jsonl
  run-history.jsonl
  locks/
    discovery.lock
${POLIT_HOME}/always-on/worktrees/
  <projectId>/<runId>/
${POLIT_HOME}/always-on/snapshots/
  <projectId>/<runId>/
```

`state.json`：

```ts
type AlwaysOnDiscoveryState = {
  schemaVersion: 1;
  lastFireStartedAt?: string;
  lastFireCompletedAt?: string;
  lastFireOutcome?: "executed" | "no_plan" | "failed";
  lastPlanId?: string;
  lastRunId?: string;
  todayKey: string;
  todayRunCount: number;
  consecutiveFailures: number;
  dormant?: {
    since: string;
    lastBaselineAt: string;
    lastChangeAt?: string;
  };
};
```

`plans/index.json`：

```ts
type DiscoveryPlanIndex = {
  schemaVersion: 1;
  plans: DiscoveryPlanRecord[];
};

type DiscoveryPlanRecord = {
  id: string;
  title: string;
  createdAt: string;
  status: "ready" | "executing" | "completed" | "failed";
  summary: string;
  rationale: string;
  dedupeKey: string;
  sourceRunId: string;
  planFilePath: string;
  reportFilePath?: string;
  workspace?: {
    strategy: string;
    handle: string;
    cwd: string;
  };
};
```

`run-history.jsonl` 每行：

```ts
type DiscoveryRunHistoryEvent = {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  outcome: "executed" | "no_plan" | "failed" | "aborted";
  planId?: string;
  workspace?: { strategy: string; handle: string };
  error?: { code: string; message: string };
};
```

锁：单项目使用 `locks/discovery.lock`，文件存在视为占用；进程退出时通过 `try/finally` 清理；启动时若锁存在但 `state.lastFireStartedAt` 早于阈值则视为 stale 自动释放。

## 5. Runtime 总流程

一次成功的 Always-On 链路：

```text
DiscoveryScheduler.tick(projectKey)
  -> evaluateGates(state, lease, config, now)
       -> 不通过：根据 outcome 进入下一次 tick / dormancy；不写 lock
       -> 通过：acquire lock，markFireStarted
  -> DiscoveryFire.run()
       1. produce plan
            gateway.submitTurn({
              sessionKey,
              channelKey: "always-on/discovery",
              projectKey,
              message: buildDiscoveryPrompt(projectRoot),
              mode: "default",
              runId,
            })
            agent 调用 AlwaysOnDiscoveryPlanTool 至多 1 次
            tool 把 markdown 写到 plans/<planId>.md，并返回 PlanContract 校验通过的 record
       2. 若 0 plan：
            markFireCompleted(outcome="no_plan")
            进入 dormancy（如启用）
            释放 lock；END
       3. 若 1 plan：
            workspace = WorkspaceProviderRegistry.resolve(projectRoot).prepare(runId)
            gateway.submitTurn({
              sessionKey: deriveExecutionSessionKey(projectKey, runId),
              channelKey: "always-on/execute",
              projectKey,
              message: buildExecutionPrompt(plan, workspace),
              mode: "bypassPermissions",
              runId: executionRunId,
            })
            执行 turn 内部以 workspace.cwd 作为 AgentRuntimeConfig.cwd
            agent 调用 AlwaysOnReportTool 落 reports/<runId>.md
       4. workspace.publish() 或 workspace.dispose()
       5. markFireCompleted(outcome="executed" | "failed")
       6. append run-history.jsonl
       7. 释放 lock
```

关键不变量：

- 任一时刻同 `projectKey` 至多 1 个 fire。靠 `discovery.lock` + `SessionRouter.beginTurn` 双重防护。
- plan 与 execution 使用不同的 `sessionKey`，避免与用户主 session 冲突。`deriveExecutionSessionKey` 是稳定函数：`always-on/execute:project=<projectKey>:run=<runId>`。
- 执行 turn 的 `cwd` 永远是隔离工作区路径，绝不是项目根本身。
- 执行 turn 的权限模式固定为 `bypassPermissions`，agent 在隔离环境内可以执行任何工具调用，不再触发交互式权限询问。这是“先隔离、再放权”的契约，不是“放权再保护”，因此 §9 的隔离环境创建必须先成功。
- 任一 fire 的 outcome 必须落到 `state.json` 与 `run-history.jsonl`，不允许只在内存中维护。
- agent 若没有调用 `AlwaysOnDiscoveryPlanTool`，按 0 plan 处理；若调用超过 1 次，第 2 次返回错误码 `plan_quota_exhausted`。每次 fire 仅允许 1 次成功调用是协议层硬约束，无可配置开关。

## 6. 触发频率与 Dormancy

频率机制由两层叠加。

第一层（继承旧实现）：常规 gate。

| Gate | reason |
| --- | --- |
| 全局未启用 | `disabled` |
| 项目未启用 | `project_disabled` |
| 项目路径不存在 | `project_missing` |
| 无新鲜 lease | `no_fresh_lease` |
| agent 忙 | `agent_busy` |
| 最近用户消息 | `recent_user_msg` |
| 冷却期 | `cooldown` |
| 当日预算耗尽 | `daily_budget` |
| 锁占用 | `lock_busy` |
| 隔离环境上限 | `workspace_capacity` |
| 静默期内无变化 | `dormant_no_signal` |

第二层（新增）：dormancy 与文件信号。

```text
fire outcome = no_plan
  -> state.dormant = { since: now, lastBaselineAt: now }
  -> SignalWatcher.start(projectRoot, ignoreGlobs)
  -> tick 进入 dormant_no_signal 短路，不再做 gate 评估，也不消耗预算
SignalWatcher 检测到去抖后变化
  -> state.dormant = undefined
  -> SignalWatcher.stop()
  -> 下一个 tick 走完整 gate 评估
fire outcome = executed | failed
  -> 不进入 dormancy，沿用 cooldown
```

要求：

- dormancy 仅在 `fire outcome === "no_plan"` 后触发，其余 outcome 仍走 cooldown 与 dailyBudget。
- `SignalWatcher` 必须按 `dormancy.ignoreGlobs` 过滤，不监听 `.git`、`node_modules`、本模块自身写入的 `${POLIT_HOME}/always-on/**` 与项目内 `.politdeck/**`，否则会自激。
- 节流：去抖 `dormancy.debounceMs`，相同路径在窗口内仅唤醒一次。
- 项目路径被删除或权限不足时，watcher 应停下并把项目下次 gate 标记为 `project_missing`，而不是无限重试。
- watcher 实现优先用 Node 内置 `fs.watch`（recursive 在 macOS / Windows 原生支持，Linux 需自行递归注册子目录或使用降级轮询）。降级策略：当 `fs.watch` 不可用时，回退到固定间隔的 mtime 扫描，扫描周期不大于 `tickIntervalMinutes`。
- `state.dormant.lastBaselineAt` 用于把 watcher 启动时间作为对照点；启动后立刻发生的、来自 fire 自身（如清理隔离环境）的事件应被忽略。
- server 重启后 dormancy 状态从 `state.json` 恢复；若 watcher 无法重启（路径丢失等），状态自动降级为非 dormant。

可选 PolitDeck 增强（默认关闭，不属于必需行为）：当连续 N 次（如 3 次）`no_plan` 后，把下一次有效信号要求提升为“连续 M 个文件事件”或“关键路径事件”，避免无意义的 plan 反复尝试。该增强必须在配置中显式开启，且不影响 dual parity scenario 的默认输出。

## 7. Plan Markdown 规范

每次 fire 至多 1 份 plan。Plan 用纯 markdown 文件存放在 `plans/<planId>.md`。`AlwaysOnDiscoveryPlanTool` 在 server 端做 `PlanContract` 校验，未通过的 plan 不入库。

固定结构：

```md
# <plan title>

> Always-On Discovery Plan
> id: <planId>
> sourceRunId: <runId>
> createdAt: <ISO timestamp>
> projectRoot: <absolute path>
> dedupeKey: <stable key>

## Summary
<一段话，限制 200 字以内>

## Rationale
<为什么现在做这件事>

## Context Signals
- <可观察信号 1>
- <可观察信号 2>

## Proposed Change
<将要改动的对象、影响面，禁止使用模糊措辞>

## Execution Steps
1. <步骤 1>
2. <步骤 2>
...

## Verification
- <可被自动检查的验收点>
- <可被自动检查的验收点>
```

校验规则（由 `PlanContract` 实现）：

- 文件必须以 `# ` 一级标题开头。
- 一级标题之后立即跟随元信息 blockquote，blockquote 第一行必须是 `Always-On Discovery Plan`，并依次包含 `id`、`sourceRunId`、`createdAt`、`projectRoot`、`dedupeKey` 五个键值行；缺一不可。
- 章节顺序固定且不允许多余二级章节：`Summary`、`Rationale`、`Context Signals`、`Proposed Change`、`Execution Steps`、`Verification`。缺少任一章节、出现额外二级章节、或出现重复章节都视为无效。
- 章节内部要求：
  - `Summary`：单段纯文本，不超过 200 个字符。
  - `Rationale`：单段或多段纯文本，至少 1 个非空字符。
  - `Context Signals`：至少 1 条无序列表项（`-` 开头），每项不超过 200 字符。
  - `Proposed Change`：至少 1 段非空文本；不允许仅写“TODO/待补充”等模糊字样。
  - `Execution Steps`：至少 1 条有序列表项，且全部步骤为有序列表（不混用无序列表）。
  - `Verification`：至少 1 条无序列表项，每条必须是可被自动检查的具体语句（如 `tests pass`、`<file> contains <text>`、`<command> exits 0`）。
- 整体文件大小不得超过 `maxResultSizeChars`（默认 100k）。
- 字符集为 UTF-8，行尾归一为 `\n`，写入前 trim 尾随空白行。

工具行为：

- `AlwaysOnDiscoveryPlanTool` 输入 schema：`{ title, summary, rationale, dedupeKey, content }`，其中 `content` 是上述 markdown 全文。
- 工具在 server 端：解析校验 -> 生成 `planId` -> 写文件 -> 更新 `plans/index.json` -> 返回 `DiscoveryPlanRecord`。
- 工具在同一 fire 内最多被调用一次；第 2 次调用直接返回错误 `plan_quota_exhausted`。该上限是协议常量，不读配置。
- 工具权限固定 `allow`，不弹窗（discovery turn 仍走默认权限模式，但本工具自身始终允许）。

## 8. Work Report Markdown 规范

每次执行后产出 1 份 work report，写入 `reports/<runId>.md`。

```md
# <plan title> - Work Report

> Always-On Discovery Run Report
> runId: <runId>
> planId: <planId>
> startedAt: <ISO timestamp>
> finishedAt: <ISO timestamp>
> outcome: executed | failed | aborted
> workspaceStrategy: git-worktree | snapshot-copy
> workspaceHandle: <provider 句柄，例如 worktree path 或 snapshot dir>

## Plan Reference
<指回 plan 文件相对路径>

## Steps Performed
1. <agent 实际执行的步骤>
2. ...

## Files Changed
- <相对工作区路径> (added | modified | deleted)
- ...

## Command Output
<重要命令输出摘要，长输出折叠>

## Verification Results
- [x] <plan Verification 中的某条> - <结果>
- [ ] <未通过项> - <原因>

## Follow-ups
- <下一步建议>
- ...

## Notes
<其他需要保留的信息，例如失败堆栈>
```

工具行为：

- `AlwaysOnReportTool` 在执行 turn 内被 agent 调用至少一次；缺少调用则视为失败，runtime 在 turn 结束后兜底写一份 `outcome: failed`、`Steps Performed: <empty>` 的占位 report。
- report markdown 由 `ReportContract` 校验，缺章节由兜底逻辑补齐而不是直接报错（区别于 plan 的严格校验）。
- 兜底原因必须写到 `Notes`，便于事后分析。

## 9. 隔离环境抽象

隔离环境通过 `WorkspaceProvider` 接口统一抽象。

```ts
type WorkspaceStrategyId = "git-worktree" | "snapshot-copy";

type WorkspaceHandle = {
  runId: string;
  projectKey: string;
  strategy: WorkspaceStrategyId;
  cwd: string;
  metadata: Record<string, string>;
};

interface WorkspaceProvider {
  readonly id: WorkspaceStrategyId;
  readonly priority: number;
  isApplicable(projectRoot: string): Promise<boolean>;
  prepare(input: { projectRoot: string; runId: string }): Promise<WorkspaceHandle>;
  publish(handle: WorkspaceHandle): Promise<{ commit?: string; diff?: string }>;
  dispose(handle: WorkspaceHandle, options: { keep: boolean }): Promise<void>;
}
```

`WorkspaceProviderRegistry` 按以下顺序解析（不读取任何 strategy 配置）：

1. 把已注册 provider 按 `priority` 升序排列。内置 provider 的优先级固定为：`GitWorktreeProvider`（1） -> `SnapshotCopyProvider`（2）。第三方 provider 通过注册接口插入合适位置。
2. 依次调用 `isApplicable(projectRoot)`，第一个返回 `true` 的 provider 胜出。
3. 若全部 provider 都不适用，fire 直接失败，outcome `failed`，错误码 `workspace_unavailable`。

注册表只维护 provider 列表与优先级，不接受用户在配置或运行时手动“强制选某种策略”的入口。隔离方式由代码与项目实际状态共同决定，避免出现“我配的是 git-worktree 但仓库是 dirty 所以悄悄退化”的歧义路径。

### 9.1 Git Worktree Provider

适用条件：

- 项目根属于 git 工作区（`git rev-parse --show-toplevel` 成功）。
- 当前 git 版本支持 `git worktree`（>= 2.5）。
- 工作区存在 `HEAD` 引用，且无未完成的 rebase / merge。

`prepare`：

```text
git -C <projectRoot> rev-parse --show-toplevel             -> repoRoot
git -C <repoRoot> rev-parse --abbrev-ref HEAD              -> baseBranch
git -C <repoRoot> rev-parse HEAD                           -> baseCommit
worktreePath = ${POLIT_HOME}/always-on/worktrees/<projectId>/<runId>
git -C <repoRoot> worktree add --detach <worktreePath> <baseCommit>
return { strategy: "git-worktree", cwd: worktreePath, metadata: { repoRoot, baseBranch, baseCommit } }
```

`publish`：默认不向源仓库推送，只产出 `diff` 摘要写入 work report。如需保留更改，调用方可在 `publish()` 阶段调用 `git -C <worktreePath> add -A && git commit` 并把 commit hash 写入元信息，但不自动 push 到远端。

`dispose`：

```text
git -C <repoRoot> worktree remove --force <worktreePath>
若失败，回退 rm -rf <worktreePath> 并 git -C <repoRoot> worktree prune
```

注意事项：

- 拒绝在含未跟踪重要文件的 dirty 工作区中并发执行 plan，避免与用户开发冲突。dirty 状态可通过 `git status --porcelain` 判断；策略由配置决定（默认 `prepare` 失败并 outcome `failed`）。
- 子模块通过 `git worktree add --recurse-submodules` 处理；不可用时退化为 snapshot-copy。
- LFS 资产仅在配置 `workspace.gitLfs: true` 时显式 fetch；默认不拉。

### 9.2 Snapshot Copy Provider

适用条件：`GitWorktreeProvider.isApplicable` 返回 false（项目根不是 git 工作区，或 git 状态不允许并发 worktree）。本 provider 自身的 `isApplicable` 在能成功创建目标基址、且通过大小预估检查后返回 true。

推荐实现：基于 OS 的 copy-on-write，最大限度降低磁盘与 IO 成本，并按 `dormancy.ignoreGlobs` 过滤。

策略优先级：

1. macOS：`clonefile`（即 `cp -c`）。APFS 上是 O(1) COW 克隆。
2. Linux：`cp --reflink=auto`。在 btrfs / xfs(reflink) / zfs 上为 COW；不支持时降级为常规复制。
3. 通用降级：递归复制（`fs.cp` with `recursive: true`），同时按 ignore 列表跳过。
4. 进一步降级（大型仓库）：调用系统 `rsync -a --exclude-from=<list>`。

`prepare`：

```text
target = ${POLIT_HOME}/always-on/snapshots/<projectId>/<runId>
按策略选择 cloneFile / reflink / fsCp / rsync
应用 ignore 列表：.git/、node_modules/、dist/、.politdeck/、.politdeck-always-on/ 与配置项
return { strategy: "snapshot-copy", cwd: target, metadata: { strategy: "<chosen>", baseSize } }
```

`publish`：snapshot 模式不写回源项目。如需保留差异，调用方可在 `publish` 阶段把 `target` 与原项目 diff 摘要写入 work report，或将 `target` 重命名到 `${POLIT_HOME}/always-on/snapshots/<projectId>/keep/<runId>` 长期保留。

`dispose`：`fs.rm(target, { recursive: true, force: true })`。在 `retainSuccessfulEnvs: false` 与 `retainFailedEnvs: true` 的组合下，根据 outcome 决定保留还是删除。

注意事项：

- 大仓库执行前必须做大小预估：超过 `workspace.snapshotMaxBytes`（默认 1 GiB，可配置）时直接 `prepare` 失败，避免拖垮磁盘。
- 文件系统不支持 reflink 时记录到 metadata，便于运维感知性能差异。
- 跨设备路径（不同卷）禁止使用 `clonefile` / `reflink`，自动降级。

### 9.3 不可用兜底

当所有 provider 都返回 `isApplicable: false`（如远程网盘只读项目、权限不足等），fire 直接以 `outcome: failed`、`error.code: "workspace_unavailable"` 结束；plan 状态置 `failed`；work report 由 runtime 兜底写入，说明无法准备隔离环境。这是受控失败而不是异常。

## 10. Channel Lease

Lease 表示某个 channel 当前活跃地代表用户在与该项目交互。Lease 由 server 内存维护，不再写文件 heartbeat。

```ts
type AlwaysOnChannelLease = {
  schemaVersion: 1;
  channelKey: string;       // "web" | "tui" | "cli" | "feishu" | ...
  writerId: string;
  projectKey: string;
  sessionKey: string;
  writtenAt: string;
  agentBusy: boolean;
  lastUserMsgAt?: string | null;
};
```

Lease 在以下时刻更新：

- channel 与 server 建立连接 / 断开连接。
- channel 提交 turn（`busy=true`）。
- turn 完成（`busy=false`，`lastUserMsgAt = now`）。
- channel 显式发送 lease ping（可选，用于长 idle TUI）。

Discovery gate 视无 lease 或 lease 过期为 `no_fresh_lease`，与旧 `no_fresh_heartbeat` 等价。`preferChannel` 仅用于在多 lease 同时新鲜时选择目标 `sessionKey`，不影响 fire 是否触发。

## 11. Gate 评估

Gate 是纯函数：

```ts
type GateInput = {
  config: AlwaysOnConfig;
  state: AlwaysOnDiscoveryState;
  leases: AlwaysOnChannelLease[];
  workspaceCount: number;
  now: Date;
  projectExists: boolean;
};

type GateResult =
  | { ok: true; lease: AlwaysOnChannelLease }
  | { ok: false; reason: GateBlockReason };
```

执行顺序固定：

1. `disabled`
2. `project_disabled`
3. `project_missing`
4. `dormant_no_signal`
5. `no_fresh_lease`
6. `agent_busy`（任一新鲜 lease `agentBusy === true`，或 `SessionRouter` 报告目标 `sessionKey` in-flight）
7. `recent_user_msg`
8. `cooldown`
9. `daily_budget`
10. `workspace_capacity`
11. `lock_busy`
12. `ok`

任何分支都必须返回结构化结果。Gate 不允许只打日志；测试和 UI 都必须能拿到 `reason`。

## 12. Feature Classification

| Legacy feature | Status | PolitDeck 行为 |
| --- | --- | --- |
| discovery config 默认值 | `compare` | 数值默认与旧实现保持一致；增量项（dormancy / workspace / execution）属新增 |
| 项目级 opt-in | `compare` | 必须实现 |
| heartbeat 文件 | `intentional_difference` | 改为 server 内存 lease；字段语义保留 |
| discovery gates | `compare` | 旧 reason 完全保留；新增 `dormant_no_signal`、`workspace_capacity` |
| discovery request file 流转 | `intentional_difference` | 改为 server 直接 `Gateway.submitTurn()` |
| TUI 5 秒 request 轮询 | `not_applicable` | 由 `AlwaysOnRuntime` 内部调度替代 |
| discovery prompt 文本 | `compare` | 中英文 prompt 关键片段保留 |
| 一次产出最多 3 个 plan | `intentional_difference` | 改为最多 1 个 |
| plan markdown required sections | `intentional_difference` | 重新定义章节集合（见 §7） |
| plan auto-execute | `intentional_difference` | 旧实现仅保存，新实现直接在隔离环境执行 |
| `approvalMode` 字段 | `not_applicable` | 自动执行场景不再分 manual / auto |
| `agents.alwaysOn` legacy 迁移 | `not_applicable` | PolitDeck 无 EdgeClaw 旧配置 |

`compare` 项进入 dual parity 测试集合；`intentional_difference` 必须在 fixture 中带 reason；`not_applicable` 不参与 parity 测试。

## 13. 风险与边界

- **隔离环境消耗磁盘**：worktree 在小仓库基本免费，snapshot-copy 在大仓库代价高。必须有 `workspace.snapshotMaxBytes`、`maxConcurrentEnvs`、`retainFailedEnvs` 等开关，禁止默认无限保留。
- **dormancy 无限挂起**：若项目长期无变化，watcher 会一直保持 idle。必须保证 watcher 在 server stop 时一定释放 handle；server 重启后能从 `state.dormant` 恢复。建议为 dormancy 设硬上限（如 24 小时无信号也强制重新评估一次）。
- **session_busy 与 agent_busy 不一致**：`SessionRouter` 是真正的并发权威，lease 中的 `agentBusy` 只是 channel 上报。Gate 必须同时考虑两者；任一为 busy 都跳过。
- **plan 工具被多次调用**：通过 `PlanContract` 在 server 端硬限 1 次。第 2 次调用必须返回明确错误码 `plan_quota_exhausted`，被 agent loop 透传到模型。
- **work report 缺失**：执行 turn 结束时 runtime 必须 sweep；缺失时由兜底逻辑补占位 report，并标 `outcome: failed`。
- **WS final frame 差异**：`GatewayWsConnection` 在流结束追加 synthetic `turn_completed` final frame。Always-On 在 in-process 与 over-WS 模式下的事件采集必须显式区分真实 `turn_completed` 与 synthetic final，避免误判 `executed`。
- **workspace 决策错误**：dirty git 工作区、子模块未初始化、跨卷 reflink、目标盘空间不足等都必须在 `prepare` 阶段以受控错误返回，而非中途崩溃。
- **绕过 Gateway 的诱惑**：执行 plan 时必须仍走 `Gateway.submitTurn()`，不要直接调用 `AgentSession`。这是权限、上下文、工具运行时一致性的前提。
- **执行 turn 处于 bypass 权限模式**：agent 在执行 turn 内可以执行任意工具调用，包括 shell、写文件、网络请求。其安全边界完全依赖 §9 的隔离环境真的隔离。隔离环境创建必须先成功；隔离工作区路径必须真实指向 `${POLIT_HOME}/always-on/worktrees/...` 或 `${POLIT_HOME}/always-on/snapshots/...` 而不是项目根；任何 provider 的 `prepare` 失败都必须直接 outcome `failed`，绝不允许在执行 turn 中回退到项目根作为 `cwd`。运行时还应在 sweep 阶段断言 `cwd` 一定位于隔离基址下，否则 outcome 强制 `failed` 并写明确的兜底原因。

## 14. 验收标准

实现完成的判定（不分阶段，全部满足）：

- `alwaysOn` 配置解析、默认值、错误诊断有单测，覆盖 `trigger`、`dormancy`、`workspace`、`execution`、`projects` 五个子段；并校验 `discovery` 包装层、`workspace.strategy`、`plan` 段、`projects.<root>.sessionKey` / `projects.<root>.workspace` 等被移除字段在出现时给出明确诊断或被忽略。
- `evaluateAlwaysOnDiscoveryGates` 对所有 `GateBlockReason` 有单测，包括新增的 `dormant_no_signal` 与 `workspace_capacity`。
- `SignalWatcher` 有单测：去抖、ignore glob、watcher 重启恢复、降级轮询。
- `AlwaysOnDiscoveryPlanTool` 有单测：合法 plan 入库、缺任一章节拒绝、出现额外二级章节拒绝、二次调用返回 `plan_quota_exhausted`、超大文件拒绝；同时验证模板中不再出现 `Rollback` / `Risks` 章节会被接受。
- `AlwaysOnReportTool` 有单测：合法 report 入库、缺章节兜底、缺调用兜底。
- `WorkspaceProvider` 接口与两个内置 provider 各有单测：
  - `GitWorktreeProvider`：worktree 创建、dirty 拒绝、dispose、worktree prune fallback。
  - `SnapshotCopyProvider`：clonefile / reflink / fsCp / rsync 各路径选择、size cap、ignore glob、跨卷降级。
  - `WorkspaceProviderRegistry`：按 priority 自动选择、git 适用时优先 worktree、git 不适用时降级 snapshot、两者都不适用时 `workspace_unavailable`。
- `AlwaysOnRuntime` 集成测试：用 fake `Gateway` 与 fake provider，分别覆盖 `executed`、`no_plan`、`failed`、`workspace_unavailable` 四种 outcome，并校验 `state.json`、`run-history.jsonl`、plan/report 文件落盘形态；执行 turn 提交参数中 `mode` 必须为 `bypassPermissions`、`cwd` 必须在隔离基址下，断言失败时 outcome 必须为 `failed`。
- 与旧实现的 `compare` 项有共享 scenario，并产出 dual parity 报告（参见 `03-always-on-test-plan.md`）。
- 所有 `intentional_difference` 在 fixture 中带 reason；所有 `not_applicable` 在文档中有出处说明。
- `politdeck server` 启动时构造 `AlwaysOnRuntime`；停止时释放所有 watcher、worktree、snapshot 句柄；进程被强制 kill 时遗留资源在下次启动时被自动 GC。
