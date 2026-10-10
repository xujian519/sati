# 降级基线盘点（degradation baseline inventory）

> **用途**：`docs/degradation-registry-plan.md` 的 T2 对账基线、T5 深挖输入、`registry.yaml` 录入来源。
> **来源**：2026-10-10 explorer 全仓静态盘点（@ HEAD）+ oracle 评审复核修订（S01/D2 事实链、T01 宿主接线、A02 测试锁三处已订正）。
> **口径**：按「依赖行为单元」逐行展开，共 **40 行已盘点 + 6 项待深挖**。原盘点报告摘要口径为「约 37 项」，差异源于同族工具捆绑与计数口径（少数行捆绑同族工具，如 N04）；T2 对账以本表为准，**不设分布目标值**，分布由 `check-degradation-registry.mjs --stats` 输出为准。
> **标记**：✅ 已确认（有代码/测试证据）｜⚠️ 模式推断（同族工具未逐一复核）｜🔍 待深挖（见文末清单）
> **注意**：本表为静态快照，可能随 HEAD 漂移；T2 对账时以脚本硬校验（component 路径存在）兜底。

---

## 一、模型层（8）

| ID | 依赖 | 调用位置 | 失败行为（现状） | 谁漏了什么 | 可观测性 | 测试证据 | 建议归类 | 标记 |
|---|---|---|---|---|---|---|---|---|
| DEG-M01 | Router fallback 链（跨 provider/model） | `src/router/fallback/runFallbackChain.ts`、`execution/executeRouterDecision.ts` | 逐 attempt 换 fallback 目标（fail-open）；**一旦吐过内容事件即不再 fallback**（:58 关键不变量） | 已产出部分内容可能停在残片；用户见重试事件 | fallbackTier 事件打点 | `tests/router/fallback/runFallbackChain.spec.ts`、`router-runtime-execute.spec.ts` | open（执行前） | ✅ |
| DEG-M02 | Provider 健康熔断器 | `src/router/health/ProviderHealthTracker.ts:20-27,88-103` | healthy→degraded→open→half_open 状态机；连续失败降级候选 | 熔断期间该 provider 不参与路由（用户无感知靠事件） | 事件有 fallbackTier 打点 | **无独立 spec**（`tests/router/health/` 不存在；「open 跳过候选」实为 router 行为 `executeRouterDecision.ts:350-356`，亦零覆盖） | open | ✅ |
| DEG-M03 | Zero-usage retry / retry gates | `src/router/retry/retryGates.ts`、`execution/streamAttempt.ts` | 无产出内容时可重试；有产出不重试（避免重复文本） | — | 重试事件 | `tests/router/retry/zeroUsageRetry.spec.ts`、`retry-gates.spec.ts` | open | ✅ |
| DEG-M04 | tokenSaver 判官（judge LLM） | `src/router/tokenSaver/classifyAndRoute.ts:167,194` | judge 失败/超 40K → 降级默认 tier（`resolvedFrom: "fallback"`） | 该轮无 tokenSaver 节省，按默认 tier 计费 | `resolvedFrom` 标记 | `tests/router/router-runtime-token-saver-failure.spec.ts` | open | ✅ |
| DEG-M05 | 多模态重路由 | `src/router/media/rerouteDecisionForMedia.ts`、`utils/mediaReroute.ts` | 不支持图/PDF/音频 → 换支持候选重发；无候选 → `ModelRequestError("unsupported_modality")` | 无候选时模型明确报错，不静默丢媒体 | 结构化错误 | `tests/router/utils/mediaReroute.spec.ts`、`mediaRequirements.spec.ts` | open | ✅ |
| DEG-M06 | Ollama 模型探测 | `src/model/ollama/probe.ts:38,111,155` | probe 失败 catch → 空/缓存模型列表，后台异步刷新 | Ollama 模型列表可能缺失（至下次 probe 成功） | 未确认 | 未确认独立 spec | open | ✅ |
| DEG-M07 | Embedding 客户端（memory.embedding） | `src/model/embedding/resolve.ts:31-55` | 配置错误 → 返回 undefined + warning 诊断（`recoverable: true`）；「语义检索是可选增强，keyword 路径原样工作」 | 失去语义召回，关键词检索保留 | warning 诊断 | `tests/model/embedding/resolve.spec.ts`、`client.spec.ts` | open | ✅ |
| DEG-M08 | Providers（anthropic/google/openai/openai-responses） | `src/model/providers/…`（如 `openai-responses/response.ts:94-101`、`stream.ts:209-217`） | 统一包装 `ModelProviderError` 上抛，由 router fallback/retry 接管 | — | 结构化错误 | `tests/model/streaming/streamModelRetry.spec.ts`、`retry-scope.spec.ts` | closed（原始错误） | ✅ |

## 二、知识底座（8）

| ID | 依赖 | 调用位置 | 失败行为（现状） | 谁漏了什么 | 可观测性 | 测试证据 | 建议归类 | 标记 |
|---|---|---|---|---|---|---|---|---|
| DEG-K01 | 知识库 DB 文件缺失（5 类路径探测） | `src/knowledge/config.ts:50-80`、`assemble.ts:61-258` | 缺失 → 该源不建 resolver；打开失败逐源 try/catch「单个失败不影响其他」（头注释 :6-8） | 缺哪个源漏哪个源的召回 | warn 日志 | `tests/knowledge/memory-providers.test.ts`、`kg-store-knowledge-db.spec.ts` | open | ✅ |
| DEG-K02 | DB schema 版本不匹配 | `src/knowledge/shared/db-version.ts:84-152`（:145-152 derived→needsRebuild） | version > 程序 → throw `KnowledgeDbVersionError`；真源旧版本 → throw；**派生库旧版本 → `needsRebuild: true` 放行重建**；version=0 宽容补戳 | 派生库重建期间该源不可用 | warn（`assemble.ts:78` 等） | `tests/knowledge/db-version.spec.ts` | **mixed**：真源 closed / 派生 open | ✅ |
| DEG-K03 | FTS5 不可用/未编译 | `src/knowledge/legal/legal-search.ts:78-97` | prepare 抛错 → `ftsDegraded=true` 降级 LIKE（构造期完成） | 失去 BM25 排序，LIKE 结果质量下降 | `ftsDegraded` 标记 | `tests/knowledge/legal-search-fts-degrade.spec.ts` | open | ✅ |
| DEG-K04 | FTS→LIKE 查询期回退 | `src/knowledge/shared/fts.ts:19-82`（`runFtsThenLikeFallback`） | FTS 查询失败回退 LIKE；短查询直接 LIKE | 同上 | 同上 | `tests/knowledge/shared/fts-then-like.spec.ts` | open | ✅ |
| DEG-K05 | int8 向量索引（vectors.db / knowledge.db embeddings） | `src/knowledge/assemble.ts:68-94`、`shared/knowledge-embeddings.ts:227-240` | 打开/版本失败 → warn + 跳过语义路；异步预热失败吞错返回空矩阵（重置单飞） | 语义召回静默缺失，仅剩关键词路 | warn 日志 | `tests/knowledge/vector-db.spec.ts`、`embeddings-async-load.spec.ts`、`embedding-consistency.spec.ts` | open | ✅ |
| DEG-K06 | case-law DB（判例全文检索） | `src/knowledge/case-law/case-law-search.ts:246-493` | 多处分段 catch：FTS chunks 失败回退、semantic source 失败跳过该段 | 部分段落召回缺失 | 未逐段确认 | `tests/knowledge/case-law-search.spec.ts` | open | ✅ |
| DEG-K07 | 知识检索熔断器 | `src/knowledge/shared/circuit-breaker.ts:101-105` | 熔断后跳过该路径 | — | 熔断状态 | `tests/knowledge/circuit-breaker.spec.ts` | open | ✅ |
| DEG-K08 | 组合 resolver（跨源聚合） | `src/knowledge/shared/composite-memory-resolver.ts:34-62` | 单 resolver 失败 catch → 转 diagnostics 错误项返回，其他源结果保留 | 失败源条目缺失但诊断可见 | diagnostics | `tests/knowledge/composite-memory-resolver.test.ts` | open | ✅ |

## 三、LLM 重放（1）

| ID | 依赖 | 调用位置 | 失败行为（现状） | 谁漏了什么 | 可观测性 | 测试证据 | 建议归类 | 标记 |
|---|---|---|---|---|---|---|---|---|
| DEG-R01 | llm-replay（NO_REPLAY_RECORD / assertAllConsumed） | `src/test-support/llm-replay/replay.ts:72,109-113` | 测试态无录制 → **抛 NO_REPLAY_RECORD**（绝不穿透真网）；`assertAllConsumed` 抓欠驱动测试 | 测试失败即暴露（防静默混过） | 抛错 | `tests/test-support/llm-replay.spec.ts` 等 | closed | ✅ |

## 四、网络类工具（8）

| ID | 依赖 | 调用位置 | 失败行为（现状） | 谁漏了什么 | 可观测性 | 测试证据 | 建议归类 | 标记 |
|---|---|---|---|---|---|---|---|---|
| DEG-N01 | patent_search（Google Patents） | `src/tool/builtin/patentSearch.ts:113,127` | 网络失败**报错**；真零结果返回空 hits + warnings；LRU 缓存命中不打外网 | 模型拿明确错误可重试 | 结构化错误/warnings | `tests/tool/builtin/patentSearch.spec.ts` | **mixed**：网络错 closed / 零结果 open | ✅ |
| DEG-N02 | patent_pdf_download（浏览器 + fetch 兜底） | `src/tool/builtin/patent-pdf-download/fetchFallback.ts:53-82`、`execute.ts` | 条目级降级：浏览器拦截 → fetch 兜底（60s、重试 3）；403/404/魔数错=确定性失败不重试；failed 条目保留 pdfUrl；落盘 .tmp→原子 rename | 单篇失败不拖垮批次，failed 条目漏该篇 | 条目级 failed 标记 | `tests/tool/builtin/patentPdfDownload.spec.ts` | open（条目级） | ✅ |
| DEG-N03 | patent_metadata（按号点查） | `src/tool/builtin/patentMetadata.ts:61-86,114` | 「不存在」→ 数据 `success:false`（区分「不存在」与「出错」）；网络/超时/执行错 → 抛 `SatiToolRuntimeError` | 网络错有 errorCode 可判 | errorCode | `tests/tool/builtin/patentMetadata.spec.ts` | **mixed**：not-found open / 网络错 closed | ✅ |
| DEG-N04 | patent_legal_status 等其余专利域网络工具 | `src/tool/builtin/patentLegalStatus.ts` 等（nuo-patent 族） | 与 metadata 同模式（未逐一展开） | — | — | `tests/tool/builtin/patentLegalStatus.spec.ts` 存在 | mixed（模式推断） | ⚠️ |
| DEG-N05 | web_fetch | `src/tool/builtin/webFetch.ts:88-99,293-320`、`web/urlFetcher.ts:176-180` | HTTP 错 → 结构化错误含可行动指导；allowlist 拦截 → `EGRESS_BLOCKED`；abort 原样传播 | — | 结构化错误 | **无独立 spec**（仅间接引用） | closed | ✅ |
| DEG-N06 | web_search | `src/tool/builtin/webSearch.ts`、`webSearchPerformers.ts` | 失败抛错（同族模式） | — | — | `tests/tool/builtin/webSearch.spec.ts` | closed（推断） | ⚠️ |
| DEG-N07 | paper_search（arXiv/OpenAlex/Semantic Scholar/Crossref） | `src/literature/tool/paperSearch.ts:131-145` | **「源错误 ≠ 无结果」**：抛结构化错误 + rate-limit 指导，不返回空结果 | 模型明确知道是源故障 | 结构化错误 | `tests/literature/tool/paperSearch.spec.ts` + 4 connector spec | closed | ✅ |
| DEG-N08 | networkFetch（统一 fetch + 代理） | `src/network/index.ts` | 指数退避重试（1s×2，最多 3 次）；408/409/425/429/5xx 与网络错可重试；代理回退 | — | — | `tests/network/fetch.spec.ts`、`proxyFallback.spec.ts` | open（重试层） | ✅ |

## 五、MCP（2）

| ID | 依赖 | 调用位置 | 失败行为（现状） | 谁漏了什么 | 可观测性 | 测试证据 | 建议归类 | 标记 |
|---|---|---|---|---|---|---|---|---|
| DEG-P01 | MCP server 连接/握手/调用 | `src/mcp/runtime/McpRuntime.ts:45-74`、`client/connection.ts:88-101,132-161,216-227` | 每 server 独立 catch，单 server 失败置 `status:"error"` 不中止其他；握手 10s 超时 → `mcp_handshake_failed`；callTool 超时 → `mcp_call_timeout` + 自动重连一次 | 坏 server 工具不可用，其余不受影响 | `mcp_*` 错误码 | `tests/mcp/client/connection.spec.ts`、`errors.spec.ts`、`McpClient.spec.ts`、`McpRuntime.spec.ts` | open（按 server 隔离） | ✅ |
| DEG-P02 | MCP 资源/工具列表聚合 | `src/mcp/runtime/McpRuntime.ts:86-89` | 非 ready client 跳过；单 client listResources 失败 catch 跳过 | 该 server 资源不进聚合 | 同上 | 同上 | open | ✅ |

## 六、工具结果溢出（1）

| ID | 依赖 | 调用位置 | 失败行为（现状） | 谁漏了什么 | 可观测性 | 测试证据 | 建议归类 | 标记 |
|---|---|---|---|---|---|---|---|---|
| DEG-S01 | ToolResultBudget（spill 层） | `src/context/budget/ToolResultBudget.ts:199-205` | 超限 → 落盘 + 预览 + 取回提示；**落盘失败（writeFile 上抛）→ `DefaultContextRuntime.ts:429-453` 捕获：回退原始投影 + 产诊断 `tool_result_persistence_failed`（:444-450，全仓零消费）→ `AgentLoop.ts:859-874` 二重兜底**（原文不丢、turn 不失败） | 无（原文保留）；但诊断无人消费=事实静默点 | 诊断目前无消费者（T0-D2 决定补可观测） | `tests/tool/tool-result-size-limit.spec.ts`、`context/tool-result-reference-error.spec.ts` | open（D2 已拍板维持 + 补可观测） | ✅ |

## 七、会话恢复（1）

| ID | 依赖 | 调用位置 | 失败行为（现状） | 谁漏了什么 | 可观测性 | 测试证据 | 建议归类 | 标记 |
|---|---|---|---|---|---|---|---|---|
| DEG-T01 | TaskResumeScanner（跨进程断点续算） | `src/session/resume/TaskResumeScanner.ts:80-101`；宿主 `src/cli/ProjectRuntimeRegistry.ts:507-519` | 单会话失败 catch 仅计数不阻塞；**catch 体内无日志（注释推责宿主）；宿主编译：仅 resumed>0 记 info，:518 另有静默 `.catch(() => undefined)`；结果对象无 failed 字段**（类注释 59-60 称「失败仅计数」与实现不符） | 续算失败的会话漏掉且无可观测痕迹 | 无（T3a 修复） | `tests/session/resume/task-resume-scanner.spec.ts` | open；静默待修 | ✅ |

## 八、记忆（1）

| ID | 依赖 | 调用位置 | 失败行为（现状） | 谁漏了什么 | 可观测性 | 测试证据 | 建议归类 | 标记 |
|---|---|---|---|---|---|---|---|---|
| DEG-E01 | EdgeClawMemoryProvider.retrieve | `src/context/memory/EdgeClawMemoryProvider.ts:147-192` | abort/熔断 → 返回空结果（不缓存、不遥测，防陈旧结果）；inner 抛错 → telemetry + `memory_provider_error` diagnostics（降级 warning 不抛） | 该轮注入缺失，诊断可见 | diagnostics + telemetry | `tests/context/memory/edgeclaw-memory-provider.spec.ts`、`memory-attachment-builder.spec.ts` | open | ✅ |

## 九、UI / 桌面壳（2）

| ID | 依赖 | 调用位置 | 失败行为（现状） | 谁漏了什么 | 可观测性 | 测试证据 | 建议归类 | 标记 |
|---|---|---|---|---|---|---|---|---|
| DEG-U01 | ui/server sati-bridge（gateway WS） | `ui/server/sati-bridge.js:933-972,229-243` | gateway 不可用 → reset + `gateway_unavailable` status + userHint；流无 turn_completed → `gateway_stream_ended_without_completion` + userHint | 用户见可操作提示 | status + userHint | `ui/server/sati-bridge.test.js:310` | closed + 用户提示 | ✅ |
| DEG-U02 | Electron server-manager（gateway 子进程） | `apps/desktop/src/server-manager.ts:400-427,452-491` | 健康检查 60s 超时 → 错误对话框；crash → 自动重启（max-restarts 上限）；首启期不并发重启 | 超限后用户见错误对话框 | 对话框 + 日志 | `tests/desktop/server-manager.spec.ts` | closed + 自动重启 | ✅ |

## 十、子代理 / 团队（4）

| ID | 依赖 | 调用位置 | 失败行为（现状） | 谁漏了什么 | 可观测性 | 测试证据 | 建议归类 | 标记 |
|---|---|---|---|---|---|---|---|---|
| DEG-A01 | SubAgentSession（子代理失败传播） | `src/agent/sub/SubAgentSession.ts:149-152` | 子 agent turn 失败 → throw 传播为父 agent 的 tool error | 父 agent 收到明确错误 | 抛错 | `tests/agent/sub/SubAgentSession.spec.ts` | closed | ✅ |
| DEG-A02 | team worker-gate | `src/patent/team-worker-gate.ts:19-27` | 注释立规「fail-open 语义（实现方必须保持）：未注册 worker 或未登记角色一律 true」 | — | — | **已有测试锁**：`tests/patent/team-worker-gate.spec.ts:28-45` + `scheduler.spec.ts:672-684` | open | ✅ |
| DEG-A03 | team 失败任务转派 | `src/agent/team/taskpool/retry.ts`、`scheduler/scheduler.ts:187-192` | failed 未耗尽 maxAttempts → 重置 pending 重入池；迟到写校验 fail-closed；滞留任务 reclaim 失败仅记 error | 耗尽后停留 failed，事件可见 | 事件 + error 日志 | `tests/agent/team/member/stranded-tasks.spec.ts`、`member-scanner.spec.ts`、`mailbox/mailbox.spec.ts` | open（重试）+ 终态 closed | ✅ |
| DEG-A04 | agent 输入落盘（onFlushCheckpoint） | `src/agent/protocol/input.ts:45-49`（类型注释）；行为实体 `src/agent/loop/AgentLoop.ts:754-757`、`turn/TurnRunner.ts:358-360` | 注释立规「全部已接受条目落盘。失败即中止本步（fail-closed）」；行为实体未包 try，抛出即中止 | — | 抛错 | **无 spec**（T4 补） | closed | ✅ |

## 十一、其他（4）

| ID | 依赖 | 调用位置 | 失败行为（现状） | 谁漏了什么 | 可观测性 | 测试证据 | 建议归类 | 标记 |
|---|---|---|---|---|---|---|---|---|
| DEG-O01 | Telemetry sender | `src/telemetry/sender.ts:86-171` | 上传失败入队；非法行跳过该条（注释「fail-open，遥测非关键路径」）；dropped 计数 | 单条遥测丢失，metrics 可见 | dropped 计数 | `tests/telemetry/contract-shape.spec.ts`、`logger.spec.ts`、`sanitize.spec.ts` | open | ✅ |
| DEG-O02 | TokenStatsCollector 异步落盘 | `src/router/stats/TokenStatsCollector.ts:246-266,269-283` | 注释「异步落盘失败：静默降级」；**真实吞错点 `writePayload` :254-266（回调忽略 err，异步失败全 resolve）；`drainSync:280` 同步失败丢缓冲；同文件 ≥9 处注释型 no-log catch** | 重启后该时段统计丢失 | 无（T3b 修复） | `tests/router/token-stats-collector.spec.ts` | open；静默待修 | ✅ |
| DEG-O03 | Auto-compact 失败回退截断 | `src/agent/loop/compactionExecutor.ts:99-120` | compact 失败 → warn + fallback truncate（`logFallbackTruncate`，reason=compaction_failed） | 上下文以截断代替摘要，质量下降但有日志 | warn 日志 | `tests/context/compaction-engine.spec.ts` | open | ✅ |
| DEG-O04 | scripts/ fetch 类（live smoke） | `scripts/smoke-llm-center-protocols.mjs:90,115,208` | 活体冒烟：请求失败直接 throw；必填 env 缺失即报错 | 冒烟失败即非零退出 | 非零退出 | `tests/scripts/`（未逐条核对） | closed | ✅ |

---

## 待深挖清单（T5 输入，6 项）

| # | 项 | 为什么待深挖 | 输出要求 |
|---|---|---|---|
| 1 | egoBrowser 工具失败行为 | `src/tool/builtin/egoBrowser.ts` 失败路径完全未盘点 | 补登记条目或书面豁免 |
| 2 | gateway 服务端 WebSocket 断连/重连语义 | 此前只盘 ui/server 桥侧（DEG-U01） | 同上 |
| 3 | edgeclaw-memory-core vendored 内部故障矩阵 | LLM extraction / dream / heartbeat 各路径降级/重试未展开（13+ spec 存在） | 同上 |
| 4 | SessionTitleGenerator / searchChatHistory | catch 行为未展开（疑似静默降级） | 同上 |
| 5 | `ui/server/websocket/chat.js` 重连策略 | 断连仅记日志（:507,540,563），无重连契约 | 同上 |
| 6 | scripts/ 其余 fetch 类脚本 | embedding-baseline、measure-assembly-stability 等未核对 | 同上 |

## 对账使用说明（T2）

1. 本表每行应产出 **1 条 registry 条目**（mixed 行按子语义拆多条），或一条带 `waiver.reason` 的豁免记录——三态（登记 / 豁免 / 待深挖占位）互斥且完备；
2. 对账表存 PR 描述：本表 ID ↔ registry id ↔ drill 路径或 waiver；
3. 分布统计不写死：以 `node scripts/check-degradation-registry.mjs --stats` 输出为准；
4. ⚠️ 两行（DEG-N04、DEG-N06）与待深挖 6 项在 T5 完成后必须升级为 ✅ 或书面豁免。
