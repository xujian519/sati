# 【WorkBuddy】Sati-performance-analysis.md 审阅报告

> 审阅对象：`/Users/xujian/Workbuddy/2026-08-17-21-11-53/Sati-performance-analysis.md`（与分享链接内容 MD5 一致：`ba0556c5...`，383 行）
> 审阅日期：2026-08-17（本会话）
> 方法：逐项对照当前代码库核实（文件:行号 + 关键路径确认），与 `docs/performance-review.md`（2026-07 审计，已实施三批修复）交叉比对；对关键性能假设做实测基准（tiktoken 编码速度）。

---

## 总体结论

**报告整体质量较高、可信**：行号准确率出乎意料地高（`AgentLoop.ts:709/754/1088/1827/2065`、`streamModel.ts:865/899`、`CompactionEngine.ts:143-260/332`、`TokenAccountingRuntime.ts:123-143` 与当前代码完全吻合），说明基于近期 checkout 的静态分析。26 项中约 **60% 属实且未修复**，约 25% 严重度被高估（多为冷路径/已被 2026-07 审计修复/误标热路径），约 15% 与事实不符（路径过期、语义误读）。

**最重要的独立发现（报告低估了它）**：`js-tiktoken/lite` 对**中文文本的 encode 呈二次方退化**。实测（js-tiktoken@1.0.21，Node v22.22.3）：

| 输入 | 耗时 |
|---|---|
| ASCII 10KB | 0.8ms |
| CJK 1KB | 552ms |
| CJK 2KB | 2,098ms |
| CJK 4KB | 8,437ms |
| CJK 10KB | 53,041ms |

时间 ∝ 尺寸²（1KB→4KB 尺寸×4、耗时×15）。报告 P0-1 引用的"项目注释自评 100KB 约 8 秒"确实存在（位于 `src/tool/builtin/readFile.ts:662`，针对自然语言/混合内容），而**中文高重复文本场景实测比该估计恶劣几个数量级**：50KB 重复中文单次全量扫描 ≈ 20+ 分钟级阻塞。叠加 P0-2/P0-3/P2-20 每轮 2~4 次扫描，长对话每轮模型请求前阻塞事件循环可达**数分钟**——这不仅是性能问题，对专利（中文为主）场景是可用性问题。**消息级 token 计数缓存是本计划第一优先级，并应配合病态输入抽样兜底（换 tokenizer 实现无效——见实施回写）。**

---

## 逐项判定（26 项）

图例：✅ 有效未修复 ｜ ⚠️ 部分有效/严重度需调整 ｜ 🔵 已被 2026-07 审计修复 ｜ ❌ 与事实不符/误判

### P0 — 关键瓶颈

| # | 判定 | 结论 |
|---|---|---|
| 1 | ✅ **有效，严重度低估** | `TokenBudgetManager.estimateForMessages`（165-171 行）逐消息无缓存全量重编码，属实。且实测中文二次方退化，影响远超"数秒"。**本计划最高优先级。** |
| 2 | ✅ 有效 | `evaluateRequestBudget` 行 123/131/142/143 实锤：fast-path 2 次、slow-path 3 次本地估算；**行 123 与 143 参数完全相同（`usePadding:true`）是纯重复**。修法：raw 计数只算一次，padding 由 raw 推导。 |
| 3 | ✅ 有效 | CompactionEngine 行 143/154/157/260 四次全量计数属实；`runAutoCompact` 在 AgentLoop 有 3 个调用点（352/406/911：pre-routing/post-routing/model-error-recovery），"每轮最多 3 次"成立。 |
| 4 | ✅ 有效 | `AgentLoop.ts:1827` `messages: cloneMessages(requestMessages)` 属实（`clone.ts:49` 对每个 tool_call input 做 `structuredClone`）；`createModelRequest` 调用点 364/418/1918 + budget evaluator，"最多 4 次/轮"基本成立。 |
| 5 | ✅ 有效（附注不准确） | `TokenStatsCollector` 行 203 `writeSync` / 205 `appendFileSync` 在 `observe()` 热路径属实。但"排序比较器内 JSON.parse（413-415）"位于**一次性迁移函数** `migrateJsonToJsonl`，非每请求执行——影响标注错误，主项不受影响。 |

### P1 — 高影响

| # | 判定 | 结论 |
|---|---|---|
| 6 | ✅ 有效 | 四处拼接全部实锤：`streamModel.ts:861/865`、`StreamingCheckpoint.ts:25`、`CompactionEngine.ts:331`、`websocket.ts:77`。注：websocket.ts:77 为入站帧组装（有界）；出站侧 2026-07 已加 `sendBatch` 合并，不在本次范围。 |
| 7 | ⚠️ 部分有效，降级 P2 | Hölder 剪枝已存在（代码注释详尽）；`result.sort` 作用于**长度 ≤ limit（topK，通常 ≤20）的有界数组**、每 doc 至多一次，成本 O(docs × limit·log limit)，非全量排序。真正成本是剪枝后的扫描本身。二分插入收益微，不值得专门做。 |
| 8 | ⚠️ 部分已修复，高估 | `knowledge-embeddings.ts` 已有**进程级共享矩阵 LRU 缓存**（`MAX_MATRIX_CACHE` 淘汰）+ 键集分页加载；`vector-db.ts` 的 `cache` Map 按 corpus 键、**条数受 DB corpus 列表约束（有界）**，非"无限膨胀"。真实无界项是 `kg-store.ts:39` 的 `nodeCache`（116K 节点，无淘汰，与 P2-17 重复）。 |
| 9 | ⚠️ 事实成立，严重度高估，建议降 P3 | `patentSearch.ts:522` 每次 `new pg.Client` 属实，但这是**一次性 CLI 命令**（`sati patent-search`，冷路径），每次调用新建连接是 CLI 常规做法；查询已参数化（`$N` 占位符走 extended protocol，服务端有 prepare 缓存），"无 prepared statement/每次重新生成执行计划"表述不准；12 分支串行是为输出顺序的刻意设计。除非 CLI 变常驻服务，不值得改。 |
| 10 | 🔵 大部分已修复 | 2026-07 审计已加 `idx_l0_sessions_time/session_time/pending/session` 索引 + 10 条热语句 prepare 缓存 + `listRecentL0`/`getLatestL0Before` 加 LIMIT。残留：`listAllL0`（仅 repair 冷路径用）、`repairL0Sessions` 无事务（冷维护路径）。**附注"vector-db-writer 逐条 INSERT 无事务"已失效**——`build-knowledge-vectors.ts:207/220` 已 `BEGIN/COMMIT` 包裹批写。 |
| 11 | ⚠️ 事实成立，路径误标，降 P3 | `cloneGatewayEvent`（`JSON.parse(JSON.stringify)`）属实，但调用点仅在**重放录制/重建路径**（`InProcessGateway.ts:697` 重建 replay、`1039` 录制 active-turn 事件，且有 `ACTIVE_TURN_EVENT_LIMIT/BYTE_LIMIT` 上限），**不在 text_delta 流式广播热路径**上。"每个网关事件都深拷贝"不成立。换 `structuredClone` 可顺手做，非紧急。 |
| 12 | ✅ 有效 | `staticAssets.ts` 每请求 `existsSync`+`statSync` 各两次属实（行 20-21）。建议合并为一次 `stat`（按 errno 区分不存在）或加 ETag/内存缓存。 |

### P2 — 中等影响

| # | 判定 | 结论 |
|---|---|---|
| 13 | ✅ 大部分有效 | 三处 `filter(role==="assistant").at(-1)`（709/754/1088）实锤，每迭代 O(n) 扫描；工具 schema 每轮重建（1800-1814）仍在，但排序部分已被 2026-07 `list()` 缓存消除，剩余 filter/map 为轻量；`new Set(registry.list())`（2065）仅在工具名修复异常路径。PlanTodoState 多次遍历属实（微优化）。 |
| 14 | ⚠️ 大部分失效/已被处理 | `WeComChannel` 重连前显式 `cleanupWs()` 关闭旧 ws（301 行）；`QQChannel.stop()` 关闭并置空 `botGateway` 实例（监听器随实例 GC）；qqbot-gateway 重连时 `this.ws` 整体替换。**"Mattermost 同一处理函数注册两次"为误判**——实际是 `addEventListener`/`on` 的能力回退 if/else，非双重注册。唯一真实风险：`GatewayWsClient.connect()` 未显式移除旧 socket 监听器（依赖调用方先 close），需运行时验证重连路径。建议：补监听器清理 + 重连回归测试，不视为已确认泄漏。 |
| 15 | ✅ 有效（两处误标） | `PluginToToolBridge.ts:186`、`planMode.ts:225`、`patentPdfDownload.ts:84`、`pdf-extract.ts:223` 的 readFileSync 属实（工具执行路径）。**误标**：`chart.ts:254` 是注释明确的"预读一次 + attempt 间复用"缓存设计（非循环内重复 I/O）；`WeixinChannel:1042-1069` 是**凭据加载/删除/保存生命周期函数**（登录/登出），非消息处理路径。 |
| 16 | ✅ 有效（性质：可观测性，非性能） | AgentLoop 行 1836、TurnRunner 行 365/450 的 `.catch(() => {})` 吞错属实；QQChannel 的 `void this.handleGroupMessage()` 属实。WhatsApp 轮询"可能重叠"：`running` 标志守卫的是 start() 防重入，`pollOnce` 本身无重叠守卫——可能性存在，未证实。建议统一改 `.catch(recordError)` 并给 poll 加守卫。 |
| 17 | ✅ 有效（一项高估） | `kg-store.ts:39` `nodeCache` 无 LRU/TTL 属实（真问题，116K 节点无上限）。`law-search-tool.ts:34` 已处理**路径变更**场景（dbPath 变化时 close 旧引擎）；仅同路径内容替换的边界残留。"vector-db cache 无上限"高估（见 #8，按 corpus 有界）。 |
| 18 | ✅ 有效 | `streamModel.ts:899` `JSON.parse(data)` 无 try/catch 属实；格式异常数据包抛错是否中断整个流取决于外层消费方 catch，需确认。 |
| 19 | ✅ 有效（语义固有，收益低） | 三重嵌套属实，但有 `seen` 去重 + `expandLimit` 有界，属图遍历语义本身；`getNode` 逐邻居可批量 IN 查询（微优化）。不建议动结构。 |
| 20 | ✅ **有效且严重度低估** | `countMessagesTokens` 在 `RouterRuntime` 有 **4 处调用**（176/609/857/893，含重试循环），每次对全量消息做一次 `countTokens(chunks.join())`——叠加 CJK 二次方病理，路由重试场景下每轮又是数次分钟级阻塞。**事实上的 P0 贡献者**，应并入 token 计数缓存修复一并解决。 |

### P3 — 低影响

| # | 判定 | 结论 |
|---|---|---|
| 21 | ⚠️ 存疑/低价值 | `parseTextToolCalls.ts` 正则均为模块级常量；`tryParseQwenXml` 仅在命中 marker 时执行。收益低，可不做。 |
| 22 | ⚠️ **有效且严重度低估，建议升 P2** | `embedding-consistency.ts:76` `ORDER BY RANDOM()` 属实，且**代码自身注释写明"实测每启动一次约 7s 同步 CPU，发生在 async 首个 await 之前，直接阻塞 gateway 启动"**。这是启动路径问题而非 P3 冷路径。修法：`count(*)+random offset` 或 rowid 采样。 |
| 23 | ✅ 有效 | `wiki-card-loader.ts` 首次 ~1548 次 readFileSync 属实（有缓存，冷路径）。低。 |
| 24 | ✅ 有效 | 配置/规则加载器启动同步 I/O，一次性。低。 |
| 25 | ✅ 有效 | `case-law-search.ts:392` 过滤查询动态 `prepare` 属实（代码 105 行注释自认"带过滤走动态 SQL"）；参数化安全，仅每次重新 prepare。建议按过滤组合 prepare 缓存 Map。 |
| 26 | ✅ 有效 | `personal-note-store.ts` `list()` 全量 `JOIN + sati_uncompress` 无 LIMIT 属实，每次语义搜索触发。建议加 LIMIT/分页。 |

---

## 与 2026-07 审计（docs/performance-review.md）的重叠

| 本报告条目 | 2026-07 已做 | 现状 |
|---|---|---|
| P0-2（重复计数） | TokenAccounting 快速通道（跳过 provider count_tokens 网络调用） | 网络调用已省，**本地重复计数仍在**——报告该条仍然成立 |
| P1-6 出站 | 网关 `sendBatch` 16ms 窗口合并 | 已修复；本报告 77 行是入站帧组装，不在其列 |
| P1-8 | 共享矩阵 LRU + 键集分页 + KG trigram 迁移 | 已修复大半，残留 kg-store nodeCache |
| P1-10 | SQLite 索引 + 语句缓存 + LIMIT | 已修复大半，残留冷路径 repair |
| P1-10 附注 | vector-db-writer 事务 | 已修复（BEGIN/COMMIT） |
| P2-13 排序 | ToolRegistry `list()` 排序缓存 + repairToolName 索引缓存 | 已修复（排序部分） |
| P2-15 chart/Weixin | — | 误标（见上） |

结论：**报告的"重复旧账"比例不高**（约 5 项与已修复项重叠），主体仍是未落地的真问题；但未与既有审计文档交叉引用，读者无法区分新旧。

---

## 修正后的行动清单（按 ROI 排序）

### 第一批（改动集中、收益最大，建议直接实施）

1. **消息级 token 计数缓存（根治 P0-1/2/3 + P2-20）**
   - `TokenBudgetManager` 增加 per-message 缓存：key = 消息对象引用或（内容长度 + 内容 hash），值 = 该消息 token 数；消息未变不重编码，变更/新增仅增量计数。
   - `estimateForMessagesWithPadding` 由 raw 推导 padding，消除 123/143 重复（P0-2）。
   - 缓存失效：消息对象不可变时按引用缓存即可（本轮 agent 内部消息一旦入历史不再改写；需核实 mutation 点，必要时 hash）。
2. **tokenizer 实现实测对比**：`js-tiktoken/lite`（纯 JS）对中文二次方 → 对比 WASM 版 `js-tiktoken` / `gpt-tokenizer`（线性）的真实吞吐，取最优替换。这是唯一能根治中文场景"分钟级阻塞"的选项。**必须先做基准再定**（CI 微基准测试固化，防回退）。
3. **lastUsage 短路**：`TokenBudgetManager.evaluate` 已有 `lastUsage` 且对话未显著变化时跳过本地全量计数（一行级改动，立即省掉每轮最大开销）。
4. **TokenStatsCollector 异步化**：`writeSync` → 内存缓冲 + 定时批量 `appendFile`（或至少队列化 + 统一 flush）。
5. **流拼接改数组 join**：streamModel/StreamingCheckpoint/CompactionEngine 三处 `text +=` → `string[]` + `join()`；websocket 入站帧可保留（有界）。

### 第二批（中等改动）

6. **embedding-consistency RANDOM() 采样**（消除启动 ~7s 阻塞，升 P2 处理）。
7. **kg-store nodeCache 加 LRU/TTL**。
8. **RouterRuntime token 计数走增量/缓存**（#1 落地后自动受益；确认重试循环不重复全量扫描）。
9. **staticAssets 合并 stat/exists**（一次 stat 按 errno 区分）+ ETag。
10. **cloneGatewayEvent 改 structuredClone**（重放路径，顺手）。

### 第三批（清理类）

11. 监听器显式清理：GatewayWsClient 重连前 close + removeEventListener；其余通道补重连回归测试（确认实例替换覆盖）。
12. 工具路径 `readFileSync` → `fs/promises`（保留 chart 预读缓存设计；WeixinChannel 凭据路径可保留同步）。
13. case-law 过滤查询按组合 prepare 缓存。
14. personal-note `list()` 加 LIMIT/分页。
15. fire-and-forget 统一 `.catch(recordError)` + WhatsApp `pollOnce` 重叠守卫。
16. 新增 CJK 长对话 token 计数微基准（阈值门禁），防止 tokenizer 或缓存回退。

### 不建议实施

- **P1-9 pg.Pool**：一次性 CLI 冷路径，收益与风险不成比例（除非 CLI 常驻化）。
- **P1-7 二分插入**：数组有界，收益微。
- **P2-19 图遍历重构**：语义固有，改动风险大于收益。

---

## 方法论评价与建议

- **优点**：行号准确率高（近期快照）；分类清晰；修复建议方向正确；P0/P1 主体判定可靠。
- **不足**：① 渠道适配器路径过期（已迁 `qq/`、`wecom/`、`mattermost/` 子目录；`PluginToToolBridge` 在 `src/mcp/runtime/`、`planMode` 在 `src/tool/builtin/`、`chart.ts` 在 `src/patent/atoms/handlers/builtin/`、`pdf-extract` 在 `src/patent/figure/`、`parseTextToolCalls` 在 `src/model/streaming/`）——基于目录重组前快照；② 严重度系统性偏高：冷路径（CLI/迁移/启动/凭据生命周期）与热路径混排；③ 可靠性与可观测性问题（监听器、fire-and-forget）混入性能清单；④ 未交叉引用 2026-07 审计，重复旧账；⑤ 对 tiktoken 中文退化缺乏实测（否则会识别为第一优先级）。
- **后续**：修复前先落 CJK 基准（`node:test` 微基准），每项修复记录 before/after；第 1-3 项建议本迭代完成，可在完成后回写本审阅报告状态。

---

## 实施状态回写（第一批已完成，2026-08-17）

| 计划项 | 状态 | 落点 |
|---|---|---|
| 1. 消息级 token 计数缓存（P0-1/2/3 + P2-20 根治） | ✅ | `src/context/budget/tokenizer.ts`：`countTokens` 内容级 sha1 缓存（LRU 4096）+ 抽样兜底（>1KB 先编码 1KB 样本，>150ms 判病态走密度外推）；`TokenAccountingRuntime` 新增 `estimateRequestInputOnce`（raw/padded 一次算齐，消除 fast-path 2×/slow-path 3× 重复编码）。全进程共享，RouterRuntime 的 `countMessagesTokens`（P2-20）自动受益 |
| 2. tokenizer 实现实测对比 | ✅ 结论：**不换** | 实测 WASM 版 `js-tiktoken` 与 lite 在自然语言（~10ms/KB 线性）与病态重复文本（二次方）上无实质差异（16KB 病态两者均 ~134s）——换实现不解决病态问题；memoization + 抽样兜底同时覆盖两种场景，且保留同步 API 零重构 |
| 3. lastUsage 短路 | ✅ 由 memoization 覆盖 | 每轮只对新消息编码（旧消息 hash 命中，O(n) sha1 ≈ 0.2ms/100KB），lastUsage 比较前的本地估算成本已可忽略；`evaluateRequestBudget` 单次估算直接复用 |
| 4. TokenStatsCollector 异步化 | ✅ | `src/router/stats/TokenStatsCollector.ts`：`writeSync`/`appendFileSync` → 内存缓冲 + 64KB 批量异步 `fs.write`（O_APPEND 单次原子追加）+ 1s unref 定时兜底 + `flush()` 排队串行 + `dispose()` 同步兜底 |
| 5. 流拼接改数组 join | ✅ | `streamModel.ts`（SSE 帧缓冲 parts 数组）、`StreamingCheckpoint.ts`（parts + 非空白字符计数，`hasSubstantialContent` 语义等价）、`CompactionEngine.ts`（摘要 textParts） |

新增测试：`tests/context/budget/tokenizer-cache.spec.ts`（缓存命中/互不串扰/病态外推/自然语言全量/LRU 上限，5 例）、`tests/router/token-stats-collector.spec.ts`（flush 落盘/批量阈值/同步兜底/clear/disabled，5 例）。验证：`pnpm typecheck` ✓、改动文件 eslint 0 错误、biome 格式化 ✓、context/router/streaming 全量测试绿。
