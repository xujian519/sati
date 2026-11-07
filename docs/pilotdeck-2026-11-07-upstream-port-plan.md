# Sati × PilotDeck 引入方案（2026-11-07 批次）

Status: Approved（2026-11-07 批准执行；M0 已完成）

范围基线：上游 **v2026.10.20**（`96226d8`，2026-10-20）→ **v2026.11.07**（`60dfc6b`，2026-11-07）。
上一份引入方案是 `docs/pilotdeck-2026-10-22-upstream-port-plan.md`，其评估时点止于 v2026.10.20。
本批区间内有 9 个 release、355 个非 merge 提交。

方法沿用既有移植纪律：

1. 先判定，不整包搬：每项先在 Sati 找到落点与现状，再决定是否移植。
2. 一项一提交、一个里程碑一个 PR；核心模块改动附负控制。
3. 不改工具 `inputSchema`（避免 llm-replay fixture 失配）；确需改动时单独评估重录成本。
4. 生成物随代码提交：`pnpm gen:doc-claims`、`pnpm measure:update`，事件面改动再跑 `pnpm gen:event-matrix`。

---

## 0. 结论与分批

| 批次 | 内容 | 判定 | 估工 |
|---|---|---|---|
| M1 | 工具运行时硬化（权限改写后复核、并发安全复核、有界调度） | 立即做，P0 | 1–2d |
| M2 | 上游 parity 小修 8 项（模型配置、记忆 SQLite、问答历史、子代理判定、输出重试、MCP 错误、网络分类、上下文指引） | 立即做，P1 | 3–4d |
| M3 | 上下文检查器（装配后的 prompt/tools/messages 只读快照） | 下一阶段，P1 | 3–5d |
| M4 | Python 运行时感知（先做系统 Python/venv/不可用三态，不打包） | 下一阶段，P1 | 2–3d |
| M5 | 按技能持久开关 | 下一阶段，P2 | 2–3d |
| — | 全局搜索、系统通知、Web 默认认证/限流、MCP 热更新、每文件租约 | 评估后再说 | — |
| — | 桌面安装器/更新器、主题/表单重构、图片/视频、整体架构重构 | 不引入 | — |

**推荐顺序**：M1 → M2 → M3 → M4 → M5。M1 与 M2 可由不同人并行；M3 与 M4 无依赖，可并行；M5 可与 M3/M4 并行。

**总原则**：先修安全与正确性，再做白盒能力，最后做体验增强。不要在 M1/M2 未收口时开始 M3。

---

## 1. 增量分诊

### 1.1 立即引入（Sati 同一段代码已复现）

| 项 | 上游 | 修什么 | Sati 落点 | 现状 |
|---|---|---|---|---|
| P0-1 | `#737` / `f1ce844b` | 权限回调改写输入后重新校验；并发安全复核；并发调度有上限 | `src/tool/execution/ToolRuntime.ts`、`src/tool/scheduler/ConcurrentToolScheduler.ts` | 权限 `updatedInput` 后不复核；`Promise.all` 无上限 |
| P1-1 | `#675` | 多模态部分覆盖保留 catalog 默认值 | `src/model/config/parseModelConfig.ts` | 未提供字段被显式写成 `undefined` |
| P1-2 | `#644` | 记忆 SQLite `busy_timeout = 5000` | `src/context/memory/edgeclaw-memory-core/src/core/storage/sqlite.ts` | 只有 WAL，无 busy_timeout |
| P1-3 | `#730` / `f103ed66` | 历史回放保留 `ask_user_question` 结构化答案 | `src/web/server/webMessageFlatten.ts` | live 有 `toolUseResult`；历史只保留 plan/search payload |
| P1-4 | `#589` | `missingAgentTool` 不再单独把主代理判成子代理 | `src/router/scenario/subagentDetector.ts` | `isSubagent: ... \|\| missingAgentTool` |
| P1-5 | `#589` | 输出 token 重试只在真正抬升上限时消耗单次额度 | `src/agent/loop/recoveryStrategies.ts` | 先置 `hasAttemptedOutputRetry = true` 再判断 bump |
| P1-6 | `#589` | MCP 启动错误对非 `Error` 抛出也能给出可读消息 | `src/mcp/runtime/McpRuntime.ts` | `(err as Error).message` 可能为 `undefined` |
| P1-7 | `#727` | 网络错误补 `transport_error` / `aborted` 分类与递归归一 | `src/model/errors/normalizeModelError.ts` | 缺这两个分支 |
| P1-8 | `#707` | 紧急压缩仍放不下时给上下文指引 | `src/agent/loop/modelErrors.ts` | `modelError` 为空时退回 provider settings 建议 |

### 1.2 下一阶段引入

| 项 | 上游 | 价值 | Sati 现状 | 判定 |
|---|---|---|---|---|
| P1-9 | `#724` / `e9ef60b7` | 查看模型实际收到的 system prompt / tools / messages / token breakdown | `request_header` 只存 digest；已有上下文预算 popover | 高价值，契合白盒定位 |
| P1-10 | `#736` | 让模型知道 Python 版本、环境与可用库，避免臆造依赖 | `execute_code` 只找 PATH 上的 `python3`，无提示块 | 先做感知，后评估打包 |
| P2-1 | `#734` | 按技能持久开关，过滤不相关技能 | `SkillManager` 有作用域，无 enabled 状态 | 中价值，降低提示词噪音 |

### 1.3 评估后再说

| 项 | 上游 | 触发条件 |
|---|---|---|
| P2-2 | `#709` 全局聊天/文件索引搜索 | Sati 需要统一搜索入口，且愿意承担索引 worker/存储 |
| P2-3 | `#705` 系统通知与注意力标记 | 桌面端需要原生通知，Web Push 已覆盖浏览器 |
| P2-4 | `#723` / `#717` Web 默认认证与限流 | Sati 把公网 Web 部署作为正式场景 |
| P2-5 | `#739` / `9f871222` MCP 工具契约热更新 | 出现真实“长会话中 MCP 工具变更”诉求 |
| P2-6 | `#719` 每文件租约与变更日志 | 复现“同项目并发会话 + 长 turn 锁”导致的真实冲突 |

### 1.4 明确不做

- 桌面安装器、更新器、签名、OBS/发布链（Sati 桌面端已分叉）。
- 主题、表单控件、侧栏视觉重构（Sati 自有设计系统）。
- 图片生成、视频生成（专利附图走确定性 SVG/矢量交付）。
- `#737` / `#739` 的整体运行时与前端重构（Sati 已独立演化；只摘取本文列出的具体修复）。
- General 工作区迁移（Sati 的 workspace 模型不同）。
- 全量 Python 3.12 打包（先完成 M4 感知，再单独评估安装器成本）。

---

## 2. 里程碑总表

| ID | 里程碑 | 优先级 | 依赖 | 估工 | 分支 | 完成标准 |
|---|---|---|---|---|---|---|
| M0 | 基线与判定收口 | P0 | — | 0.5d | `docs/pilotdeck-2026-11-port` | 本计划批准；每项有落点/测试/负控制 |
| M1 | 工具运行时硬化 | P0 | M0 | 1–2d | `fix/tool-runtime-hardening` | 权限改写后复核、并发安全复核、有界调度均绿 |
| M2 | 上游 parity 小修 | P1 | M0 | 3–4d | `fix/pilotdeck-parity-2026-11` | 8 项逐项测试 + 负控制 + `pnpm check` |
| M3 | 上下文检查器 | P1 | M0 | 3–5d | `feat/context-inspector` | 快照/API/UI 全链路 + 隐私收口 + 浏览器验证 |
| M4 | Python 运行时感知 | P1 | M0 | 2–3d | `feat/python-runtime-awareness` | 三态状态 + prompt 块 + `execute_code` 接入 |
| M5 | 按技能持久开关 | P2 | M0 | 2–3d | `feat/skill-switches` | 持久化 + 过滤 + UI 开关 + 测试 |

---

## 3. 任务清单

### M0 — 基线与判定收口

- [x] **T0.1** 确认上次实际引入的上游 SHA。若不是 `96226d8`（v2026.10.20），按 `git tag --sort=-creatordate` 的时间线重算区间，并在本文件更新基线。
  - 核对结果：`git rev-parse v2026.10.20` = `96226d85f8a21e9095427085e431488f3cdaed39`；`v2026.10.20..v2026.11.07` 非 merge 提交 355 个，与计划一致。
- [x] **T0.2** 为每项建立“落点 / 现状 / 上游证据 / 测试 / 负控制”五行记录（可直接用本文件 §1 表）。
- [x] **T0.3** 确认本批不改任何工具 `inputSchema`；若 M3/M5 需要新增 HTTP 参数，记录为“非工具 schema”。
- [x] **T0.4** 确认工作树干净，Node 22（`$HOME/.nvm/versions/node/v22.23.1/bin`），`pnpm install --frozen-lockfile` 可复现。
- [x] **T0.5** 在本计划状态改为 `Approved` 前，不开始 M1 代码。

**验收**：计划批准；基线 SHA 与区间提交数写入本文件；无开放的范围争议。

---

### M1 — 工具运行时硬化（P0）

**目标**：权限/钩子改写输入后，执行前仍满足 schema、plan/ask 约束与并发安全；并发调度有上限。

**非目标**：不改变权限规则的匹配语义；不改变工具注册表 API；不新增工具。

**任务**

- [x] **T1.1** 在 `src/tool/execution/ToolRuntime.ts` 抽出 `checkInput(tool, input, toolCallId, startedAt, context, invalidPrefix?)`：
  - 检查 `abortSignal`；
  - 检查 plan mode 违规；
  - 检查 ask mode 违规；
  - 检查 `validateToolInput`；
  - 检查 `canPrompt === false` 时的 prompt-capability；
  - 返回结构化错误结果。
- [x] **T1.2** 在 PreToolUse 的 `updated_tool_input` 后调用 `checkInput`，替换现有的一次性 `validateToolInput`。
- [x] **T1.3** 在权限判定返回 `updatedInput` 后调用 `checkInput`；若权限回调改写了输入，再跑一次 `tool.validateInput` 与 planTodo 门。
- [x] **T1.4** 在权限/审计钩子之后、真正执行之前再检查一次 `abortSignal`。
- [x] **T1.5** 给 `ToolRuntime.execute` 增加 `options.requireConcurrencySafe?: boolean`；执行前复核 `tool.isConcurrencySafe(executeInput)`，输入在准备阶段从安全变为独占时拒绝并提示“单独重试”。
- [x] **T1.6** 改造 `src/tool/scheduler/ConcurrentToolScheduler.ts`：
  - 增加 `maxConcurrency`（默认 4）；
  - 用有界 worker 池执行并发安全调用，结果仍按原始调用顺序回填；
  - 非并发安全调用继续串行；
  - 调度时把 `requireConcurrencySafe: true` 传给 runtime。
- [x] **T1.7** 新增/扩展测试：
  - `tests/tool/execution/tool-runtime-input-revalidation.spec.ts`：权限 `updatedInput` 返回非法 schema / 越权路径 / plan-mode 写操作，必须拒绝；
  - `tests/tool/execution/tool-runtime-input-revalidation.spec.ts`：合法 `updatedInput` 仍可执行（防误杀）；
  - `tests/tool/scheduler/concurrent-scheduler.spec.ts`：并发上限、结果顺序、输入从安全变独占时拒绝；
  - 既有 `tests/tool/execution/always-ask-hook-allow.spec.ts` 与 `tests/tool/execution/validateToolInput.spec.ts` 保持绿。
- [x] **T1.8** 负控制：
  - 退回“权限改写后不复核” → 新增拒绝用例至少 2 条转红；
  - 退回无上限 `Promise.all` → 并发上限用例转红；
  - 恢复后全绿。
- [x] **T1.9** 写 `docs/notes/implemented/2026-11-XX-tool-runtime-input-revalidation.md`，含 `## Alternatives considered`（例如“只在权限 hook 内校验”“只改调度器”为何不够）。

**验收**：`pnpm check` 绿；工具/权限面定向测试绿；全量 `pnpm test` 绿；负控制记录写入 note。

**完成情况（2026-11-07）**：分支 `fix/tool-runtime-hardening`；决策记录 `docs/notes/implemented/2026-11-07-tool-runtime-input-revalidation.md`；负控制：移除权限改写复核 → 5 条转红，改为无界调度 → 2 条转红，恢复后 13 条全绿。

---

### M2 — 上游 parity 小修（P1）

**目标**：把 8 项已在 Sati 复现的低风险缺陷逐项修掉。建议一个 PR，8 个独立提交；每项一个测试。

**非目标**：不改变工具 `inputSchema`；不引入新依赖；不重构模型/会话架构。

#### M2.1 多模态默认值

- [x] **T2.1.1** 改 `src/model/config/parseModelConfig.ts` 的 `parseMultimodal`：先收集 `overrides`，只覆盖用户显式给出的字段，再 `return { ...defaults, input, ...overrides }`。
- [x] **T2.1.2** 扩 `tests/model/config/parseModelConfig.spec.ts`：catalog 提供 `maxImagesPerRequest` / `maxPdfPages` / `imageDetail`，用户只给 `input`，断言默认值保留。
- [x] **T2.1.3** 负控制：退回“展开后显式赋 undefined” → 至少 1 条转红。

#### M2.2 记忆 SQLite busy_timeout

- [x] **T2.2.1** 在 `src/context/memory/edgeclaw-memory-core/src/core/storage/sqlite.ts` 的 `init()` 首行加 `PRAGMA busy_timeout = 5000;`。
- [x] **T2.2.2** 运行 `pnpm --filter edgeclaw-memory-core build` 重新生成 `lib`。
- [x] **T2.2.3** 在 `src/context/memory/edgeclaw-memory-core/tests/` 增加或扩展并发写用例：两个连接同时写，第二个等待而非立即 `SQLITE_BUSY`。
- [x] **T2.2.4** 负控制：移除 pragma → 并发用例转红。

#### M2.3 结构化问答历史

- [x] **T2.3.1** 在 `src/web/server/webMessageFlatten.ts` 增加 `ask_user_question` / `AskUserQuestion` 的 presentation data 读取（`toolName` + `data`），并入 `tool_result` 的 `payload`。
- [x] **T2.3.2** 扩 `tests/web/`：构造带 `data.questions` / `data.answers` 的 tool_result，断言历史回放的 `payload` 与 live 路径一致。
- [x] **T2.3.3** 负控制：移除问答题分支 → 历史用例转红。

#### M2.4 子代理判定

- [x] **T2.4.1** 改 `src/router/scenario/subagentDetector.ts`：`isSubagent = !isMainAgent || taggedInUserMessage`，`missingAgentTool` 仅作为诊断字段返回。
- [x] **T2.4.2** 扩 `tests/router/scenario/subagentDetector.spec.ts`：主代理工具集缺少 `agent/task` 时仍为 `isSubagent: false`；显式 tag 仍为 true。
- [x] **T2.4.3** 负控制：恢复 `|| missingAgentTool` → 用例转红。

#### M2.5 输出 token 重试额度

- [x] **T2.5.1** 改 `src/agent/loop/recoveryStrategies.ts`：把 `state.hasAttemptedOutputRetry = true` 移入 `if (nextMaxOutputTokens !== undefined)`。
- [x] **T2.5.2** 扩 `tests/agent/loop/recoveryStrategies.spec.ts`：无 bump 空间时不消耗额度，后续有空间时仍可抬升；Phase B 仍执行。
- [x] **T2.5.3** 负控制：恢复旧置位 → 用例转红。

#### M2.6 MCP 错误消息

- [x] **T2.6.1** 改 `src/mcp/runtime/McpRuntime.ts`：`err instanceof McpClientError ? err.message : err instanceof Error ? err.message : String(err)`。
- [x] **T2.6.2** 扩 `tests/mcp/runtime/McpRuntime.spec.ts`：`throw "boom"`、`throw null` 时状态条目有可读消息。
- [x] **T2.6.3** 负控制：恢复 `(err as Error).message` → 用例转红。

#### M2.7 网络错误分类

- [x] **T2.7.1** 改 `src/model/errors/normalizeModelError.ts`：为 `NetworkFetchError` 增加 `network_fetch_failed → transport_error`、`network_abort → aborted`；对 `Error` 先 `normalizeNetworkError` 再递归分类；`isRetryable` 加入 `transport_error`。
- [x] **T2.7.2** 扩 `tests/model/errors/`：ENOTFOUND/代理/超时/取消/普通 fetch 失败分别落到预期 code；取消不重试，传输错误可重试。
- [x] **T2.7.3** 负控制：移除新分支 → 至少 2 条转红。

#### M2.8 上下文溢出指引

- [x] **T2.8.1** 改 `src/agent/loop/modelErrors.ts`：`createModelRequestFailedStatus` 在没有 `modelError` 且 `error.code === "agent_context_recovery_failed"` 时使用上下文溢出 action；`formatModelRequestFailureMessage` 允许传入 action。
- [x] **T2.8.2** 扩 `tests/agent/loop/`：紧急压缩仍放不下时，状态文案/`userHint` 指向 `/compact` / 新会话 / 换大窗口，而不是 provider settings。
- [x] **T2.8.3** 负控制：恢复旧分支 → 用例转红。

**M2 验收**：8 项测试与负控制齐备；`pnpm check` 绿；全量 `pnpm test` 绿；生成物无意外变化。

**完成情况（2026-11-07）**：分支 `fix/pilotdeck-parity-2026-11`，8 个独立提交（`e939f857`…`85fc611c`）；决策记录 `docs/notes/implemented/2026-11-07-pilotdeck-parity-fixes.md`；每项负控制均转红后恢复全绿。

---

### M3 — 上下文检查器（P1）

**目标**：在每次模型请求装配后，保存一份只读的上下文快照，让用户能看到模型实际收到的 system prompt、tool schemas、messages 与 token breakdown。

**非目标**：不编辑、不排除、不压缩消息；不改变模型请求；不把快照广播到流式连接；不新增工具。

**任务**

- [ ] **T3.1** 新增 `src/session/context/ModelContextSnapshot.ts`：
  - 类型：`version: 1`、`turnId`、`capturedAt`、`provider`、`model`、`systemPrompt`、`tools`、`messages`、`breakdown?`、`mediaOmitted`；
  - `createModelContextSnapshot(request, turnId, breakdown?)`：深拷贝；二进制媒体替换为 `[binary payload omitted]`；剥离 `raw`；
  - `writeModelContextSnapshot(transcriptPath, snapshot)`：写 `<transcript>.context.json`，`mode 0o600`，临时文件 + rename；
  - `readModelContextSnapshot(transcriptPath, snapshotRoot)`：解析根路径、拒绝越界与符号链接逃逸、校验 `version`/`turnId` 形状；缺失/坏 JSON 返回 `null`。
- [ ] **T3.2** 在 `src/agent/protocol/input.ts` 增加 `onModelContext?: (snapshot) => void | Promise<void>`；在 `src/agent/loop/AgentLoop.ts` 的请求装配完成点调用（与 `onRequestHeader` 并列）。
- [ ] **T3.3** 在 `src/agent/turn/TurnRunner.ts` 用 `transcriptPath` 写 sidecar；无 `transcriptPath` 时 no-op。
- [ ] **T3.4** 在 `src/web/server/readSessionMessages.ts` 增加 `includeModelContext?: boolean`；仅在 true 时读取 sidecar，正常历史读取零额外 I/O；快照 `turnId` 必须匹配最近一次 accepted input。
- [ ] **T3.5** 在 `ui/server/routes/messages.js` 透传 `includeModelContext=true|summary`；`summary` 只返回 `breakdown`，`true` 返回完整快照。
- [ ] **T3.6** 前端：
  - 在 `ui/src/components/chat-v2/ContextStatusPopover.tsx` 增加“Inspect context”入口；
  - 新增 `ui/src/components/chat-context/ContextInspector.tsx`：可搜索分区（System prompt / Tools / Messages），展示 token breakdown 与媒体占位；
  - 懒加载，只在打开时请求；空状态说明“下一次模型请求后可用”；
  - i18n 文案入 `ui/src/i18n/locales/{en,zh-CN}/chat.json`。
- [ ] **T3.7** 会话删除时删除 sidecar；`forkSession`/`editLastTurn` 不复制过期快照。
- [ ] **T3.8** 测试：
  - `tests/session/context/model-context-snapshot.spec.ts`：媒体脱敏、raw 剥离、原子写、路径越界/符号链接拒绝、坏 JSON；
  - `tests/web/read-session-messages-context.spec.ts`：`includeModelContext` 开关、stale turn 拒绝；
  - `ui/src/components/chat-context/ContextInspector.test.tsx`：分区、搜索、空状态、懒加载；
  - `ui/src/components/chat-v2/ContextStatusPopover.test.tsx`：入口与键盘关闭。
- [ ] **T3.9** 负控制：
  - 移除路径收口 → 越界用例转红；
  - 移除媒体脱敏 → 脱敏用例转红；
  - 移除 stale turn 校验 → 历史用例转红。
- [ ] **T3.10** 浏览器验证：打开已有会话 → 触发一次模型请求 → 打开 context popover → Inspect → 搜索 system/tools/messages → 刷新后重开；检查中英文、明暗主题、窄屏。
- [ ] **T3.11** 写 `docs/notes/implemented/2026-11-XX-context-inspector.md`，含隐私边界与 `## Alternatives considered`（例如“直接写进 transcript”“默认开启”为何不选）。

**验收**：快照只在本地、按需读取、路径收口、媒体脱敏；UI 浏览器验证通过；`pnpm check` + 全量测试绿；无网关协议变更（走 HTTP 查询参数）。

---

### M4 — Python 运行时感知（P1，先不打包）

**目标**：让模型知道当前执行环境的 Python 状态与可用能力，避免臆造库；`execute_code` 使用解析后的解释器。

**非目标**：不打包 Python 3.12；不改桌面安装器；不新增 Python 库依赖。

**任务**

- [ ] **T4.1** 新增 `src/runtime/pythonRuntime.ts`：
  - `PythonRuntimeStatus`：`enabled`、`state: "disabled" | "ready" | "unavailable" | "external"`、`reason`、`version`、`executable`、`environment`、`packages?`；
  - 解析顺序：显式配置 → 激活的 `VIRTUAL_ENV` → PATH 上的 `python3`/`python` → `unavailable`；
  - 只读探测 `python --version` 与少量预装包（可选，失败不阻断）；
  - 不修改 `process.env`。
- [ ] **T4.2** 配置：在 `src/pilot/config/types.ts` 增加 `runtime.python`（enabled/path，可选），`loadPilotConfig` 解析；默认 enabled，行为与今天一致。
- [ ] **T4.3** 提示词：在 `src/context/prompt/PromptAssembler.ts` 注入 `<python-runtime>` 块，按状态给出可执行建议；`unavailable` 时明确“先检查项目/系统解释器，不要声称已安装库”。
- [ ] **T4.4** `src/tool/builtin/executeCode.ts`：用解析后的解释器与 env；保留 PATH 回退；错误消息说明来源。
- [ ] **T4.5** 测试：
  - `tests/runtime/python-runtime.spec.ts`：三态 + 外部 venv 优先 + 探测失败降级；
  - `tests/context/python-awareness.spec.ts`：各状态的 prompt 块；
  - `tests/tool/builtin/execute-code-python.spec.ts`：配置路径生效、PATH 回退。
- [ ] **T4.6** 负控制：移除 venv 优先 → 用例转红；移除 `<python-runtime>` → prompt 用例转红。
- [ ] **T4.7** 写 `docs/notes/implemented/2026-11-XX-python-runtime-awareness.md`，含 `## Alternatives considered`（全量打包 vs 系统解释器）。

**验收**：三态可观测；模型不再臆造库；不改变桌面打包；`pnpm check` + 全量测试绿。

**后续（不在本批）**：若确认需要固定 Python 3.12 + 精选库，单独立项评估安装器体积、签名、跨平台构建。

---

### M5 — 按技能持久开关（P2）

**目标**：用户可以持久禁用某个技能；运行时加载与 prompt 过滤都尊重该开关。

**非目标**：不改变技能文件格式；不改变 `SKILL.md` 校验；不新增工具。

**任务**

- [ ] **T5.1** 新增 `src/extension/skills/skillPreferences.ts`：
  - 存储 `skillPreferences.json`（pilotHome），按 scope（builtin/user/project）+ slug + projectKey 记录 enabled；
  - 原子写；坏文件 fail-open（默认启用）。
- [ ] **T5.2** `src/extension/skills/SkillManager.ts`：
  - `SkillSummary` 增加 `enabled`；
  - `list`/`search` 过滤 disabled；
  - 新增 `setEnabled({ scope, slug, projectKey?, enabled })`；
  - 默认 enabled，避免升级后技能消失。
- [ ] **T5.3** `src/context/extension/ExtensionResolver.ts` 与 prompt 组装：过滤 disabled 技能；`available-skills` 分组计数同步。
- [ ] **T5.4** UI：`ui/server/routes/skills.js` 增加开关端点；技能页增加开关；i18n 文案。
- [ ] **T5.5** 测试：
  - `tests/extension/skills/skill-enablement.spec.ts`：持久化、scope 覆盖、默认启用、坏文件 fail-open；
  - 新增 `ui/server/routes/skills.addressing.test.js`：开关端点；
  - 新增 `ui/src/components/main-content-v2/SkillsV2.test.tsx`：开关交互与刷新。
- [ ] **T5.6** 负控制：移除过滤 → 技能仍出现在 prompt/搜索；恢复后转绿。
- [ ] **T5.7** 写 `docs/notes/implemented/2026-11-XX-skill-switches.md`，含 `## Alternatives considered`。

**验收**：禁用后技能不再进入 prompt/搜索/`/` 菜单；重启后保持；默认开启；`pnpm check` + 测试绿。

---

## 4. 检查清单

### 4.1 开工前（每个里程碑）

- [ ] 基线 SHA 与本计划一致；若上游已前进，先记录新 tag，不自动扩范围。
- [ ] 从最新 `main` 拉分支，分支名符合计划。
- [ ] Node 22、`pnpm install --frozen-lockfile` 成功。
- [ ] 先在 Sati 代码里找到落点，确认上游 diff 与 Sati 现状同构；不同构则先写判定，不直接搬。
- [ ] 明确本项是否触碰 `inputSchema`、`AgentEvent`/gateway frames、网关协议、i18n、UI。
- [ ] 为本项写至少一条“负控制”用例设计。

### 4.2 每项任务完成

- [ ] 代码改动最小，未顺手重构无关代码。
- [ ] 新代码无 `any`、无 `@ts-ignore`、无无注释 `catch {}`。
- [ ] 关键不变量有注释，说明“为什么”而非“做了什么”。
- [ ] 测试覆盖主路径 + 至少一个边界/降级路径。
- [ ] 负控制已执行：退回旧行为 → 新用例转红；恢复 → 全绿。
- [ ] 若改动核心模块（`agent/`、`router/`、`tool/`、`session/`），附对应 spec。
- [ ] 若改动 manifest/协议/事件/生成物，跑对应生成器。

### 4.3 每个 PR 提交前

- [ ] `pnpm check` 绿（lint、typecheck、format、事件矩阵、doc-claims、专利工作流文档、技术债基线）。
- [ ] 受影响套件定向测试绿。
- [ ] 全量 `pnpm test` 绿（核心模块改动必须）。
- [ ] `pnpm format:check` 绿。
- [ ] 无新增未跟踪 `*.test.ts`；如新增，`git add -f` 并同步 `pnpm measure:update`。
- [ ] 生成物已提交：`docs/code-facts.md`、`docs/technical-debt/metrics.md`（如涉及）。
- [ ] 事件面改动：`pnpm gen:event-matrix` + `pnpm check:event-matrix`。
- [ ] 网关协议改动：`pnpm check:protocol-version`，按 MINOR/MAJOR 版本化。
- [ ] 工具 `inputSchema` 改动：单独评估 llm-replay 重录；本计划默认不改。
- [ ] 非平凡变更附 `docs/notes/implemented/` 决策记录，含 `## Alternatives considered`。
- [ ] PR 描述写清：改了什么、为什么、怎么验证、风险/回滚。
- [ ] PR 关联 issue（`Closes #N` 或 `关联 Issue: #N`），否则 `PR 关联 Issue 门禁` 会红。

### 4.4 安全/隐私专项（M1、M3）

- [ ] 权限改写后的输入重新过 schema、plan/ask、prompt capability。
- [ ] 并发安全在输入变化后复核；调度有上限。
- [ ] 快照文件 `0600`，目录 `0700`；读取拒绝越界与符号链接逃逸。
- [ ] 二进制媒体/密钥/凭据不进入快照；`raw` 字段剥离。
- [ ] 快照不广播到流式连接；只在 `includeModelContext` 时读取。
- [ ] 会话删除时删除快照；fork/rewrite 不复制过期快照。

### 4.5 UI 专项（M3、M5）

- [ ] 新文案进入 `ui/src/i18n/locales/{en,zh-CN}/`。
- [ ] 中英文、明暗主题、窄屏均验证。
- [ ] 键盘可达（Esc 关闭、焦点返回）。
- [ ] 空状态/加载态/错误态可区分，不把“未加载”显示成“空”。
- [ ] 浏览器实测主路径 + 刷新后重开 + 相关路由。

### 4.6 发布前

- [ ] 所有里程碑 PR 合并到 `main`，CI 全绿。
- [ ] `pnpm check` + 全量 `pnpm test` 在 `main` 上复跑。
- [ ] 回滚点明确：每个 PR 可独立 revert；M1 的权限复核不依赖后续里程碑。
- [ ] 更新 `CHANGELOG.md`（若本批进入版本发布）。
- [ ] 计划状态改为 `Implemented`，并在 `docs/notes/implemented/` 留结论。

---

## 5. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| M1 权限复核误杀合法 hook 改写 | 插件/宿主无法改写输入 | 先加“合法 updatedInput 仍可执行”用例；错误消息指明具体字段；保留逐项可 revert |
| M1 并发上限降低吞吐 | 大批量工具调用变慢 | 默认 4 可配置；先测真实批量场景；结果顺序断言 |
| M2 子代理判定改变路由 | 少数主代理不再走子代理预算 | 用例覆盖“无 agent 工具的主代理”；观察路由日志 |
| M3 快照泄露 system prompt | 隐私/合规 | 本地只读、`0600`、按需读取、媒体脱敏、路径收口；默认不广播 |
| M3 历史读取变慢 | 会话打开变慢 | 仅 `includeModelContext` 时读；正常路径零 I/O；快照 sidecar 原子写 |
| M4 Python 探测拖慢启动 | 启动变慢 | 探测有超时、失败降级、结果缓存；不阻塞首轮 |
| M5 升级后技能被意外禁用 | 用户找不到技能 | 默认 enabled；坏偏好文件 fail-open；UI 显示开关状态 |

**回滚**：每个里程碑一个 PR，独立 revert；M1 不依赖 M2/M3；M3 的 sidecar 可整体删除且不影响 transcript；M4 的 prompt 块可按配置关闭；M5 删除偏好文件即恢复默认。

---

## 6. 开放问题（需批准前确认）

1. 上次实际引入的上游 SHA 是否确为 `96226d8`（v2026.10.20）？若不是，按 tag 时间线重算。
2. M3 上下文快照是否默认开启？建议默认关闭，设置页显式开启；本地桌面可默认开启。
3. M4 是否需要在桌面端固定 Python 3.12？本计划只做感知，打包另立计划。
4. M5 技能开关是否需要按项目覆盖？建议支持 scope + projectKey，默认全局。
5. Web 部署是否作为正式场景？决定是否启动 P2-4（默认认证/限流）。
6. 全局搜索是否与知识库 FTS 合并，还是独立会话/文件索引？决定 P2-2 的架构。

---

## 7. 验证口径

- 每项：定向测试 + 受影响的邻近套件 + `pnpm check`。
- 核心执行链（M1、M3）：全量 `pnpm test`。
- 负控制：临时退回旧行为，确认新增用例转红，再恢复；记录在 PR 描述。
- 生成物：`pnpm gen:doc-claims`、`pnpm measure:update`；事件面 `pnpm gen:event-matrix`。
- UI：Vitest + 浏览器实测；中英文、明暗主题、窄屏。
- 不访问网络的测试用 mock/fixture；真实模型回路走 llm-replay seam。

---

## 8. 一页看板

```
Now
  M1 工具运行时硬化            [ ] 权限改写复核
                              [ ] 并发安全复核
                              [ ] 有界调度
                              [ ] 测试 + 负控制
  M2 上游 parity 小修          [ ] 8 项逐项
Next
  M3 上下文检查器              [ ] 快照/API/UI
  M4 Python 运行时感知         [ ] 三态 + prompt
  M5 按技能持久开关            [ ] 持久化 + UI
Later（需触发条件）
  全局搜索 / 系统通知 / Web 认证限流 / MCP 热更新 / 每文件租约
不做
  桌面安装器/更新器、主题/表单重构、图片/视频、整体架构重构、General 工作区迁移
```
