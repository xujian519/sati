# Sati 性能卡点审计报告

> 审计日期：2026-07（本次提交）
> 方法：4 路并行静态扫描（数据层 / agent·工具·会话 / 网络·网关·后台 / 前端）→ 逐文件核实（文件:行号）→ 定向修复 → 构建与测试验证。
> 范围：仅分析 + 修复低风险高收益卡点；涉及数据迁移或协议语义的改动仅记录路线图。

## 总体结论

工程整体健康：SQLite 已启用 WAL、DDL 不在热路径、前端流式用 rAF 合并 + 消息虚拟化、重型依赖（Univer/pptx/xterm/pdf）已 lazy 加载。主要卡点集中在四类：

1. **SQLite 全表扫描 / 逐次 prepare**（数据层，每轮对话热路径）
2. **agent 每轮消息全量重算与重复排序**（agent/工具层，随轮次 O(n²) 退化）
3. **网关逐帧序列化 + broadcast O(N) 重复序列化**（协议层）
4. **首屏同步 JS 体积**（UI 层）

---

## 一、已修复（本次提交，A 类）

### 1. 白盒记忆 SQLite：索引补齐 + 热路径语句缓存
`src/context/memory/edgeclaw-memory-core/src/core/storage/sqlite.ts`

- **新增索引**（`init()` 中 `IF NOT EXISTS` 幂等，存量库升级自动生效）：
  - `idx_l0_sessions_time (timestamp DESC, created_at DESC)` — 服务 `listRecentL0`，消除**每轮对话**（`captureTurn` → `listRecentL0(1)`）的全表排序；
  - `idx_l0_sessions_session_time (session_key, timestamp, created_at)` — 服务 `getLatestL0Before`（heartbeat 每 session 调用）的过滤+排序。
- **prepare 缓存**：`getPipelineState`/`setPipelineState`/`deletePipelineState`/`insertL0Session`/`listUnindexedL0BySession`/`getLatestL0Before`/`listRecentL0`/`listAllL0`/`repairL0Sessions` 内两条语句共 10 条静态 SQL，改为构造时 prepare 一次、反复复用（`node:sqlite` 的 `prepare()` 无自动缓存，此前每次执行都重新编译）。

### 2. KG 关键词检索：多词 LIKE 合并 + 语句缓存
`src/knowledge/shared/kg-store.ts`

- `searchByKeywordOr` 原先对每个 LIKE 词条（上限 8）**各执行一次 116K 行全表扫描**；现合并为单次 `OR` 查询（`likeSearchTerms`，三列 × 词条，一次扫描）。
- `getNode`/`likeSearch`/FTS MATCH/`getNeighbors`/`listByType` 语句缓存。
- 无 FTS 表时不再构造时即崩（`stmtFtsSearch` 惰性为 null）。

### 3. 法律全文检索：语句缓存 + FTS 不可用提前降级 + 批量取回
`src/knowledge/legal/legal-search.ts`、`src/knowledge/legal/legal-memory-provider.ts`

- 基础（无 level/category 过滤）`searchLike`/`searchFts`/`searchFtsKeywords`/`findByName`/`getById`/`getCategories`/`count` 语句缓存；
- FTS 语句构造失败（捆绑旧版 Node 未编译 FTS5 等）时**提前降级 LIKE**，行为与原查询时 catch 降级等价；
- 新增 `getByIds(ids)` 批量 IN 查询；`LegalMemoryProvider.searchSemantic` 由循环 `getById`（≤6 次逐条 prepare+执行）改为一次批量取回 + JS 层同名去重。

### 4. 工具注册表：list() 排序缓存
`src/tool/registry/ToolRegistry.ts`

- `list()` 惰性构建 `sortedCache` 并返回同一数组引用（agent 每轮 `createModelRequest` 调用两次 + `filterAvailableTools`，原先每次 `[...values].sort()`）；`register`/`unregister`/`replace` 时失效。已核实全部调用方只读。

### 5. 工具名修复：索引进程内缓存
`src/tool/execution/repairToolName.ts`

- `buildToolNameIndex` 增加模块级 `WeakMap` 缓存（keyed by `tools` 数组引用，与 `list()` 稳定引用配合）；注册表变更自动失效。模型反复用近似名触发 fuzzy 修复时不再每次全量重建索引 + 全量 levenshtein。

### 6. transcript 写入：消除每事件 mkdir
`src/session/transcript/JsonlTranscriptWriter.ts`

- `recordEntry` 链内 `mkdir(dirname, {recursive})`（目录已存在也是 syscall）由每事件一次降为每写入器一次（`dirReady` 标志）。多工具 turn 数十次串行 appendFile 前不再重复 mkdir。

### 7. UI 首屏体积：EditorSidebar 懒加载 + 体积可见性
`ui/src/components/main-content/view/MainContent.tsx`、`ui/src/components/code-editor/view/EditorSidebar.tsx`、`ui/vite.config.js`

- `EditorSidebar`（CodeMirror 全家约 675KB）静态 import 改 `React.lazy` + `Suspense`，仅在用户打开编辑器时下载执行；
- `chunkSizeWarningLimit` 1000 → 500，让超大 chunk 在构建时可见。

### 8. 测试
- 新增 `tests/tool/registry/list-cache.spec.ts`（缓存同引用 / register·unregister·replace 失效 / 只读约定，5 例）；
- `tests/knowledge/legal-search.test.ts` 补 `getByIds` 批量一致性用例；
- `tests/knowledge/legal-memory-provider-semantic.spec.ts` stub engine 同步 `getByIds` 接口。

### 9. B 类跟进批次（第二轮修复）
- **cron 精确调度**（`src/cron/runtime/CronScheduler.ts`）：`computeDelayMs` 由固定 60s 轮询改为基于任务 `nextRunAt` 精确唤醒（空闲回退 60s）；超并发任务重查间隔 60s → 15s 减少积压。
- **vector 语料键集分页**（`src/knowledge/shared/vector-db.ts`）：首次加载 "kg" 语料（约 120MB）由 `LIMIT/OFFSET` 分页改为 `WHERE (doc_id, chunk_index) > (?, ?)` 键集分页，走主键前缀索引，消除大偏移重复扫描。
- **literature GET 缓存加固**（`src/literature/runtime/http.ts`）：缓存加 500 条容量上限 + LRU 淘汰（长时间分页检索不再无限增长）；缓存键并入 Accept，避免 `getText`/`getJSON` 内容协商结果互污染。
- **ui server dashboard 结果缓存**（`ui/server/sati-bridge.js`）：`/api/ccr/dashboard` 的 `loadPersistedStatsFromDisk` 加 5s TTL 缓存，前端 30s/15s 轮询不再每次 `readdirSync` 全盘扫描 + 逐行 parse。
- **删除死代码**：`ui/src/components/chat/hooks/streamSmoother.ts`（8.5KB `SmoothTextStream`）及其测试，全仓库无生产引用。
- **根级 ErrorBoundary**（`ui/src/components/app-shell/AppShellV2.tsx`）：AppShellV2 根壳（聊天主界面、各 tab、侧栏）最外层包裹 `react-error-boundary`，渲染异常不再整屏白屏。

### 10. 第三批（高/中收益 B 类跟进）

- **TokenAccounting 快速通道**（`src/context/budget/TokenAccountingRuntime.ts`）：预算评估先做本地 tiktoken 估算，≤ 可用窗口 × `nearLimitRatio`（默认 0.9）时直接返回 local 快照，**跳过每 turn 一次的 provider count_tokens 网络调用**（消息逐轮增长时每次全量序列化 + 网络往返）；逼近窗口才精确计数保证裁剪正确。新增 `tests/context/token-accounting-fastpath.spec.ts`（5 例）。
- **WorkflowEngine 并行度上限**（`src/workflow/runtime/WorkflowEngine.ts`）：`runLoop` 就绪步骤由无上限 `Promise.allSettled` 改为信号量式 worker 池（`maxParallel` 默认 4，可配置），防止大量独立步骤同时拉起 N 个 LLM 会话（成本/令牌放大）；settled 结果顺序与 skip/fail 终态语义不变。
- **patent 三路 extract 并行**（`src/patent/workflow.ts`）：`runWorkflow` 主循环重构（提取 `runStageOnce`/`pushResult`），连续无 retry 阶段进入并行窗口（上限 4）——披露管线 `extract_problem`/`extract_features`/`extract_effects`（不同 output_key 写 state 不同键）并行执行，理论 3 倍提速；回退边（`consistency→extract_problem`）重试语义保持（回退时重跑并行组）。
- **首屏 markdown/katex 按需渲染**（`ui/src/components/chat/view/subcomponents/Markdown.tsx`、`ui/src/main.jsx`、`MarkdownPreview.tsx`）：聊天 Markdown 的 remark-math/rehype-katex/katex.min.css 改为动态 import（内容含 `$` 才加载）；main.jsx 移除全量 katex CSS（改随动态 chunk 注入）；编辑器预览保留静态 katex（已在 lazy chunk 内不伤首屏）。**主 JS 1,665.60 → 1,048.52 kB，主 CSS 428,997 → 167.37 kB**。
- **网关发送合并**（`src/gateway/server/websocket.ts`、`GatewayWsConnection.ts`）：新增 `sendBatch`（多帧一次 `Buffer.concat`+`socket.write`，帧序列不变、客户端无感知、无需协议版本化）；`submit_turn` 事件流经 16ms 窗口缓冲合并，长轮次数千 text_delta 的 write/syscall 显著减少；循环结束立即冲刷保证 final 帧顺序。
- **KG FTS5 trigram 迁移脚本**（`scripts/migrate-kg-fts-trigram.mjs` + `kg-store.ts` 探测升级）：trigram tokenizer 对中文 3 字词直接命中（unicode61 下长短语 token 不匹配的短词场景），根治 H1 的 LIKE 降级；脚本含能力探测（FTS5/trigram 缺失明确报错，防桌面端旧 Node 误操作）、幂等回填、`--replace` 备份替换；kg-store 自动优先 `nodes_fts_trigram`。运行时不可用时仍安全降级 LIKE。
- **WebSocketContext latestMessage 短路**（`ui/src/contexts/WebSocketContext.tsx`）：高频流式增量事件（`text_delta`/`thinking_delta`/`tool_call_*`/`agent_status`）不再进 `latestMessage` state（已核实全部消费方只消费低频结构性事件：loading_progress/projects_updated/session-status/taskmaster-*），避免每条流式帧触发 AppShellV2 整树 re-render；流式渲染走 subscribe 通道不受影响。

### 验证证据
- `pnpm --filter edgeclaw-memory-core build` 通过；过滤工作区 WIP 文件后 `tsc --noEmit` 无错误；`pnpm lint` 0 errors；我的文件 `format:check` 0 问题。
- 相关测试：knowledge/tool 43/43、memory/transcript 38/38、cron 13/13、literature 16/16、vector-db 10/10、token-accounting 8/8、workflow 27/27、patent-workflow 34/34、gateway 15/15、UI 524/524（sati-bridge 集成测试受工作区 WIP 阻塞，stash 基线验证与本次改动无关）。
- UI 构建产物：主 JS `index` **2,298,229 B → 1,665.60 kB → 1,048.52 kB**（gzip 285.18 kB）；主 CSS **428,997 → 167.37 kB**；CodeMirror（EditorSidebar 1,251 kB）与 rehype-katex（267.86 kB）均为独立按需 chunk。

---

## 二、建议后续（B 类，未实施——涉及数据迁移 / 协议语义 / 较大改造）

### 数据层
- **`law.name` 数据侧索引（H2）**：`searchFts` 的 `JOIN law l ON l.name = law_fts.name` 若 `law.name` 无索引会退化为逐行探测；在 laws 库生成脚本中为 `law(name)` 建索引。
- **外部 workspace 连接缓存**：`readWorkspaceDirFromDb` 每次新开 `DatabaseSync` 连接（现有缓存仅命中已扫描过的 workspace，可把连接也缓存）。
- **KG trigram 后置项**：迁移脚本与探测已交付（见 §10），但 `--replace` 需在支持 FTS5/trigram 的 Node ≥22.14 环境执行；桌面端捆绑旧 Node 运行时仍走 LIKE 降级。

### agent / 工具 / 会话
- **`projectToolResults` 全量消息数组重建**：每轮工具结果落地 `[...input.messages, ...appendedMessages]` 全量复制，可改原地 push（loop 私有可变）。
- **`EdgeClawMemoryProvider.retrieve` 缓存**（✅ 已实现）：进程内 `TtlCache`（默认 30s，上限 256）+ `inFlightRetrieves` 并发去重（`src/context/memory/EdgeClawMemoryProvider.ts`），与 memory-core 内部 recall cache（`retrieval/reasoning-loop.ts`，现 ~828 行）对齐；多轮工具循环 query 不变时命中缓存，省去每轮 memory-gate LLM 调用与语义检索。
- **model/streaming `repairToolName`**：接收每次新建的 `Set`（`AgentLoop.repairTextExtractedToolNames` 每次 `new Set(list().map())`），无稳定引用可缓存；可改为在 AgentLoop 层缓存有效工具名集合。
- **审计落盘**：`ToolRuntime` 对每次工具调用 `await auditRecorder.recordTool`，若实现为同步写盘会阻塞；建议 fire-and-forget 或批量冲刷。
- **TokenAccounting 尾增量估算（次优后置）**：快速通道已消除每 turn 的 provider count 网络调用（见 §10）；若仍需进一步降低本地 tiktoken 全量 BPE 成本，可做“上轮 usage + 尾部增量估算”。

### 网络 / 网关 / 后台
- **broadcast O(N) 重复序列化**：`broadcastNotification` 每连接序列化同一 payload；可在 `GatewayServer` 层序列化一次后分发（低频事件，收益小）。
- **CronTaskStore 整文件写放大**：每次 put/update/delete 整文件重写（temp+rename）+ 全局串行队列；建议分片或状态内存化 + 定期 flush。
- **`appendRunEvent` 逐事件落盘**：cron/always-on 每个 GatewayEvent 一次磁盘 append；建议批缓冲。
- **ui server `/api/ccr/dashboard` 同步全盘扫描**：5s TTL 缓存已消除轮询重复扫描（见 §9）；如需实时反映可改 `fs/promises` 异步 + 变更失效。

### UI
- **巨型组件**：`SkillsV2.tsx`（97KB/约 2500 行，10+ 内联子组件无 memo）、`SidebarV2.tsx`（52KB，会话树无虚拟化/行级 memo）、`DashboardV2`（55KB）——拆分 + 行级 memo。
- **轮询**：会话 processing 期间每 1200ms `check-session-status`；可提至 2-3s 或事件驱动。

---

## 三、不采纳（C 类，设计使然）

- **heartbeat `markL0Indexed` 批处理**：逐 session 增量标记是 crash checkpoint 的有意设计（崩溃后只重放 in-flight session）；批量会破坏该语义。
- **`repairL0Sessions` 低频**：仅在修复命令中触发，语句缓存已覆盖其循环内 prepare 开销。

---

## 四、附注：工作区基线问题（与本报告改动无关）

执行期间发现工作区存在**未提交的进行中改动**（Always-On discovery-plan 接线），导致全量 `tsc --noEmit` 与 `biome check` 无法全绿：

- `src/gateway/protocol/types.ts` — `WebAlwaysOn*` 类型 re-export 目标缺失；
- `src/web/client/GatewayBrowserClient.ts` — 重连 API 参数数不匹配；
- `src/web/client/eventMapping.ts` — 新增事件类型（`model_request_started`/`context_budget` 等）未适配；
- `src/cli/sati.ts` — `Gateway.isSessionActive` 缺失；
- `tests/gateway/browser-client-reconnect.spec.ts` — lint warning（未用参数）；
- `ui/src/chat/gatewayEventAdapter.test.ts` ×2、`ui/src/utils/gatewayListPlans.test.ts` ×1 — 事件映射/Always-On 断言失败。

这些均属该 WIP 的连带问题，建议在 WIP 合入时一并修复，与本性能审计无交集。

> **跟进（2026-08-05）**：上述 WIP（Always-On discovery-plan 接线）已随 gateway 协议 1.1 合入（`ec921eac`），所列连带问题一并修复；本报告"已修复"清单全部保留有效。

---

## 五、代码审阅与修复记录（review 结论）

两轮独立审阅（代码质量 review + security review）后修复：

**阻塞（已修）**
- `legal-memory-provider.ts` 语义召回排序：`getByIds` 无 ORDER BY（DB 行序），改为批量取回后**按向量相似度 `hits` 顺序重排**再去重截断，恢复高相关法条优先。

**应修复（已修）**
- `kg-store.ts` FTS 探测：ftsTable 存在但运行时缺 FTS5/trigram 模块时构造器 `prepare(MATCH)` 崩溃 → try/catch 降级 LIKE（与 legal-search 能力探测一致），FTS 使用条件改判 `stmtFtsSearch !== null`。
- `patent/workflow.ts` 并行窗口：仅按 `retry === undefined` 划分会让审批门（approval-gate，handler 抛中断）与相邻阶段并行、破坏"审批门后不再执行"语义 → 并行条件收紧为**同 atom 且无 retry**（三路 extract 均 `atom:"extract"` 仍并行，审批门等保持串行）。
- `WorkflowEngine.ts`：`step_started` emit 移入 `runOneStep` 的 try 内（原在 worker 池中，emit 抛错会使 `results[i]` 未赋值导致后续 TypeError）。

**安全（已修）**
- `websocket.ts` 认证前内存 DoS：接收缓冲超过 16MB 单帧上限 + 帧头即 `socket.destroy()`（原实现可被恶意端声明超大 payload 撑爆内存）。

**Nit（已修）**
- `legal-search.ts` 合并冗余 FTS 语句（searchFts 与 searchFtsKeywords 共用一条 prepared statement）；`JsonlTranscriptWriter` appendFile 失败重置 `dirReady` 自愈；`GatewayWsConnection` 连接关闭时清理 flushTimer 与发送缓冲。

**审阅确认无问题**：ToolRegistry.list() 缓存数组全部调用方只读；sendBatch 帧序列与 final 帧时序不变；SQL LIKE 转义/IN 参数化/trigram 表名白名单无注入；TokenAccounting 快速通道 0.9 阈值有安全边际；vector-db/sqlite 键集分页与原 SQL 逐字一致；React 改动（lazy/type-only import/ErrorBoundary 嵌套）无渲染回归。

**安全审阅遗留（既有设计，未改）**：`handleHello` 的 token 比较非常量时间、WS 无 Origin 校验——本地 loopback 服务场景可接受，如需对外暴露需补；`readClientFrame` 掩码异或 O(payload) 认证前执行，已被 16MB 帧上限约束。
