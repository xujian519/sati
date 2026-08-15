# deepseek-harness 优秀设计引入计划 —— 阶段四实施文档

- 创建日期：2026-08-16
- 状态：**✅ 全部已实施（2026-08-16）**——迭代一（T1/T2/T9/T10）与迭代二（T3–T8）均落地并验证（见 §8 实施结果）
- 范围：阶段四（测试可验证性 + 请求可重建 + 模态门禁 + durable 边界 + 工具卫生），2 个迭代，约 19–27.5 个开发日
- 前置：阶段一（✅ 已实施）、阶段二（✅ 主体已实施）；不依赖阶段三（#6/#7/#9/#10/#11 未落地）
- 上游调研：`deepseek-harness` 第二轮深挖（2026-08-16，5 路并行子代理 + 顶层文档精读），覆盖 core loop / 插件架构 / 工具执行 / 数据与测试 / LLM 抽象层

---

## 1. 背景

阶段一/二已把 dsh 最显眼的设计（「模型可见 = 已记录」、遮蔽式压缩、单调 guard、双轨存储、凭证引用/值分离）落地为 Sati 变体。第二轮深挖确认：dsh 的深层优势是**「单一事实源 + 可验证性内置」的工程纪律**——事件日志是唯一权威，测试重放日志、文档从源码生成、不变式在运行时断言。Sati 已吸收"数据侧"，本阶段承接计划外的增量，编号 #13–#22：

| 编号 | 设计（dsh 依据） | 阶段四任务 |
|---|---|---|
| #13 | LLM 重放测试：真实录 session JSONL → 无 key 重放完整 agent 回路（`packages/test-support/llm-replay/`） | T1 |
| #14 | request/header 全量快照事件 + latest-wins fold + 独立重建 invariant 对拍器（`packages/llm/llm/README.md`、`packages/core/agent-loop/src/invariant.ts`） | T2 |
| #15 | 精确能力解析 resolveModelInfo + 请求时模态门禁（`packages/llm/llm/src/index.ts:619`、`packages/llm/llm-pi-ai/src/adapter.ts:246`） | T3 |
| #16 | durable 边界检查点：前缀落盘后才分发、副作用前 checkpoint、重试只在 durable 边界（`packages/session/session-checkpoint-policy`、`packages/llm/llm-retry`） | T4 |
| #17 | read-before-write/edit 观测策略：三态 + 版本 CAS（`packages/fs/fs-observation-policy/`） | T5 |
| #18 | 工具卫生：per-tool 超时强制 + 防死循环提醒（`packages/guard/timeout-policy/`、`packages/guard/repeat-tool-reminder/`） | T6 |
| #19 | 配置分层解析 + last-good-facts 回退（`packages/settings/settings/`、`packages/llm/llm-deepseek/src/index.ts:203`） | T7 |
| #20 | 事件生产者/消费者矩阵自动生成 + `--check` 门禁（`scripts/gen-doc-graphs.ts`） | T8 |
| #21 | 工具 canonical output schema 强制校验 + 纯 render 投影（`docs/subsystems/tools.md`） | T9 |
| #22 | 凭证双错误码：MISSING_CREDENTIAL / INVALID_CREDENTIAL（`packages/credentials/`、`packages/llm/llm/src/index.ts:assertUsableApiKey`） | T10 |

**不入本文件的治理约定**（零代码成本，另以 CLAUDE.md 更新 PR 落地）：seam 三角色完整性、可逆注册（disposer + dispose 测试）、无硬编码 tunable、defensive-patterns + postmortem 制度、「消费者不得决定契约」。本文件只收需要改代码的工程项。

---

## 2. 调研结论（已核实，2026-08-16）

### 2.1 测试现状（T1 依据）

- 后端测试镜像 `src/` 结构，`tests/agent/loop/` 12 个 spec 均为模块级单测，手工构造输入（如 `tests/agent/loop/subagentExecutor.spec.ts` 手工拼 `AgentLoopInput`/`SatiToolResult`），**无任何"真实模型记录→重放"基础设施**；
- 模型相关测试仅 `tests/model/` 少量单元级（embedding rerank/client），agent 回路级行为无回归基线；
- dsh 对应物：`packages/test-support/llm-replay/`（session JSONL → 按 (turn,step) 重构 `assistant/chunk` 流；sidecar 补 throw/hang；`assertConsumed` 防少驱动）。

### 2.2 请求组装与持久化现状（T2/T4 依据）

- 请求组装：`src/context/DefaultContextRuntime.ts:155` `prepareForModel` → `src/model/ModelRuntime.ts:15` `stream(request)`；组装产物无快照事件落 transcript；
- transcript 事件类型（`src/session/transcript/TranscriptEntry.ts:6`）：`accepted_input` / `assistant_message` / `tool_result_message` / `durable_message` / `agent_status_message` / `turn_result` / `file_artifacts` / `control_boundary`——**无 request/header 快照类型**；
- 流式重试：`src/model/streaming/StreamingCheckpoint.ts` 仅跟踪 partialText/tokens/hasToolCalls（用于"续传 vs 从头"决策），不是 durable 边界检查点；无"请求前缀落盘后才分发 adapter / 工具副作用前 checkpoint"的语义；
- Sati 无 invariant 注册表（dsh：`packages/runtime-diagnostics/invariants/`，每包 `./invariant` 伴生注册、失败带包名归属）。

### 2.3 模态与能力现状（T3 依据）

- `src/model/protocol/multimodal.ts`：`MultimodalConstraints.input: InputModality[]`（text/image/pdf/audio），`DEFAULT_MULTIMODAL_CONSTRAINTS.input = ["text"]`；`downgradeUnsupportedContent` 是**事后降级**（替换为文本占位符），无**前置门禁**；
- `src/model/protocol/capabilities.ts`：`ModelCapabilities`（supportsToolUse/supportsPromptCache/maxContextTokens 等 9 项）+ `mergeCapabilities`；`src/model/catalog/lookup.ts`：`lookupCatalogModel` 返回 entry + matchType（exact/alias/cross-provider/none），**无"按当前路由解析最终能力"的统一查询入口**；
- `src/model/catalog/types.ts` 无 vision/image 字段——图片能力对 UI 准入与 `analyze_patent_figure` 均不可查询；
- dsh 代价记录（采纳入风险清单）：过度声明 → provider 中途拒且图片已持久化、会话反复重放失败请求；欠声明 → 提前拒（代价小）。

### 2.4 文件观测与工具卫生现状（T5/T6 依据）

- `src/tool/builtin/editFile.ts` 已有**雏形观测语义**：提示语要求"必须先 read_file 再 edit"，归一化错误匹配 `File has not been read yet.` / `File has changed since the last read.`（`:111-112`）——但无系统化三态（present/absent/unseen）观测注册表、无 provider 级版本 CAS（`FS_STALE_VERSION` 语义）；
- `src/tool/protocol/types.ts:62` 已声明 `timeoutMs?`，8 个内置工具（bash/webSearch/agent/egoBrowser/patentPdfDownload 等）已设置；`src/tool/execution/errorRecovery.ts` 已映射 `tool_timeout` 错误码——但**registry/scheduler 层无统一强制**（无"exec.signal 熔合 deadline"策略）；
- `src/agent/loop/doomLoop.ts` + `doomLoopIntegration.ts` 已有死循环断路器（硬打断），缺 dsh 的**软提醒**：按 (tool, canonical args) 连续重复计数、denied 也计数、经 additionalContexts 注入 advisory 提醒。

### 2.5 配置与事件现状（T7/T8 依据）

- `src/pilot/config/PilotConfigStore.ts` 已有 watch + reload，且注释明确 `Reload diagnostics are retained on the store; watchers must not crash the runtime`（`:113-114`）——**部分 last-good 已存在**；缺：显式"坏快照保留上一好配置继续服务"语义验证、写入 revision 栅栏、schema 默认→base→user 三层解析的显式化（`merge.ts` 已有多源合并基础）；
- 事件面：`src/agent/protocol/events.ts`（AgentEvent）、`src/gateway/protocol/frames.ts`（WS 帧）、transcript 条目类型、`src/telemetry/`（analytics.v2）四套事件语汇，**无生产者/消费者矩阵**、无生成校验；
- dsh 对应物：`scripts/gen-doc-graphs.ts` 从 TS Program 解析事件声明与 emit/listen 边，按 emit/waterfall/serial/parallel 生成矩阵并 `--check`。

### 2.6 工具输出与凭证现状（T9/T10 依据）

- `src/tool/protocol/types.ts:434` 已有 `outputSchema?: Record<string, unknown>`（可选字段），`domain` 业务语义维已存在——**canonical schema 强制校验与纯 render 投影缺位**；
- 凭证：阶段一已落地引用/值分离（`ProviderConfig.apiKeyRaw`/`apiKeySource`，`src/model/config/resolveCredentials.ts`）；缺 `MISSING_CREDENTIAL`（未提供，可修复）与 `INVALID_CREDENTIAL`（格式非法，重试无意义）的**稳定双码区分**（dsh：`packages/llm/llm/src/index.ts:assertUsableApiKey`）。

---

## 3. 迭代一（测试与请求可验证性）

### 3.1 任务 T1：LLM 重放测试基础设施（对应 #13，3–5 人日）

**目标**：真实跑一次录成 session JSONL，测试时按 (turn, step) 把 `assistant_chunk` 级记录重构为模型流，**无 API key 走完整 agent 回路**；支持故障注入（throw/hang sidecar）；`assertConsumed` 防"少驱动了调用"。

**改动文件与实现要点**：

| 文件 | 改动 |
|---|---|
| `src/test-support/llm-replay/`（新目录） | `record.ts`：跑真实模型时旁路记录 (sessionId, turn, step) → 模型流 chunk 序列到 JSONL；`replay.ts`：实现 `ModelRuntime` 接口（`stream` 按 (turn,step) 重放 chunk，无记录时抛 `NO_REPLAY_RECORD`）；`sidecar.ts`：`replay.override.json` 支持 per-turn throw/hang 注入；`assertConsumed.ts`：测试结束断言每条记录至少被驱动一次 |
| `src/model/ModelRuntime.ts` 或新注册点 | 重放 runtime 与真实 runtime 同一接口，经环境变量/测试注入切换（如 `SATI_LLM_REPLAY_ROOT` 指向录制目录时自动挂载） |
| `tests/agent/loop/` 新增 1 个回路级 spec | 用一段真实专利场景录制（检索→读文件→编辑），断言：重放结果与录制时一致、注入 hang 后超时路径、未消费记录报错 |
| `scripts/record-llm-replay.ts`（新） | CLI：`pnpm record:replay --session <id> --out tests/fixtures/llm-replay/` |

**关键决策**：
- 录制产物进 git（`tests/fixtures/llm-replay/`），CI 只读重放——对应 dsh"verify the world, not the self-report"；
- chunk 含 thinking 时，重放同样回放 reasoning chunk，保证回路时序一致；
- 图片类消息（`analyze_patent_figure`）第一期不在录制范围（依赖 T3 门禁语义稳定后再扩）。

**验收标准**：
- 一条真实录制的专利场景 fixture 在无 key 环境下全绿重放；
- sidecar hang 注入用例通过（走现有 `tool_timeout`/流超时路径）；
- `assertConsumed` 对"测试少驱动一条记录"报错。

### 3.2 任务 T2：request/header 快照 + 重建 invariant 对拍器（对应 #14，2–3 人日）

**目标**：每次 LLM 请求的完整信封（provider/model/maxTokens/effort/system/tools/预算决策）以 log-only 快照事件落 transcript（latest-wins fold）；配套独立重建的对拍器在 `ModelRuntime.stream` 出口逐字段比对——**违规请求接口级不可构造**，resume/审计等价，前缀缓存稳定是涌现结果。

**改动文件与实现要点**：

| 文件 | 改动 |
|---|---|
| `src/session/transcript/TranscriptEntry.ts` | 新增 `type: "request_header"` 条目（log-only，不入模型可见投影）：`{ config, systemPromptDigest, toolSchemaDigest, budgetDecision }` |
| `src/agent/loop/AgentLoop.ts`（或拆解后的 request 组装模块） | `prepareForModel` 产物发送前，把解析后的请求头写 `request_header` 条目（复用已有 `persistDurableMessage` 路径，但标记 log-only） |
| `src/agent/loop/requestInvariant.ts`（新） | 对拍器：用全新 `Session` 从 transcript 独立重建"应为的请求"，与 `ModelRuntime.stream` 收到的实参逐字段比对；不一致抛 `RequestReconstructionInvariantError`（带包名/字段名），测试环境必开、生产可配置开关 |
| `src/session/transcript/TranscriptReplay.ts` | 投影时跳过 log-only 条目（保证模型视图不变） |
| `tests/agent/loop/request-invariant.spec.ts`（新） | 正常回路对拍通过；人为改 maxTokens 后对拍失败；log-only 条目不进入模型可见投影 |

**关键决策**：
- 快照只记**决策**不记**正文**（system/tools 记 digest，不记全量），避免 dsh 记录的"每 step 全量快照膨胀日志"成本；
- 对拍器复用 T1 的重放 runtime 即可在测试中全自动运行。

**验收标准**：
- 新 fixture 跑回路时 `request_header` 条目落 transcript；
- 对拍器在正常回路零误报、在篡改场景必报；
- `replayTranscriptEntries` 行为不变（回归测试全绿）。

### 3.3 任务 T10：凭证双错误码（对应 #22，0.5–1 人日）

**目标**：区分"没提供凭证"（可修复）与"凭证格式非法"（重试无意义），稳定 code 路由到不同提示与重试策略。

**改动**：
- `src/model/config/resolveCredentials.ts`：未解析到任何源 → `MISSING_CREDENTIAL`（附所有配置入口名）；已解析但格式非法（无法进 HTTP header）→ `INVALID_CREDENTIAL`（不附任何 key 片段）；
- `src/model/errors/`：两码入错误码表；`src/agent/loop/modelErrors.ts` 分流：MISSING → 引导配置提示（可恢复），INVALID → 不自动重试。

**验收标准**：单测 6 用例（无 env 无配置 / env 空串 / 非法格式 / 正常 / redact 不泄漏 / 重试行为差异）。

### 3.4 任务 T9：工具 canonical output schema 强制校验（对应 #21，2–3 人日）

**目标**：工具输出契约从"可选声明"升级为"强制校验 + 纯投影"——`execute` 返回的 canonical JSON 值必须过 `outputSchema` 校验，模型可见内容由纯函数 `render` 投影（重放安全），UI 呈现走独立 `present*` 投影。

**改动**：
- `src/tool/protocol/types.ts`：`outputSchema` 由可选转**新工具强制**（旧工具分两批补声明，见任务清单）；新增 `render?(args, value): ContentBlock[]` 与 `presentCall?/presentResult?`（纯函数契约注释）;
- `src/tool/execution/ToolRuntime.ts`：`execute` 成功后先过 schema 校验，失败报 `TOOL_OUTPUT_SCHEMA_MISMATCH`（工具名 + 差异摘要，不吞结果）；
- 首批接入：`draft_claims` / `draft_specification` / `claim_chart_build`（专利产物 JSON 一致性收益最大）。

**验收标准**：新工具缺 `outputSchema` 在注册期 fail-loud；构造一个 schema 违约输出被拦截且错误可读；重放同一 canonical value 两次 render 结果严格相等。

---

## 4. 迭代二（门禁与工具卫生）

### 4.1 任务 T3：精确能力解析 + 请求时模态门禁（对应 #15，2 人日）

**目标**：提供"按当前路由解析最终能力"的统一查询（entry → catalog → 路由默认逐层解析，显式省略即负能力），并在**图片落盘前**做门禁——不匹配即拒绝，杜绝"图片持久化后被 provider 拒、会话反复重放失败请求"。

**改动文件与实现要点**：

| 文件 | 改动 |
|---|---|
| `src/model/catalog/lookup.ts` 或新 `src/model/ModelCapabilityResolver.ts` | 新增 `resolveModelInfo(providerId, modelId)`：合并 catalog 声明 + 用户配置覆盖 + 路由默认，返回 `{ capabilities, multimodal: MultimodalConstraints, source }`；解析顺序 entry → catalog → 默认 |
| `src/model/protocol/multimodal.ts` | 新增 `assertInputModality(constraints, modality)`：不匹配抛稳定错误（含模型名与缺失模态） |
| `src/tool/builtin/analyzePatentFigure.ts` + 图片准入路径（UI 粘贴/`read_image` 类工具） | 准入时调 `resolveModelInfo` 门禁：模型未声明 image → **拒绝并点名模型**（"switch to an image-capable model"语义），替代/前置现有 `downgradeUnsupportedContent` |
| `src/model/streaming/streamModel.ts` | 序列化前保留一道断言（与门禁同源），作为纵深防御 |

**关键决策**：
- `downgradeUnsupportedContent` 保留为"历史会话重放"路径的兜底（旧日志可能含图片而当前模型不支持），新增门禁只作用于**新准入**；
- 与阶段一 T4 的 `apiKeyRaw`/redact 兼容（错误信息不含 key）。

**验收标准**：
- 文本模型粘贴图片被拒且提示可操作（换模型）；
- 图片模型（catalog 声明 image）正常通过；手写未声明模型 → 按 `["text"]` 默认拒绝；
- 旧会话含图片 + 文本模型 resume 时走降级路径不崩溃。

### 4.2 任务 T4：durable 边界检查点（对应 #16，2–4 人日）

**目标**：请求前缀落盘后才分发 adapter；工具副作用前 checkpoint；失败 fail-closed；重试只发生在 durable 边界，`retryId` 跨重启稳定、重启后按 (turn, step, provider, policyKey) 扫描续算。

**改动**：
- `src/session/transcript/JsonlTranscriptWriter.ts`：新增 `flushCheckpoint()`（有界批写之外提供显式边界 flush，已有批写可复用）；
- `src/agent/loop/`（请求分发处）：`stream(request)` 前 `await flushCheckpoint()`；工具调用副作用（写文件/外呼）执行前同样 checkpoint——checkpoint 失败则拒绝执行（fail-closed）；
- `src/model/streaming/streamModel.ts` + `src/agent/loop/modelErrors.ts`：retry 决策绑定 `retryId`（落 `request_header` 快照），重启恢复时按 policyKey 续算；`providerRetryAfterMs` 尊重但封顶；
- 崩溃收尾：gateway 启动时扫描孤儿 turn（有 `turn_start` 无 `turn_end`），合成 `turn_result{interrupted}` 条目保证括号平衡（对齐阶段二 shadowedRanges 恢复路径）。

**验收标准**：
- 注入"checkpoint 后崩溃"场景：重启后不重复执行已 checkpoint 的工具副作用、重试续算不重放已完成的 step；
- 孤儿 turn 合成收尾后 `replayTranscriptEntries` 正常投影。

### 4.3 任务 T5：read-before-write/edit 观测策略系统化（对应 #17，2–3 人日）

**目标**：把 `editFile.ts` 的雏形拒绝语义升级为系统化三态观测 + 版本 CAS——present/absent/unseen 三态注册表（per-session WeakMap），write=createIfAbsent/replaceIfVersion，edit 无先读即拒（`FS_NOT_OBSERVED`），文件变更后旧版本编辑拒（`FS_STALE_VERSION`）。

**改动**：
- 新增 `src/tool/builtin/filesystem/observation.ts`：`ObservedFileRegistry`（三态 + 内容 hash 版本）；`read_file` 观察注册、`edit_file`/`write_file` 消费校验；错误码 `FS_NOT_OBSERVED` / `FS_STALE_VERSION` 进工具错误码表；
- `src/tool/builtin/editFile.ts`：替换现有字符串匹配拒绝逻辑为注册表调用（保留错误文案向后兼容）；
- `src/tool/builtin/bash/` 文件写路径（如有写文件辅助）接入同一注册表（可选，视改动面）；
- 与阶段一 `ToolGuard` 分工：guard 做合规前置，观测策略做**数据正确性**前置，互不重叠。

**验收标准**：
- 未读即改 → `FS_NOT_OBSERVED`；读后被外部修改再改 → `FS_STALE_VERSION`；读后未变 → 通过；
- 重放（resume）场景观测态重建行为有明确定义（首期：resume 需重读，与 dsh 一致）。

### 4.4 任务 T6：工具卫生双件套（对应 #18，1–2 人日）

**目标**：① 把已声明的 `timeoutMs` 变成**强制**（调度层在 `exec.signal` 上熔合 deadline，超时按 signal 返回结构化 `TOOL_TIMEOUT`，合作式非硬杀）；② 在 `doomLoop` 硬断开之前加**软提醒**层。

**改动**：
- `src/tool/scheduler/`（或 `ToolRuntime`）：执行前把 `timeoutMs` 熔合进 AbortSignal（`AbortSignal.timeout` + 现有 signal 组合），超时结果归一为 `TOOL_TIMEOUT`（复用 `errorRecovery.ts` 已有映射）；
- 新增 `src/agent/loop/repeatToolReminder.ts`：按 (toolName, canonical args) 连续重复计数（denied 也计数），≥3 次经 additionalContexts 注入 advisory 提醒（不拦截，与 `doomLoop` 硬断分工）；
- `tests/agent/loop/repeat-tool-reminder.spec.ts`（新）。

**验收标准**：
- 声明 `timeoutMs` 的工具超时后收到 `TOOL_TIMEOUT`（非悬挂）；忽略 signal 的工具行为有文档化说明（合作式限制）；
- 连续 3 次相同参数调用后，下一轮上下文含提醒文本；不同参数不误报。

### 4.5 任务 T7：配置分层解析 + last-good-facts 显式化（对应 #19，2–3 人日）

**目标**：schema 默认 → base → user 三层解析显式化；写入 revision 栅栏防并发覆盖；热重载坏 section **保留最后有效快照继续服务**（endpoint 与 key 永不跨代配对），启动/注册期 fail-loud。

**改动**：
- `src/pilot/config/PilotConfigStore.ts`：把现有 watch/reload 的隐式容错语义显式化为 `lastGoodFacts` 字段（坏快照保留 + 每次切换告警一次，**并加"持续坏配置周期告警"**——dsh 只告警一次，Sati 补周期提醒）；
- `src/pilot/config/merge.ts`：显式三层（defaults → base → user doc）合并顺序 + 来源标注；新增 revision 字段，写回时 CAS 校验拒绝覆盖他人写入；
- `ui/server` 写回路径（双后端 JS）：适配 revision 校验（失败返回 409 并附服务端 revision）。

**验收标准**：
- 写入坏 yaml → 运行不中断、旧配置继续服务、日志告警；修复后下一 reload 恢复；
- 并发双写 → 后者 409；三层覆盖顺序单测（user > base > default）。

### 4.6 任务 T8：事件生产者/消费者矩阵生成器（对应 #20，2 人日）

**目标**：四套事件语汇（AgentEvent / gateway frames / transcript 条目 / telemetry）自动生成生产者/消费者矩阵并 `--check`，防事件改版漏订。

**改动**：
- 新增 `scripts/gen-event-matrix.ts`：解析 TS AST，事件声明（类型文件）→ dispatch 点（`emit`/`dispatch` 调用）→ 订阅点（`on(`/`subscribe`）成边，生成 `docs/event-producer-consumer.md`；`--check` 模式 CI 门禁；
- 第一期覆盖 `src/agent/protocol/events.ts` + `src/gateway/protocol/frames.ts`（最高价值两套），transcript/telemetry 第二期扩展；
- CI：`pnpm lint` 或独立 script 挂 `--check`。

**验收标准**：
- 新增一个事件只在一边使用 → `--check` 红；补文档生成后绿；
- 生成文件头带"generated - do not edit"标记（对齐 `docs` 内已有生成物惯例）。

---

## 5. 任务清单（可勾选）

### 迭代一（测试与请求可验证性，约 8–11.5 人日）

- [x] T1.1 录制器 `src/test-support/llm-replay/record.ts` + CLI `scripts/record-llm-replay.ts`
- [x] T1.2 重放 runtime + sidecar 注入 + `assertConsumed`
- [x] T1.3 回路级重放 spec（8 用例，含 hang 注入；router 级装配，见 §8 实证修正 2）
- [x] T2.1 `request_header` 条目类型 + log-only 投影跳过
- [x] T2.2 发送前落快照 + `requestInvariant.ts` 对拍器
- [x] T2.3 对拍 spec（6 用例：正常/篡改/重建/投影不变）
- [x] T10 凭证双码 + 6 用例
- [x] T9.1 `outputSchema` 新工具强制 + 注册期 fail-loud（`ToolRegistryOptions.requireOutputSchema`）
- [x] T9.2 `ToolRuntime` 校验 + `TOOL_OUTPUT_SCHEMA_MISMATCH`
- [x] T9.3 首批 3 个专利工具接入（draft_claims/draft_specification/claim_chart_build）

### 迭代二（门禁与工具卫生，约 11–16 人日）

- [x] T3.1 `resolveModelInfo` 统一查询（entry→catalog→默认）——接入 router 与 gateway
- [x] T3.2 `assertInputModality` + 图片准入门禁（analyze_patent_figure 硬拒绝；UI 走 router 既有门禁）
- [x] T3.3 streamModel 序列化前纵深防御（既有 `assertContentSupported` 测试锁定）
- [x] T4.1 `flushCheckpoint` + 工具副作用前 checkpoint（fail-closed）
- [x] T4.2 retryId 稳定化 + 进度事件透出 + `providerRetryAfterMs` 封顶（既有）；重启扫描续算属 always-on 范畴
- [x] T4.3 孤儿 turn 合成 `turn_result{interrupted}` 收尾（resume 接线）
- [x] T5.1 三态观测语义 + 写意图纯函数分类器（present/absent/unseen）
- [x] T5.2 `file_not_observed`/`file_stale_version` 稳定错误码（既有快照校验重构接入）
- [x] T5.3 resume 重读语义（会话内存态，文档化）
- [x] T6.1 `SatiToolDefinition.timeoutMs` + signal 熔合 + `TOOL_TIMEOUT` 归一
- [x] T6.2 `repeatToolReminder` 软提醒（transient synthetic 注入）+ spec
- [x] T7.1 三层解析（schema 默认→base yaml→env 覆盖，mergeConfigSources 既有）——核实
- [x] T7.2 lastGoodFacts 显式化 + 持续坏配置周期告警（每次失败告警）
- [x] T7.3 ui/server 写回 409 CAS（既有 baseRevision 校验）——核实
- [x] T8.1 `gen-event-matrix.ts`（AgentEvent + gateway frames，启发式 v1）
- [x] T8.2 `--check` 挂 lint 门禁 + `docs/event-producer-consumer.md` 生成物

---

## 6. 可验证的检查清单（全阶段验收）

### 6.1 静态与构建
- [ ] `pnpm typecheck` 0 错误（含 edgeclaw-memory-core）
- [ ] `pnpm lint` 0 error / 0 warning
- [ ] `pnpm format:check` 通过
- [ ] `pnpm build` 成功

### 6.2 测试（新增 + 回归）
- [ ] T1 重放 spec（含 hang 注入、assertConsumed）通过
- [ ] T2 对拍 spec（正常/篡改/投影不变）通过
- [ ] T3 门禁 spec（拒绝/通过/降级兜底）通过
- [ ] T4 checkpoint spec（崩溃续算、孤儿收尾）通过
- [ ] T5 观测 spec（三态 + CAS + resume）通过
- [ ] T6 超时 + 提醒 spec 通过
- [ ] T7 配置 spec（坏快照保留、409、三层覆盖）通过
- [ ] T8 `--check` 红绿场景通过
- [ ] T9 schema 校验 spec 通过；T10 凭证双码 6 用例通过
- [ ] 全量后端测试 `pnpm test` 通过（root 与 ui 串行，阶段一已记录竞态）
- [ ] UI 测试 `pnpm --filter sati-ui test` 通过

### 6.3 行为验证（每任务专项）
- [ ] T1：CI（无 key）跑重放 fixture 全绿；`SATI_LLM_REPLAY_ROOT` 未设置时行为不变
- [ ] T2：真实会话跑一轮后 `request_header` 条目可审计（`readSessionMessages` 可见 log-only 标记）
- [ ] T3：文本模型 UI 粘贴图片 → 拒绝提示点名模型；图片模型通过
- [ ] T4：kill -9 后重启，不重复执行已 checkpoint 的工具副作用
- [ ] T5：未读即改/读后外部改两种拒绝文案符合预期
- [ ] T6：连续重复调用 3 次后 UI 上下文可见 advisory 提醒
- [ ] T7：写坏 `sati.yaml` 运行不中断、旧配置生效
- [ ] T9：draft_claims 产物过 schema 校验；人为违约被拦截

### 6.4 回归（确保不破坏现有行为）
- [ ] 阶段一/二行为保持：guard 优先于一切规则、shadowedRanges 恢复、凭证轮换即生效
- [ ] 27 个专利技能中至少 3 个代表性技能（检索/撰写/审查）端到端跑通
- [ ] `sati server` 启动 knowledge 自检无版本报错

---

## 7. 风险与注意事项

1. **T1 录制 fixture 的可复现性**：录制产物含 provider 波动（模型输出变化），fixture 更新需走显式 `record:replay` 命令 + PR 评审；不把真实 key 录进产物（录制器只存 chunk 序列，不存请求头含 key 的字段——与 T4 的 `apiKeyRaw` 脱敏约定一致）。
2. **T2 快照粒度**：记 digest 不记全量（system/tools），避免 dsh"每 step 全量快照"的日志膨胀；若未来需要逐字节重放再升级为全量。
3. **T3 门禁与降级的边界**：门禁只作用新准入，`downgradeUnsupportedContent` 保留为历史会话兜底；两路径并存需各自单测，防止"门禁挡住新图、降级吞掉旧图"的语义漂移。
4. **T4 checkpoint 成本**：每 step 一次显式 flush 有 IO 成本，对 always-on 长任务可配置为"每 N 步 + 工具副作用前必刷"两档；性能回归用 T1 重放 fixture 度量。
5. **T7 last-good 掩盖问题**：dsh 自认"坏配置只告警一次会掩盖持续错误"，Sati 版必须加周期告警（本计划已列）。
6. **T8 生成器解析面**：TS AST 解析事件边有误报风险（动态 `on(eventName)`），第一期用白名单 + 人工复核生成物；不追求 100% 自动化。
7. **治理约定并行落地**：P0 五条（seam 三角色/可逆注册/无硬编码 tunable/defensive-patterns/消费者不得决定契约）在 CLAUDE.md 更新 PR 中落地，与阶段四任务互不阻塞，但 T5/T6 的新模块应按新约定写（可逆注册、tunable 配置化）。

---

## 8. 实施结果（迭代一，2026-08-16）

### 8.1 新增文件

| 文件 | 用途 |
|---|---|
| src/test-support/llm-replay/types.ts | 重放 seam 类型契约（ReplayRecord/Manifest/Override/ReplayError） |
| src/test-support/llm-replay/requestKey.ts | 稳定请求键（raw 剥离 sha256）+ 请求摘要 |
| src/test-support/llm-replay/overrides.ts | sidecar replay.override.json 加载校验（越界/重复 fail-loud） |
| src/test-support/llm-replay/record.ts | 录制 runtime（每 stream 一 JSONL 记录 + 原子 manifest） |
| src/test-support/llm-replay/replay.ts | 重放 runtime（每键 FIFO + 覆写注入 + assertAllConsumed） |
| src/test-support/llm-replay/envHooks.ts | gateway env 钩子（RECORD_ROOT / ROOT 二选一） |
| src/test-support/llm-replay/index.ts | barrel |
| src/agent/loop/requestInvariant.ts | request/header 快照构建 + 对拍器（纯函数 + 结构化错误） |
| src/tool/execution/outputSchemaValidation.ts | canonical 输出校验器（JSON Schema 子集） |
| scripts/record-llm-replay.ts | fixture 校验/清单 CLI（pnpm record:replay <dir>） |
| tests/test-support/llm-replay.spec.ts | T1 回路级重放测试（8 用例，含 hang/throw 注入） |
| tests/agent/loop/request-invariant.spec.ts | T2 对拍测试（6 用例） |
| tests/model/config/credential-codes.spec.ts | T10 凭证双码测试（6 用例） |
| tests/tool/output-schema-validation.spec.ts | T9 契约校验测试（7 用例，含真实专利工具产物） |

### 8.2 修改文件（19 处）

- **T1**：src/cli/createLocalGateway.ts（applyReplayEnvHooks 注入）、package.json（record:replay script）
- **T2**：src/session/transcript/TranscriptEntry.ts（request_header 条目 + 快照类型）、TranscriptWriter.ts / JsonlTranscriptWriter.ts / InMemoryTranscriptWriter.ts（recordRequestHeader）、TranscriptReplay.ts（log-only 跳过）、src/agent/protocol/input.ts（onRequestHeader 回调）、src/agent/loop/AgentLoop.ts（发送前落快照 + env 开关对拍）、src/agent/turn/TurnRunner.ts（接线）
- **T10**：src/model/config/resolveCredentials.ts（双码 + assertUsableCredential）、src/model/streaming/streamModel.ts（请求路径 ModelConfigError→ModelRequestError）、src/agent/loop/modelErrors.ts（双码分类路由 + 提示）、tests/model/config/credential-ref.spec.ts（预期同步更新）
- **T9**：src/tool/protocol/errors.ts（tool_output_schema_mismatch 码）、src/tool/registry/ToolRegistry.ts（requireOutputSchema 选项）、src/tool/execution/ToolRuntime.ts（data 存在即校验）、src/tool/builtin/draftClaims.ts / draftSpecification.ts / claimChart.ts（首批 outputSchema）

### 8.3 验证结果

- pnpm typecheck ✅ 0 错误（含 edgeclaw-memory-core）
- pnpm lint ✅ 0 error（1 条阶段二遗留 UI 导入顺序警告，与本次无关）
- pnpm format:check（biome）✅ 通过（1807 文件）
- 新增测试 27 用例全绿：T1 重放 8 + T2 对拍 6 + T10 双码 6 + T9 契约 7
- 回归：model/config 18、agent/loop 143（含新增）、session/transcript 相关 50、draft 三工具 21 全绿
- pnpm record:replay CLI 冒烟：非法 fixture 退出码 1

### 8.4 实施中的实证修正

1. **T1 重放键改为内容哈希 + 每键 FIFO**（而非 dsh 的 (turn, step)）：Sati 的 router 单轮内可能对 fallback 多模型发起多次尝试，turn/step 无法稳定映射到具体请求；内容键天然对齐「重放同一请求序列」语义。录制侧以 env 注入 gateway（RECORD_ROOT/ROOT 二选一，同设即抛错）；CLI 定位为 fixture 校验/清单工具（录制本身是实时旁路）。
2. **T1.3 回路级测试落在 router 级**：真实 createRouterRuntime 装配 + 重放 runtime 驱动完整 streamAttempt 链路；完整 AgentLoop 级留待 loop 测试 harness（依赖面大，见 AgentRuntimeDependencies）。fixture 由确定性 ScriptedModelRuntime 录制（CI 无 key）；真实模型 fixture 按 §7 风险 1 流程另行录制提交。
3. **T2 对拍器 v1 为纯函数 + env 开关**：写入路径复用 AgentLoopInput 回调模式（onRequestHeader，与 onDurableMessage 同构）由 TurnRunner 接线；对拍在 SATI_VERIFY_REQUEST_RECONSTRUCTION=1 时于发送前自检，测试侧用 verifyRequestReconstruction 对 transcript 条目做独立重建验证。快照记 digest 不记全量（防日志膨胀）。
4. **T9 校验语义收敛**：outputSchema 声明的是成功契约——data 存在即必须匹配，data 缺省（如 claim_chart_build 失败路径只返回 content）不触发校验；repo 无 ajv/zod，校验器为自研 JSON Schema 子集（type/required/properties/additionalProperties/items/enum/const/integer）。
5. **T10 请求路径转换**：请求期凭证失败由 ModelConfigError 转 ModelRequestError，经 router canonicalizeModelRequestError 原样带入 CanonicalModelError.code，loop 分类据此路由提示（missing→配置引导、invalid→不自动重试）；既有 credential-ref 测试预期同步更新（fail-loud 语义不变）。

### 8.5 遗留注意

- SATI_VERIFY_REQUEST_RECONSTRUCTION 生产默认关闭（env 显式开启），首轮以测试侧独立重建为主验证手段；
- ToolRegistry.requireOutputSchema 默认 false（存量注册表不受影响），存量工具分批复用 schema 后按注册表逐步开启；
- 真实模型录制的 fixture 尚未入库（需真实 API key 会话录制 + PR 评审），当前入库 fixture 为确定性脚本录制。

---

## 9. 实施结果（迭代二，2026-08-16）

### 9.1 新增文件

| 文件 | 用途 |
|---|---|
| src/model/resolveModelInfo.ts | T3.1 统一能力解析（config → catalog → 协议默认 + 来源标注） |
| src/model/streaming/retryState.ts | T4.2 重试状态追踪（稳定 retryId / capRetryAfterMs / 调度记录） |
| src/session/transcript/interruptedTurn.ts | T4.3 孤儿 turn 检测与 interrupted 收尾合成 |
| src/agent/loop/repeatToolReminder.ts | T6.2 连续重复软提醒（计数器 + transient synthetic 消息） |
| src/tool/execution/toolTimeout.ts | T6.1 deadline 熔合与超时判定 |
| src/tool/builtin/filesystem/observation.ts | T5 三态观测语义 + classifyWriteIntent 纯函数 |
| scripts/gen-event-matrix.ts | T8 事件生产者/消费者矩阵生成器（--check 门禁） |
| docs/event-producer-consumer.md | T8 生成物（45 事件矩阵） |
| 测试 8 个 spec | T3×5 + T4×8 + T5×7 + T6×7 + T7×1（见 9.3） |

### 9.2 修改文件（14 处）

- **T3**：src/model/protocol/multimodal.ts（assertInputModality）、src/tool/builtin/analyzePatentFigure.ts（image 门禁）、src/router/RouterRuntime.ts（missingForModel/downgradeRequestForAttempt 走 resolveModelInfo）、src/cli/createLocalGateway.ts（modelMultimodal 走 resolveModelInfo）、src/model/index.ts（barrel）
- **T4**：src/session/transcript/TranscriptWriter.ts + Jsonl/InMemory（flushCheckpoint）、src/agent/loop/AgentLoop.ts（onFlushCheckpoint + 工具副作用前 checkpoint）、src/agent/protocol/input.ts + TurnRunner.ts（接线）、src/model/streaming/streamModel.ts（retryId 注入进度事件）、src/router/protocol/events.ts（retryId 字段）、src/agent/protocol/result.ts + errors.ts（interrupted 收尾类型）、src/session/resume/resumeAgentSession.ts（孤儿 turn 合成）
- **T5**：src/tool/builtin/filesystem/writeSnapshots.ts（classifyWriteIntent 重构 + 新错误码）、src/tool/protocol/errors.ts（file_not_observed/file_stale_version）
- **T6**：src/tool/protocol/types.ts（SatiToolDefinition.timeoutMs）、src/tool/execution/ToolRuntime.ts（signal 熔合 + TOOL_TIMEOUT）、src/agent/loop/AgentLoop.ts（repeatTracker 接线）
- **T7**：src/pilot/config/PilotConfigStore.ts（lastGoodFacts + 连续失败告警）
- **T8**：package.json（gen/check:event-matrix + lint 门禁挂接）

### 9.3 验证结果

- pnpm typecheck ✅ 0 错误；pnpm lint ✅ 0 error（1 条阶段二遗留 UI 警告）；pnpm format:check ✅（1822 文件）
- 新增 28 用例全绿（T3 6 + T4 8 + T5 7 + T6 7 + T7 1）
- 回归：tool+loop 432、model+router+session 50+、agent/loop 138 全绿
- pnpm gen:event-matrix --check 挂入 lint 门禁 ✅ fresh

### 9.4 实施中的实证修正

1. **T3 请求期门禁已存在**：router 的 supportsMediaRequirements/createUnsupportedMediaError/降级路径 + validateModelRequest 的 assertContentSupported（T3.3）均已有；T3 增量收敛为统一能力解析（resolveModelInfo 补 pass-through/catalog 回退，替代 router 的裸 getMultimodal try/catch）+ assertInputModality 工具 + analyze_patent_figure 显式门禁。
2. **T4.1 写入即落盘**：JsonlTranscriptWriter.recordEntry 每次已 await appendFile（无写后缓冲），flushCheckpoint 是契约性 no-op；durable 边界的真实价值在「副作用前显式 checkpoint」接线。
3. **T4.2 封顶已存在**：calculateRetryDelay 已实现 retryAfterMs 封顶；增量是稳定 retryId 与进度事件透出（重启扫描续算属 always-on 范畴，文档化）。
4. **T5 基础设施已成熟**：Sati 的 writeSnapshots（mtime+内容哈希双校验）已含三态与 CAS 语义；增量是命名化的纯函数分类器 + 稳定错误码（file_not_observed/file_stale_version），替代消息正则匹配。
5. **T6.1 预算字段缺失**：计划此前声称 types.ts:62 有 timeoutMs 系误读（那是 subagent fork 选项）；按计划补上 SatiToolDefinition.timeoutMs。
6. **T7.3 已存在**：ui/server 写回路由已有 baseRevision CAS + 409 CONFIG_CONFLICT；增量只剩 store 侧 lastGoodFacts 显式化与周期告警。
7. **T8 启发式限制**：生产者/消费者列当前为启发式扫描（含 yield { type } 与对象字面量调用），产生/消费两列存在同源重复；按计划 §7 风险 6 记录，人工复核 + 后续按需精化。

### 9.5 遗留注意

- T4.2 跨进程「重启后扫描续算重试」未接线（依赖 always-on 任务级重启扫描），当前为进程内稳定 retryId + 日志/遥测轨迹；
- T8 矩阵为启发式 v1，两列同源重复需人工复核后按需精化（白名单/事件源注解）；
- T5 resume 后观测态为空（unseen），文件需重读——与既有行为一致，已文档化。

---

## 附：上游依据速查（dsh 路径）

| 本计划编号 | dsh 依据 |
|---|---|
| #13 | `packages/test-support/llm-replay/` |
| #14 | `packages/llm/llm/README.md`（request/header）、`packages/core/agent-loop/src/invariant.ts`、`packages/runtime-diagnostics/invariants/` |
| #15 | `packages/llm/llm/src/index.ts:619`（resolveModelInfo）、`packages/llm/llm-pi-ai/src/adapter.ts:246`、`packages/llm/llm-pi-ai/src/catalog.ts:533` |
| #16 | `packages/session/session-checkpoint-policy`、`packages/llm/llm-retry/`、`docs/subsystems/persistence.md` |
| #17 | `packages/fs/fs-observation-policy/`、`packages/fs/fs/`（fs/* 事件门） |
| #18 | `packages/guard/timeout-policy/`、`packages/guard/repeat-tool-reminder/` |
| #19 | `packages/settings/settings/`、`packages/llm/llm-deepseek/src/index.ts:203`（last-good-facts） |
| #20 | `scripts/gen-doc-graphs.ts` → `docs/event-producer-consumer.md` |
| #21 | `docs/subsystems/tools.md`（ToolDefinition/output/execute 契约） |
| #22 | `packages/credentials/credentials/`、`packages/llm/llm/src/index.ts:assertUsableApiKey` |

