# Agent Note: 桌面端变慢削峰——列表零构建、自检去重、检索超时显式化

Status: implemented

## Problem

桌面端「启动/首屏慢、对话响应慢」由三股风暴串联构成（本机 22–23 个工作区）：

**列表风暴（首屏主因）**：`GET /api/projects` 是侧栏首屏的阻塞请求，串行对每个工作区调 `gateway.listSessions` → `ProjectRuntimeRegistry` 先 `resolve()` 全量装配项目运行时（loadPilotConfig、ModelRuntime、PluginRuntime 技能扫描、全部内置工具注册表、知识库解析器）只为拿 `{projectRoot, pilotHome}` 两个字段去列会话目录。实测首屏墙钟 3.7–5.4s，其中列表串行 ≈2.3s、运行时装配合计 ≈2.2s（23 次构建）。

**自检风暴**：每个项目运行时装配各 fire-and-forget 一次 embedding 一致性自检，启动瞬间 N 个并发请求打向同一 oMLX 端点。oMLX 为严格串行 FIFO（≈152ms/批），23 并发仅空载就占队头 ≈3.5s；机器负载期排队升级为 30s 超时（生产日志每次启动 9–13 条「一致性自检失败」）。用户启动后第一批对话的检索排在自检队尾等。

**检索超时风暴**：检索链路内层 embedding/rerank 请求默认 30s 超时；`memory.retrievalTimeoutMs: 8000` 只限外圈「停止等待」，oMLX 拥塞时每个请求逐个等满 30s 才降级（生产日志 rerank 超时 850 次）——对话响应慢的直接来源。

且首屏耗时无按项目粒度的数据面，复盘只能靠猜。

## Decision

**列表路径零构建**：`ProjectRuntimeRegistry.listSessions` 不再 `resolve()`，直接 `listProjectSessions({ projectRoot, pilotHome, limit, offset })` 读磁盘会话（cursor 即 offset 数字串，满页才发 nextCursor）。运行时按需构建——首个会话创建时（`prepareSessionRuntime → resolve`）。`onProjectActivated`（extensionWatchManager.watchProject）随之从「列表」推迟到「开聊」：列表本身不需要扩展监听。

**自检进程内去重 + 短超时**：`checkEmbeddingConsistencyOnce` 以 `${dbPath}\0${endpointKey}` 为键做 module-level Promise 去重——首调用发真实请求、其余（同库同端点）共享同一 Promise；成功/失败都缓存（负缓存：拥塞期不重试，避免再次打满队列，下个进程自然重试）。调用点移入 `setTimeout(0)`（其首个 await 前有同步采样 SQL，直接调用会阻塞 listen）；单次超时 30s → `DEFAULT_SELF_CHECK_TIMEOUT_MS = 5s`，拥塞时快速跳过而不是排队。

**检索超时显式配置**：`~/.sati/sati.yaml` 显式配 `memory.embedding.timeoutMs: 8000`、`memory.embedding.rerank.timeoutMs: 5000`（均 ≤ `retrievalTimeoutMs: 8000`）。代码默认值保持 30s——不替所有用户改变默认行为。

**观测面**：`getProjects` 每次落一行可 grep 的 metrics（`[projects] getProjects: N projects in Xms (listSessions Xms; slowest top3)`）；`projectRuntimeFactory` 落 `project runtime built for ... in Xms` debug 行（SATI_DEBUG=1 可见），下次变慢可直接定位 top 项目与墙钟分布。

## Alternatives considered

- **保留预建、只限最近活跃 N 项目（保守方案）** —— 风暴从 N 倍降到 K 倍但仍随项目数增长，且引入「挑哪 K 个 + 何时补建 + 缓存淘汰」三份新复杂度；轻量化后列表路径根本不构建，代价仅为首次开聊现场付一次构建。选简单彻底的。
- **后台预热全部（移出阻塞路径但保留全量构建）** —— N 次全量装配照样打满 CPU 与端点（只是挪到后台），用户第一次开聊会撞上预热资源竞争，体验反而不可预测；弃。
- **自检全局单次（不带 dbPath/endpoint 维度）** —— 不同项目可能指向不同 knowledge.db 或不同 embedding 端点，全局单次会漏检；选二维键。
- **自检失败不缓存（保留重试）** —— 拥塞期重试恰恰是「再次打满队列」的机制；选负缓存。
- **删掉自检（只留手动命令）** —— 自检是「模型与库向量不一致 → 语义召回降级」的唯一探测手段，删掉等于静默失去降级信号；保留但削峰。
- **只降超时不降并发（5s 但仍 N 并发）** —— 23 并发 × 5s 依旧打满串行队列；去重才是根治，短超时只是兜底。
- **改代码默认超时 30s → 8s** —— 对所有用户改默认行为，慢端点场景可能造成误伤降级；选配置化 + 本机显式。

## Consequences

- **换来**：首屏 `GET /api/projects` 不再随项目数放大（列表路径零构建）；启动瞬间自检从 N 次降为 1 次调度 + N-1 次去重命中；检索路径拥塞时 8s/5s 内降级而非 30s；慢场景复盘有 metrics/debug 数据面。
- **付出**：首次在某项目开聊时现场付一次运行时构建（原在启动批次预付）；onProjectActivated 时点从列表推迟到开聊；自检负缓存意味着单进程内失败不再重试（下个进程恢复）；`memory.embedding(.rerank).timeoutMs` 成为需维护的配置项。
- 交叉引用源码：`src/cli/ProjectRuntimeRegistry.ts`、`src/knowledge/shared/embedding-consistency.ts`、`src/knowledge/assemble.ts`、`src/model/embedding/client.ts`、`ui/server/projects.js`。
