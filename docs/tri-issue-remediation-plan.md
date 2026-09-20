# 三议题彻底解决方案（#449 / #450 / #159）

> **验收状态：主要构件已落地**（2026-09-19 制订，基线提交 `e9267d8ce`；2026-09-20 复核后更正原「待实施」标注，见下方状态复核）。
>
> **状态复核（2026-09-20，docs↔code 一致性审计）**：
> - §2（#449 真实窗口）：`src/model/window/{extract,probe,store,types,index}.ts` 存在，并被 `src/cli/sessionDependencyAssembly.ts`、`src/model/protocol/canonical.ts`、`src/pilot/config/loadPilotConfig.ts` 消费；决策记录 `docs/notes/implemented/2026-09-19-model-window-overlay.md`。
> - §3（#450 工作区判据）：`detectPatentWorkspace` / `PATENT_DOMAIN`（`src/pilot/workspace/patentSignals.ts`）已接入 `src/cli/projectRuntimeFactory.ts`；决策记录 `docs/notes/implemented/2026-09-20-patent-domain-workspace-criterion.md`。
> - §4（#159 拆解）：`docs/notes/implemented/2026-09-20-{code-editor-binary-file-split,session-store-actions-extraction,pdf-preview-remaining-extraction,diffline-type-convergence,chat-session-state-pagination-scroll}.md`。
> - **本次未核**：§0 的「首个请求固定开销 ≤ 20k」数值断言（未跑 `pnpm measure:fixed-overhead`，不作结论）；§0 表内 ❌ 标记请以各批次勾选与 note 为准。
> 本文件是实施方案，不是完成报告；每个批次落地后回来勾选并在末尾追加实测数字。
> 用户已就四个关键分叉作出选择（见 §8）：运行时探测 + 观测回写 / 加判据 + 迁移守卫后翻转 / inputSchema 有限瘦身 / #159 全部做完并关闭。

## 0. 范围与验收标准对照

| 议题 | 验收标准 | 现状 | 本方案落点 |
|---|---|---|---|
| #449 | 设置页能看到生效窗口及来源（config / catalog / default） | ✅ 已达成（#454） | 追加 `probe` / `observed` 两类来源 |
| #449 | UI placeholder 与后端实际生效值同源 | ✅ 已达成（#454 / #455 + `check:catalog-mirror`） | 保持；新来源同源展示 |
| #449 | **自动压缩与 blocking 判定使用真实窗口，而非过时兜底值** | ❌ 未达成（openai 协议默认 128k） | §2 四构件（探测层 / 观测层 / 可见层 / 确认入口） |
| #450 | **新会话首个请求固定开销 ≤ 20k（128k 窗口下 ≤15%）** | ❌ 默认 33,641 | §3.2–§3.4（工作区判据 + 默认翻转 + 清单裁剪） |
| #450 | **非专利工作区默认不暴露 patent 域工具，专利工作区行为不变** | ❌ 无任何工作区判据 | §3.1–§3.3 |
| #450 | `pnpm record:replay` 重录后绿、`pnpm check:event-matrix` 无新增差异 | 待验证 | §3.5 + §6.3 |
| #159 | 拆分前端 God Hook/组件（剩余 5 子项） | 部分（L 级三项已完成） | §4 五波 |
| #159 | UI 改动双主题 / 双语言 / 状态 / 响应式验证 | 待做 | §4.7（本环境截图不可用，用 A/B DOM 指纹替代，沿用既有先例） |

## 1. 现状证据（本方案的全部数字均为 `e9267d8ce` 实测）

### 1.1 固定开销

口径：`createLocalGateway({__testModelFactory})` + `submitTurn` 一次 + `countTokens` 分段；system = system prompt，tools = 工具 schema。

| 配置 | 工具数 | system | tools | 固定开销 |
|---|---|---|---|---|
| 默认（`tools: {}`） | 79 | 9,492 | 24,149 | **33,641** |
| `hiddenDomains: [patent]` | 51 | 9,492 | 10,478 | **19,970** |
| 三组工具全关 | 51 | 9,491 | 19,723 | 29,214 |
| `hiddenDomains: [patent]` + 三组全关 | 25 | 9,491 | 7,515 | **17,006** |
| `visibleDomains: [filesystem, shell]` | 23 | 10,879 | 4,795 | 15,674 |

分项：patent 域 28 工具 **13,671**；kanban 15 工具 1,285；team 11 工具 1,678；document_style 2 工具 1,463；`<available-skills>` 3,650（63 条）；`<available-roles>` 1,890（32 条，**32/32 全部含 patent 域**）。

> 口径注意：system 含本机 `<mcp-instructions>` 2,442 tokens，属**机器相关量**（全新安装为 0）。§3.6 钉死验收测量环境，否则同一口径可差 3.4k。
> 另注：#452 评论把「整个 inputSchema 14,742」称作参数描述池，实测其中**真正的参数 description 文本只有 6,808 tokens**（440 条），其余 ~7,934 是键名/结构。清空全部参数描述的上限只有 −6.8k。

### 1.2 窗口解析与兜底（#449）

- 解析唯一入口：`src/model/config/parseModelConfig.ts:272-283`（`:283` = `catalogCapabilities ?? protocolDefaults`）。
- 协议默认：`openai/defaults.ts:12` 128000、`anthropic/defaults.ts:12` 200000、`google/defaults.ts:12` 1048576。
- **下游还有 3 个互不相同的兜底**：`src/agent/loop/tokenCapManager.ts:78`（1,000,000）、`src/web/server/sessionTokenUsage.ts:15`（`DEFAULT_HISTORY_CONTEXT_TOKENS = 200_000`）、`ui/src/shared/modelProtocolDefaults.json`（镜像）。
- **第二处「分母不同源」**：历史回放走 `src/cli/gatewayRuntimeOptions.ts:68-75` ← `createLocalGateway.ts:305` 的 `config.agent.maxContextTokens`（通常 undefined）→ 回落 200k，即**实时压缩按 128k、刷新后回放按 200k**。
- 超限反推机制**已存在但不持久**：`src/agent/loop/ContextOverflowRecovery.ts:80-86`（reason `provider-context-cap`）→ `modelErrorRecovery.ts:376-394` `setTransientTokenCap` → `tokenCapManager.ts:46` 纯内存 Map（跨 turn 存活，跨进程/重载丢失）；`token_cap_adjusted` 事件在 UI **零消费**。
- 现有 `/models` 探测**丢弃窗口**：`ui/server/routes/config.js:676-748`、`normalizeModelListItem`（`:336-348`）只返回 `{id, displayName}`；端点构造在 `src/model/providerEndpoint.ts:100-108`。
- 探测可得性：OpenRouter `context_length`（本机实测 447/447 全带）、Google `inputTokenLimit`、Anthropic `max_input_tokens` ✅；Ollama `details.context_length`、llama.cpp `meta.n_ctx_train` ✅；**标准 OpenAI 形状 / xAI / 未扩展自建中转站 ❌**。

### 1.3 工作区配置通道（#450 的关键障碍）

- `tools.visibleDomains / hiddenDomains / documentStyle / kanban / team` 全部是**机器级**（读 `~/.sati/sati.yaml`）。
- `<projectRoot>/.sati/sati.yaml` 通道存在但是**死代码**：`src/shared/paths/pilotPaths.ts:29-31` 导出 `getPilotProjectConfigFilePath`，**全仓 0 消费者**；实测只在项目里写 `hiddenDomains:[patent]` → 79 工具、`patent_search` 仍在；只在 pilotHome 写 → 51 工具。
- 全仓**不存在**任何"这是专利项目"的判据（`grep isPatent|patentProject|patentMode` 无命中）。
- 专利信号候选（首会话可得）：`.sati/rules.yaml` 规则包清单（`src/rule/runtime/rule-pack.ts:25`）、项目技能 `.sati/skills/**`（`pilotPaths.ts:59`）、`.sati/SATI.md`/`SATI.md`（`InstructionDiscovery.ts:55-62`）、`patents:` 段（`src/pilot/config/parsePatentsConfig.ts`）。
- 运行期专利产物（`.sati/figures*`、`.sati/documents`、`data/cases/**/workflow-runs`）**只在跑过任务后才存在**，帮不了新专利工作区。

### 1.4 llm-replay fixture 的边界（重要）

- 请求键 = provider/model/systemPrompt/messages/**tools(name + inputSchema)**/toolChoice/maxOutputTokens（`src/test-support/llm-replay/requestKey.ts:52-62`）；**顶层 description 不入键**，参数描述入键。
- fixture 装配（`tests/test-support/llm-replay-real.spec.ts`）**不经网关**：`systemPrompt` 为空串、47 个工具（`createBuiltinRegistry({askUserQuestion:false, planMode:false})`）。
- ⇒ **落在项目注册表 / 网关层的默认翻转不碰 fixture**（实测离线复现键 `dbdc05ca…3e` 与 manifest 逐字一致）；**只有改 `inputSchema`（或改 `createBuiltinRegistry` 的默认注册集）才需要重录**。
- `pnpm record:replay` **不是录制器**，只做校验（`scripts/record-llm-replay.ts:36-45`）；真实录制：`SATI_LLM_REPLAY_RECORD_ROOT=<dir> node --import tsx scripts/record-real-fixture.ts "<task>"`，需真 key（本机 `~/.sati/sati.yaml` 配了 deepseek 等 provider）。

### 1.5 #159 剩余项现状（含台账三处更正）

| 项 | 文件行数 | god function | 测试 | 台账事实更正 |
|---|---|---|---|---|
| N07 `PdfDocumentPreview.tsx` | 1723 | **1064**（660–1723） | `*.test.tsx` 仅 **2 条** | 选区→引用实为 **190 行**（1070–1198 + 1244–1304），不是 235 行（1199–1243 是视口调度） |
| N08 `CodeEditorBinaryFile.tsx` | 1510 | **无**（最大 `SpreadsheetPreview` 225） | 8 条（全渲染） | 「god function + 内联 8 hooks 分派器」**不成立**：9 个 hook 早已是具名顶层函数；真分派器 `OfficeFilePreviewRouter` 89 行 |
| N02 `useSessionStore.ts` | 1405 | **728**（677–1404） | 24 条**全打在模块级纯函数** | 「8 个近同函数 + 三处重复拼 URLSearchParams」**已于 2026-09-02（PR #241）修掉**，条目从未回填；主闭包零覆盖 |
| `ImportFromFolder.tsx` | 824 | **688**（65–752） | 4 条**全 batch** | picked/typed/校验面板零覆盖；两族共用 6 个状态是 god function 真粘合点 |
| N15 `DiffLine` | — | — | 4 个测试文件传 `createDiff` | 副本实为 **7 处 + 1 处内联匿名**（台账漏记 `ToolResultBlock.tsx:60`）；全仓只有 `ToolDiffViewer.tsx:82/87/91` 消费 `.type` ⇒ **收敛零编译风险** |

指标门禁：`scripts/measure-techdebt.mjs`（god function 阈值 300，命中 57 条）挂 `pnpm lint` 链尾 ⇒ **任何行数/`as unknown as` 计数变化必须在同一 PR 跑 `pnpm measure:update`**，否则 `pnpm check` 直接红。注意 `metrics.md` 行数比 `wc -l` 恒 +1（`readLines()` = `split("\n").length`），引用台账数字须声明尺。

### 1.6 顺带发现的独立缺陷（纳入本方案）

- **tokenizer 冷启动低估 39.6%**：`src/context/budget/tokenizer.ts:34-36,92-105` 的「病态输入」启发式按**墙钟 80ms** 判定；冷进程首调构造 Tiktoken 使样本编码 ~240ms → 触发按英文密度外推，system prompt 精确 9,494 被报成 **5,736**，且结果进进程级缓存**永不纠正**（缓存命中还标 `mode: full`）。生产主路径因 `TokenAccountingRuntime.ts:197-201` 先算 messages（短文本预热）多数安全，但 `ToolResultBudget.ts:427` 首次即长文本时同险。**它同时污染 #450 的验收测量本身**（复测必须预热或改用精确编码）。
- 历史回放分母不同源（§1.2 末条）。

## 2. #449 实施方案：让压缩与 blocking 用上真实窗口

选择：**运行时探测 + 观测回写**（用户已确认）。不改大协议默认值（既有决策 `docs/notes/implemented/2026-09-18-settings-effective-window.md:39` 的否决理由在今天的代码里依然成立：改大会把所有命中 openai 默认的模型压缩线从 ~102k 推到 ~160k，把失败推迟到真实超限点，而跨进程兜底只有瞬态降级）。

### 2.1 构件①：窗口来源分层（引擎）

新增 `src/model/window/`：

| 模块 | 职责 |
|---|---|
| `probe.ts` | 从 provider `/models` 响应抽取窗口：键表（`context_length` / `inputTokenLimit` / `max_input_tokens` / `n_ctx_train` / `max_model_len` / `details.context_length`），**只读顶层 key**，区间校验（1k–16M），服务器指纹瀑布（ollama → llama.cpp → vllm → lmstudio → 通用） |
| `store.ts` | `~/.sati/model-windows.json` 覆盖层（`atomicWriteJson`，路径工具落 `src/shared/paths/pilotPaths.ts`）；带来源标记与写入时间；读失败 fail-open |
| `resolve.ts` | 解析优先级：**config 声明 > observed（超限实测）> probe（探测）> catalog > 协议默认** |

接线：`parseCapabilities`（`src/model/config/parseModelConfig.ts:272-283`）加载覆盖层（同步读缓存文件；探测结果下次 reload/重启生效，与既有 ollama 预热时序 `src/pilot/config/loadPilotConfig.ts:712-718` 一致）。

### 2.2 构件②：超限观测回写（持久化）

复用既有链路，只加持久化与信任边界：

- 只信 `ContextOverflowRecovery.ts:80-86` 的 `provider-context-cap` 分支（`truncate_head_and_retry` / availableOutputTokens 分支**禁止写回**）。
- 新增 `deps.recordObservedContextWindow`（`ModelErrorRecoveryDeps`，`modelErrorRecovery.ts:70-78`），由 `sessionDependencyAssembly.ts` 注入 → 写 `model-windows.json`（`source: "observed"`）。
- 冲突策略：observed 与 probe 冲突取**较小值**（保守，避免压缩线推后导致真实超限失败）；区间校验（1k–16M）拦住宽松正则的误匹配（`tokenLimitParsing.ts:74-92`）；设置页可清除。
- 第二处不同源一并修：`src/web/server/sessionTokenUsage.ts:15` 的 200k 兜底改为与引擎同源；`tokenCapManager.ts:78` 的 1,000,000 兜底保留但标注语义（只在完全查不到能力时命中）。

### 2.3 构件③：来源可见（UI）

- 引擎 `ModelInfoSource`（`src/model/resolveModelInfo.ts:24`）扩为 `config | observed | probe | catalog | default`。
- 同步 10 处（枚举 2 处、`resolveLimit`、`SOURCE_KEY`（`AgentsSection.tsx:13-18`，穷尽映射漏改即编译失败）、渲染、i18n `zh-CN/settings.json:885-891` + `en/settings.json:900-906`、测试、API 暴露点、parity 测试）。
- UI 不能 import `src/` ⇒ 新增只读 API `GET /api/config/model-windows` 读同一份 json。

### 2.4 构件④：用户确认入口（探测失败时的兜底）

`AgentsSection` 增「采纳探测值 / 手动确认窗口」→ 写 `capabilities.maxContextTokens` → `PUT /api/config` → 网关 watcher（`createLocalGateway.ts:220-221`）热重载即时生效，来源自然回落 `config`。**这是 issue「要求用户确认窗口」的唯一 100% 正确实现**，且不改 onboarding 流程。

### 2.5 验收证据

- 单测：探测抽取（各协议样本 + 空/畸形响应）、覆盖层优先级、observed 只信一个分支、冲突取小、区间校验拒绝、`sessionTokenUsage` 同源、parity 测试。
- 集成：`createLocalGateway` + 假 provider `/models` 响应 → 断言压缩/blocking 分母取自探测值（而非 128k）。
- 负控制：① 把 observed 写回接到 `truncate_head_and_retry` 分支 ⇒ 对应用例红；② 覆盖层优先级倒置 ⇒ 红；③ 冲突取大 ⇒ 红。
- 门禁：`pnpm check`（含 `check:protocol-version`；若动 gateway 字段需记 MINOR 并重跑 `gen:event-matrix`）。

## 3. #450 实施方案：默认瘦身 + 干净测量

选择：**加判据 + 迁移守卫后翻转**（用户已确认），外加 **inputSchema 有限瘦身**（用户已确认，见 §3.5）。

### 3.1 构件①：工作区级专利判据（新增）

新增 `src/pilot/workspace/patentSignals.ts`（纯函数 + 可注入 fs）：

```
patent 域可见 ⟺ 任一成立（顺序即优先级）：
  1. sati.yaml: tools.patentDomain === true|false        （显式，最高优先）
  2. sati.yaml 存在 patents: 段                          （机器级显式专利意图）
  3. <projectRoot>/.sati/rules.yaml 含专利规则包引用
  4. <projectRoot>/.sati/skills/ 下存在 patent-* / provision-* / drafting-* 技能
  5. 工作区存在专利产物：<projectRoot>/{data/cases/**, .sati/figures*, .sati/documents}
  6. 该工作区历史 transcript 中出现过 `patent_` 前缀工具调用（保守判据，带缓存 + mtime 失效）
  否则 → false（默认隐藏 patent 域 + 专利技能/角色清单条目）
```

设计原则：**判据宁可判成专利**（误判为专利只多花 13.7k token；误判为非专利用户会整片失去能力面，且 32/32 角色都含 patent 域）。

### 3.2 构件②：字段与接线

| 落点 | 改动 |
|---|---|
| `src/pilot/config/types.ts:255-266` | `PilotToolsConfig` 增 `patentDomain?: boolean`（缺省 = 自动判据） |
| `src/pilot/config/parseToolsConfig.ts:56-70, 101-109` | 解析新字段 + 补 `TOOLS_KNOWN_FIELDS`（漏加走未知字段告警） |
| `src/pilot/config/optionalFeature.ts` | 新增 `resolvePatentDomainEnabled(config, signals)`（显式优先，否则判据） |
| `src/cli/projectRuntimeFactory.ts:388-424` | 裁剪点合并「显式配置 + 判据推导」；**判据推导出的隐藏不得触发 unmatched-domain warn**；`projectRoot` 在 `:69` 已可得 |
| 技能/角色清单 | 用同一判据过滤 `PromptAssembler` 的 `formatSkills` / `formatRoles`（非专利工作区不列专利技能与角色，−3,741） |
| 热重载 | 判据基于文件/transcript，无失效钩子 ⇒ 记入 runtime 缓存并在配置 reload 时重算；文档写明「工作区变成专利项目后需重启或改配置生效」 |

### 3.3 构件③：迁移守卫

`ui/server/services/satiConfig.js:121-136` `normalizeSatiConfig` 增遗留守卫（先例 `docs/notes/implemented/2026-09-16-optional-feature-defaults.md`）：读取→保存往返时把 `tools.patentDomain` **物化为该工作区当前判定值**，避免用户任何一次保存把默认判据冻结成错误值。UI 侧判据副本（`ui/src/components/settings/shared/utils/`）必须与引擎同语义并配四态用例（先例：optionalFeature 双实现 + 面板用例）。

### 3.4 构件④：默认翻转与设置页入口

- 非专利工作区默认隐藏 patent 域 + 专利技能/角色清单条目 ⇒ 预期 **≈16.2k**（19,970 − 3,741），余量 ~3.8k（对 MCP/记忆等机器相关量有冗余）。
- **不默认关 kanban / team**：避免额外能力损失；余量已足够（Alternatives：`hiddenDomains+三组全关` = 17,006，收益 0.8k 而代价是两类工具对所有用户默认消失）。
- 设置页新增「专利能力」开关（i18n ×2 + 视觉验证），写 `tools.patentDomain`。
- 既有用户保护：判据第 6 条（历史用过 `patent_*`）使其保持现状；判据第 2 条覆盖配过 `patents:` 的机器。

### 3.5 构件⑤：inputSchema 有限瘦身（用户已确认）

- 范围：**只删与技能/顶层描述确实重复的段落**，保留「构造实参需要的约束」（如 `image_paths` 的"不做 OCR、图号靠文件名声明"）。
- 优先级：域裁剪后非专利工作区里仍常驻的工具优先——`grep`(248) / `ask_user_question`(243) / `todo_write`(122) / `agent`(147) / `web_fetch`；专利域工具的参数描述（TOP20 里 18 个在 patent 域）随域裁剪自动不生效，**不做无谓改动**。
- 预期收益：−1～2k，**专利工作区同样受益**。
- 契约成本：请求键含 `inputSchema` ⇒ **必须重录 fixture**。若重录不可行（无 key / 网络 / 成本），本构件**单独回退为不动 inputSchema**，验收主线（§3.4 ≈16.2k）不受影响——这是本构件与验收标准的解耦设计。
- 负控制：确认「顶层描述改动不需要重录、参数描述改动必须重录」两条各一次。

### 3.6 构件⑥：钉死验收测量口径 + 修 tokenizer 冷启动缺陷

- 口径（写进测试与 issue 结论）：`createLocalGateway({__testModelFactory})` + **空 pilotHome**（模拟全新安装，无 MCP）+ `submitTurn` 一次 + `countTokens` 精确分段；同时报告开发机口径（含 MCP 2,442）作对照。
- 修 §1.6 的 tokenizer 缺陷：病态样本启发式改为**首次强制精确编码**（或按字符长度而非墙钟判定），使冷启动不再低估；补一条冷进程首调即长文本的回归用例。
- 把 issue 评论里的手工测量口径固化为仓库内可跑的东西，使「固定开销」成为可回归的数字。

### 3.7 回归面与预期红

| 面 | 事实 | 处置 |
|---|---|---|
| `tests/gateway/tool-surface-config.spec.ts:81-90` | 「默认面与空 `tools` 段一致 + 默认含 `patent_search`」的回归锁，翻转即红 | 按新语义改写 + 新增判据用例（显式 true/false/缺省三态 + 各信号） |
| llm-replay fixture | 网关层翻转折**不碰** fixture（§1.4） | 无需重录；`pnpm record:replay` 复跑确认 |
| `check:event-matrix` | 域裁剪/提示词/工具面不动 AgentEvent | 无需生成；跑一次确认 fresh |
| `check:techdebt-metrics` | `metrics.md:79` 已登记 `createProjectRuntimeResolver` 393 行 | 同 PR `pnpm measure:update` |
| 角色/子代理 | 32/32 角色含 patent 域，项目级隐藏对三者一致生效 | 判据保守 + 设置页开关可恢复；文档写明代价 |

## 4. #159 实施方案：五波拆分（全部做完并关闭）

排序原则：**风险 ∝ 测试盲区 × 行为面宽度，与行数无关**。逐 token 证明的基线一律取**上一个提交**（分批提交会让 HEAD 漂移）。

### 4.1 第 0 波 · N15 类型收敛（S，零风险，无需浏览器）

7 处本地 `type DiffLine` + `ToolResultBlock.tsx:60` 内联匿名结构 → 从权威 `chat/utils/messageTransforms.ts` `import type`；保留权威版窄类型（**不要**按台账建议放宽为 `string`：`calculateDiff` 三个 push 点全是字面量，运行时值域本就等于窄类型，全仓只有 `ToolDiffViewer.tsx:82/87/91` 消费 `.type`）。净删 ≈14 行。
验收：`cd ui && pnpm typecheck` + 4 个传 `createDiff` 的测试文件全绿；负控制 1 处。

### 4.2 第 1 波 · ImportFromFolder（S→M，低风险）

顺序：`ValidationPanel`(754–824，71 行、3 props、零依赖) → `useImportValidation` + `useImportSlug` → **先补盲区测试** → 再拆 `handleFolderSelected` / `submit` / batch。
两族共用 6 个状态（`validation`/`validating`/`errorText`/`scope`/`force`/`slug`）是必须先决策的粘合点（沿用 #460「scope/force 归父级」口径）。
验收：688 → ≈120 行；新增 ≥8 条；负控制 ≥3 处。
风险：「早退前清错」顺序（`:132` 的 `setErrorText(null)` 在 early-return 之前）、`:536` 的 `@ts-expect-error webkitdirectory` 与 `:534-535` `// SAFETY:` 必须整段带走、`handleFolderSelected` 是 async 事件回调**不要顺手改成 .catch()**。

### 4.3 第 2 波 · N08 文件级拆分（M，低-中风险）

**它不是 god function**，按内聚拆：`utils/fileType.ts`(69–151) → Atoms(117–134 + 590–631) → `SpreadsheetPreview`(812–1148，225 行) → Office 面(1149–1373) → **最后**才合并 5 个资源 hook（335 行，骨架同构但**取消机制三类不同**：闭包 `cancelled` / `AbortController`+preflight drain / ref）。
验收：1510 → ≈150；新增 ≥12 条打取消语义盲区；负控制 ≥4 处。
风险：**不改 `:30-32` 的 `lazy()` 为静态 import**（会改 chunk 切分，门禁抓不到）。

### 4.4 第 3 波 · N02 存储层拆分（M，中风险）

**绝不在 `useSessionStore()` 内调子 hook**（各自 `useRef(new Map())` ⇒ 4 份 store ⇒ 28 个方法静默全坏、不报错、现有测试抓不到）。采用**方案 B**：保留单闭包组装，只把 33 个 `useCallback` 的 body 外化为纯函数；先外置模块级纯函数区（已有 24 条直测兜底）。
验收：728 → ≈150；**新增 ≥10 条 `renderHook(useSessionStore)`**（主闭包现为零覆盖）；`as unknown as` 计数必须仍为 29；负控制 ≥3 处（含 `:1176-1179`「Patch merged BEFORE mutating existing」顺序）。

### 4.5 第 4 波 · N07 剩余（L，高风险，专项窗口）

顺序：视口 hook(≈180) → 滚动 hook(≈125) → **选区 hook 取 190 行而非 235 行** → `usePdfToolbarController` + `PdfToolbar`（41 个符号收成 1 个控制器对象）→ `PdfNavigationSidebar`。
验收：1064 → ≈200；新增 ≥14 条；**头号负控制：把视口 hook 的调用点挪到那五个同步 effect 之前必须报红**（`:791-792` 读 `viewStateRef` 做快照，`:753-769` 写它；顺序错了会晚一帧 ⇒ 切文件时视口/页码恢复到上一个文件的位置，jsdom 抓不到）。

### 4.6 第 5 波 · 台账回填与决策记录

`pnpm measure:update` + `docs/technical-debt/backlog.md` 更正：N07 位置 `:723`→`:660` 与「选区 190 行」口径；**N08 标题重述**（非 god function，位置 `:1386`→`:1374`）；**N02 标注两处主张已失效**（2026-09-02 已修，位置 `:632` 指错）；N15 done + 8 处位置刷新；UI-APP-N01 剩余段更新。每波一条 `docs/notes/implemented/` 且含 `## Alternatives considered`。

### 4.7 验证矩阵（沿用既有先例）

- 门禁：`pnpm check`（含 ui typecheck）+ `cd ui && pnpm test` + `pnpm test`（后端）。
- 浏览器：真实 `pnpm dev`（5173/3001/19789），桌面 **1440×900**（#457 先例）或 **1280×800**（#460 先例）+ 移动 **390×844**；双主题 + 双语言 + 状态覆盖。
- **本环境 `Page.captureScreenshot` CDP 超时**（三份 note 一致记录）⇒ 视觉证据用 **main↔分支 A/B DOM 指纹逐字节相同**（#460 配方）并在 PR 显式说明——既有先例，不会被 review 打回。
- 逐 token 搬迁证明 + 负控制（必须报出"哪条用例因此变红"）是既有惯例，非可选。

## 5. 执行批次与交付

| 批次 | 内容 | 独立验收 | 建议提交信息 |
|---|---|---|---|
| P1 | §2.1–2.2 探测层 + 观测回写 + 引擎测试 | 集成用例：分母取自探测/观测值 | `feat(model): 窗口探测与观测回写` |
| P2 | §2.3–2.4 来源可见 + 采纳入口 + 只读 API + i18n | 浏览器验证（双主题/双语言）+ 单测 | `feat(ui): 生效窗口来源与采纳入口` |
| P3 | §3.1–3.4 判据 + 默认翻转 + 迁移守卫 + 清单裁剪 | ≤20k 实测 + 三态用例 + 守卫用例 | `feat(agent): 非专利工作区默认裁剪 patent 域` |
| P4 | §3.5–3.6 inputSchema 有限瘦身 + 重录 + tokenizer 修复 + 测量固化 | `record:replay` 绿、冷启动用例、测量数字 | `perf(tool): 参数描述瘦身与测量修正` |
| P5 | §4.1–4.2 N15 + ImportFromFolder | typecheck + vitest + 双视口 | `refactor(ui): skills 导入拆分与 DiffLine 收敛` |
| P6 | §4.3–4.4 N08 + N02 | 上述 + `measure:update` | `refactor(ui): 二进制预览与会话 store 拆分` |
| P7 | §4.5 N07 剩余 | 含顺序不变式守卫 + 双视口 | `refactor(ui): PDF 预览剩余拆分` |
| P8 | §4.6 + 议题关闭（结论 + note 链接） | 议题逐条对照 + `pnpm check` 绿 | `docs: 台账回填与议题结论` |

流程：main 受保护 ⇒ 每批次分支 + PR（Conventional Commits，git hook 强制）；提交前跑 `pnpm check`；不得 `--no-verify`。

## 6. 风险与未决项

1. **探测覆盖不完整**：标准 OpenAI 形状 / xAI / 未扩展自建中转站拿不到窗口 ⇒ 依赖构件②（超限观测）+ 构件④（用户确认），且「首次显示即准确」做不到（除非把 `parseModelConfig` 异步化，代价过大，不做）。
2. **判据误判**：判为非专利会裁掉专利角色工具（32/32 角色含 patent 域）。缓解：判据保守（第 6 条历史痕迹）、显式字段最高优先、设置页开关可恢复、裁剪时留 warn 日志。
3. **重录 fixture**：需真 key + 真调用；失败则 §3.5 单独回退（不影响验收主线）。
4. **#159 浏览器验证成本**：四项都需真实栈 + 双视口；已按风险排序，N07 单独成窗口（`ui-god-hook-unblock.md:53` 明确否决「一次性大爆炸」）。
5. **指标门禁漂移**：任何行数变化都要 `pnpm measure:update`（否则 `pnpm check` 红，设计使然）。
6. 未决：`minimax` 的 `defaultUrl` 两边不一致（UI `api.minimaxi.com` / 引擎 `api.minimax.io`）——产品判断，本方案不改，保持台账待定项。

## 7. 议题关闭清单（全部批次落地后执行）

- #449：关闭语 = 三条验收逐条对照（第 1、2 条 #454/#455；第 3 条由探测/观测/确认三路达成）+ note 链接；说明「探测不可得时的兜底行为」。
- #450：关闭语 = ≤20k 的实测数字与环境口径 + 默认翻转的迁移守卫说明 + `record:replay` / `event-matrix` 结论；注明专利工作区固定开销与未动 inputSchema 的取舍。
- #159：关闭语 = 五波结果 + 台账更正 + 剩余（若 N07 未及完成则如实标注并保留 open）。

## 8. 决策与备选

- **#449 走探测 + 观测 + 确认，不改大协议默认值**：改大默认会把所有命中 openai 默认的模型（含真实 128k 的 GPT-4o/DeepSeek）压缩线从 ~102k 推到 ~160k，把失败推迟到真实超限点，而跨进程兜底只有瞬态降级——既有决策已否决，理由今天仍成立。
- **#450 用判据 + 迁移守卫翻转，而非保持默认**：保持默认无法达成 ≤20k；翻转配守卫可让既有专利用户保持现状。
- **#450 不默认关 kanban / team**：`hiddenDomains:[patent] + 清单裁剪` 已得 ≈16.2k（余量 3.8k），再关 kanban/team 只增加能力损失与守卫面积（Alternatives：1+2 = 17,006，收益 0.8k 而代价是两类工具对所有用户默认消失）。
- **#450 有界瘦身 inputSchema**：与验收主线解耦，重录失败可单独回退；不做「全量瘦身到 19k」（参数约束外移会损实参构造正确率，且上限只有 6.8k）。
- **#159 按风险排序而非行数**：N15 → ImportFromFolder → N08 → N02 → N07；拒绝「一次性大爆炸」（既有决策否决）。
