# Always-On 测试用例与双边 Parity 方案

本文定义 PolitDeck Always-On 的测试维护方案。核心原则：不能因为新实现“看起来像旧实现”就声明一致；只有同一套共享 scenario 同时运行旧项目和 PolitDeck，并比较归一化输出后，才能声明对应 parity passed。

## 1. 测试目标

Always-On 测试需要验证四类行为：

- **配置与协议**：默认值、解析、状态类型、错误码、feature classification。
- **调度决策**：heartbeat/lease、gate、lock、cooldown、daily budget。
- **执行链路**：discovery prompt 生成、Gateway 提交、plan 工具保存、`/ao run plan`。
- **可观察输出**：state JSON、plan index、plan markdown、run history、GatewayEvent 序列、命令输出。

## 2. 测试分层

```text
unit tests
  -> config / paths / state store / plan store
  -> discovery prompt / plan markdown validation
  -> gates / lock / daily budget
  -> command parser

runtime integration tests
  -> AlwaysOnRuntime + fake Gateway
  -> AlwaysOnRuntime + InProcessGateway + fake AgentSession
  -> AlwaysOnRuntime + GatewayServer + RemoteGateway

dual parity tests
  -> shared scenarios
  -> legacy report runner
  -> PolitDeck report runner
  -> normalized deepEqual
```

底层 gate、store、prompt 测试不启动 server。Runtime 测试可以启动 fake gateway 或真实 ephemeral `GatewayServer`。Dual parity 测试必须执行旧项目对应逻辑，不能只复制旧期望值。

## 3. 建议测试目录

```text
tests/fixtures/always-on/
  dual-parity/
    configScenarios.ts
    gateScenarios.ts
    promptScenarios.ts
    planScenarios.ts
    commandScenarios.ts
    executionScenarios.ts
  runtime/
    discoveryRuntimeScenarios.ts

tests/helpers/
  alwaysOnConfigReport.ts
  alwaysOnGateReport.ts
  alwaysOnPromptReport.ts
  alwaysOnPlanReport.ts
  alwaysOnRuntimeHarness.ts
  normalizeAlwaysOnReport.ts

tests/always-on/
  config.test.ts
  paths.test.ts
  discovery-state-store.test.ts
  discovery-plan-store.test.ts
  discovery-prompt.test.ts
  discovery-gates.test.ts
  discovery-scheduler.test.ts
  always-on-runtime.test.ts
  ao-command.test.ts
  parity-dual-config.test.ts
  parity-dual-gates.test.ts
  parity-dual-prompt.test.ts
  parity-dual-plan.test.ts
  parity-dual-execution.test.ts

third-party/claude-code-main/src/
  politdeck-always-on-legacy-config-report.ts
  politdeck-always-on-legacy-gate-report.ts
  politdeck-always-on-legacy-prompt-report.ts
  politdeck-always-on-legacy-plan-report.ts
  politdeck-always-on-legacy-execution-report.ts
```

现有仓库已经有类似模式：

- `tests/tool/parity-dual-execution.test.ts` 用 `execFileSync("bun", ["run", ...])` 执行旧项目 report，再与 PolitDeck report 比较。
- `tests/agent/parity-dual-contract.test.ts` 要求 scenario id 唯一，且所有非 `compare` 场景必须有 reason。
- `tests/gateway/remote-gateway.test.ts` 已能用 ephemeral server 验证 `RemoteGateway` 事件流。

Always-On 应沿用这些约定。

## 4. Scenario 格式

所有 dual parity scenario 使用统一状态分类：

```ts
export type AlwaysOnParityStatus =
  | "compare"
  | "intentional_difference"
  | "deferred"
  | "not_applicable";

export type AlwaysOnParityScenario<TInput> = {
  id: string;
  status: AlwaysOnParityStatus;
  reason?: string;
  input: TInput;
};
```

规则：

- `id` 必须唯一。
- `status !== "compare"` 时必须写 `reason`。
- `compare` 场景必须同时出现在 legacy report 和 PolitDeck report。
- report 先比较 `{ id, status }` 列表，再对 `compare` 场景 deepEqual `result`。
- 禁止在测试里因为新实现没做而临时删除 scenario。未实现必须标 `deferred` 并解释。

## 5. Contract Parity 与 Execution Parity

### Contract parity passed

仅当以下内容用共享 scenario 验证通过，才可声明 contract parity passed：

- config 默认值和字段名。
- gate reason 枚举。
- heartbeat/lease 归一化 schema。
- discovery state schema。
- discovery plan record schema。
- required markdown sections。
- `/ao` 参数解析结果。

Contract parity 不要求真的执行 discovery turn。

### Execution parity passed

仅当旧项目和 PolitDeck 对同一输入都实际执行，并且归一化输出 deepEqual，才可声明 execution parity passed。

适合 execution parity 的场景：

- 给定 heartbeat/state/config，gate 返回同一结果。
- 给定 projectRoot/language，prompt 文本相同或归一化后相同。
- 给定 plan 输入，保存后的 index、markdown path、工具返回结果相同。
- 给定 `/ao run plan` 输入，plan 状态变化和执行 prompt 关键文本相同。

不适合第一阶段 execution parity 的场景：

- 旧 discovery request 文件轮询 vs 新 Gateway 直接提交。这是 intentional difference。
- 旧 daemon socket 协议 vs 新 Gateway WS/API。这是 intentional difference。
- OS 自启动。这是 not applicable。

## 6. 必测用例清单

### Config

用例：

- 无配置时，discovery 默认 `enabled: false`、`tickIntervalMinutes: 5`、`cooldownMinutes: 60`、`dailyBudget: 4`、`heartbeatStaleSeconds: 90`、`recentUserMsgMinutes: 5`。
- `preferClient` 旧值 `tui` / `webui` 可被 legacy report 正确解析；PolitDeck 可在归一化报告中映射到 `preferChannel`。
- 非正数配置回退到默认值。
- 项目路径归一化为 absolute resolved path。
- 未启用项目返回 `project_disabled`。

Parity：

- 默认值场景 `compare`。
- `agents.alwaysOn` 旧迁移场景第一阶段可标 `deferred`，除非 PolitDeck 明确实现旧 EdgeClaw config 迁移。

### Gates

用例：

- 全局关闭：`disabled`。
- 项目未 opt-in：`project_disabled`。
- 项目路径不存在：`project_missing`。
- 无 heartbeat/lease：`no_fresh_heartbeat`。
- heartbeat stale：`no_fresh_heartbeat`。
- agent busy：`agent_busy`。
- 最近用户消息：`recent_user_msg`。
- cooldown 未过：`cooldown`。
- 当日预算耗尽：`daily_budget`。
- lock 已占用：`lock_busy`。
- 多个 heartbeat/lease 时优先 `preferClient` / `preferChannel`，同类型取最新 `writtenAt`。
- gate 通过时返回被选中的 writer/lease。

Parity：

- gate 输入应使用临时 projectRoot、固定 `now`、固定 state、固定 heartbeat。
- 旧 heartbeat 与新 lease 的字段差异只允许在输入 adapter 中归一化，不能归一化输出 reason。

### Prompt

用例：

- 默认英文 prompt 包含 `Always-On discovery planning`、`recent chats win`、`final reply`。
- `zh-CN` prompt 包含 `Always-On 主动发现规划`、`近期聊天语言为准`、`最终回复`。
- 计划章节必须包含 `## Approval And Execution`。
- 未知语言回退英文。

Parity：

- prompt 文本可以逐字 compare。
- 如果 PolitDeck 引入产品名差异，必须标 intentional difference，并说明是否影响模型可见行为。

### Discovery Plan Store / Tool

用例：

- 保存 1 个 plan。
- 一次保存最多 3 个 plan，超过时报 schema error。
- 缺 required markdown section 时拒绝或返回错误。
- `approvalMode` 只允许 `auto` / `manual`。
- `contextRefs` 非字符串项会被过滤或归一化。
- 同 `dedupeKey` 更新已有 plan。
- `supersedesPlanIds` 会把旧 plan 标记 `superseded`。
- 工具权限固定 allow。
- 工具结果文本包含保存的 plan id、title、approvalMode、status、planFilePath。

Parity：

- index JSON 需要归一化 timestamps、随机 id、临时路径。
- `planFilePath` 是否保留 `.claude/always-on/plans/<id>.md` 取决于新项目路径策略。若新项目改为 `.politdeck/always-on`，路径字段属于 intentional difference，必须在 scenario 中记录。

### `/ao` 命令

用例：

- 空参数返回 help。
- `list`、`list cron`、`list plan` 解析正确。
- `status plan <id>` 解析正确。
- `run cron <id>` 解析正确。
- `run unknown thing` 返回 help，并带 `Usage: /ao run <cron|plan> <id>`。
- missing plan 抛出或返回 `Discovery plan not found`。
- queued/running plan 拒绝运行，错误包含 `already queued or running`。
- ready plan 被标记为 `running`，记录 `executionSessionId`，生成 execution prompt。
- execution prompt 包含 `Do not enter Plan Mode.` 与 `## Execution Steps`。

Parity：

- 参数解析、missing/queued/running/ready plan 可做 compare。
- cron list/status/run 若第一阶段未实现，标 `deferred`。

### Runtime

用例：

- scheduler start 后立即 tick 一次。
- tick interval 使用配置值。
- gate 未通过时不调用 gateway。
- gate 通过时调用 `gateway.submitTurn()`，输入包含固定 `sessionKey`、`channelKey: "always-on"` 或明确的目标 channel、projectKey、discovery prompt。
- gateway 返回 `turn_completed` 时 state 写 completed。
- gateway 返回 `error` 或抛错时 state 写 failed，`consecutiveFailures + 1`。
- 同项目运行中时第二次 tick 不重入。
- shutdown 清 timer，测试不泄漏 handle。

Parity：

- runtime 的 Gateway 直提交链路与旧 request 文件链路不同，不能做旧 execution parity。
- 可做 PolitDeck 内部 transport-symmetric：fake session 同一事件脚本下，InProcessGateway 与 RemoteGateway 触发结果一致。

## 7. 双边 Report 设计

### Config report

输出：

```ts
type AlwaysOnConfigReport = {
  id: string;
  status: AlwaysOnParityStatus;
  result?: {
    trigger: {
      enabled: boolean;
      tickIntervalMinutes: number;
      cooldownMinutes: number;
      dailyBudget: number;
      heartbeatStaleSeconds: number;
      recentUserMsgMinutes: number;
      preferClient: string;
    };
    projectSettings: Record<string, { enabled: boolean }>;
  };
  reason?: string;
};
```

### Gate report

输出：

```ts
type AlwaysOnGateReport = {
  id: string;
  status: AlwaysOnParityStatus;
  result?: {
    ok: boolean;
    reason?: string;
    selectedWriterKind?: string;
    selectedWriterId?: string;
  };
  reason?: string;
};
```

### Prompt report

输出：

```ts
type AlwaysOnPromptReport = {
  id: string;
  status: AlwaysOnParityStatus;
  result?: {
    language: string;
    prompt: string;
  };
  reason?: string;
};
```

### Plan report

输出：

```ts
type AlwaysOnPlanReport = {
  id: string;
  status: AlwaysOnParityStatus;
  result?: {
    savedPlans: Array<{
      id: string;
      title: string;
      approvalMode: "auto" | "manual";
      status: string;
      planFilePath: string;
    }>;
    index: unknown;
    markdownByPath: Record<string, string>;
  };
  reason?: string;
};
```

## 8. 归一化规则

允许归一化：

- 临时项目路径 -> `<PROJECT_ROOT>`。
- 用户 home -> `<HOME>`。
- 时间戳 -> `<TIMESTAMP>`。
- 随机 UUID / runId / generated word slug -> `<ID:n>`。
- 端口 -> `<PORT>`。
- legacy `writerKind: "webui"` 与 PolitDeck `channelKey: "web"` 可映射为 `<WEB_CLIENT>`，但必须只在输入/报告 adapter 中做。

禁止归一化：

- `ok` vs error。
- gate reason。
- status 分类。
- permission allow/deny。
- prompt 中模型可见的行为要求。
- plan required sections。
- command error 文案的关键片段。
- GatewayEvent 类型和顺序。
- `session_busy`、`gateway_submit_failed` 等错误码。

## 9. 测试命令

全量验证：

```bash
npm run build
npm test
```

Always-On 专项建议：

```bash
npm test -- tests/always-on/
```

Legacy focused probe：

```bash
cd third-party/claude-code-main
bun test src/daemon/discoveryScheduler/gates.test.ts
bun test src/commands/ao/helpers.test.ts
bun test src/utils/alwaysOnDiscoveryPrompt.test.ts
bun run src/politdeck-always-on-legacy-gate-report.ts
```

不要依赖整个 vendored 项目全量 build。旧项目 probe 应尽量只 import 相关模块。

## 10. CI Gate

Always-On 进入实现后，CI 至少应包含：

- `npm run build`
- `npm test`
- Always-On dual parity tests
- focused legacy reports

如果 legacy report 因环境不可用跳过，测试必须显式输出 skip reason，不能静默通过并声称 parity passed。

## 11. 失败处理

- 如果 `compare` 场景失败，优先判断是新实现 bug、旧行为误读、还是确实需要 intentional difference。
- 如果是 intentional difference，更新 scenario status 和 reason，再同步更新 `02-politdeck-always-on-rewrite-plan.md` 的 Feature Classification。
- 如果是 deferred，必须写明解除 deferred 的代码入口和测试入口。
- 如果只是路径、时间、随机 id 差异，补充归一化规则，但不得归一化掉用户或模型可见行为。

## 12. 首批建议 Scenario

首批落地应选择风险最高、又能稳定双边执行的场景：

- `config-defaults`
- `config-project-opt-in`
- `gate-disabled`
- `gate-project-disabled`
- `gate-no-fresh-heartbeat`
- `gate-agent-busy`
- `gate-recent-user-message`
- `gate-cooldown`
- `gate-daily-budget`
- `gate-lock-busy`
- `gate-pass-prefer-tui`
- `prompt-english-default`
- `prompt-zh-cn`
- `plan-save-one-manual`
- `plan-save-three-max`
- `plan-reject-missing-section`
- `ao-parse-list-status-run`
- `ao-run-plan-missing`
- `ao-run-plan-queued`
- `ao-run-plan-ready`

这些场景覆盖后，才能开始声称 Always-On 的 contract parity 有基础；runtime execution parity 需要再补 Gateway 提交链路和真实 plan 工具执行链路。
