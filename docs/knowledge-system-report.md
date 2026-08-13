# Sati 知识库系统研究报告（2026-08-13）

> 研究范围：`src/knowledge/` 及其组装（assemble.ts）、诊断（diagnostics.ts）、维护脚本（scripts/trim-knowledge-db.ts 等）与消费接线（工具、MemoryResolver 注入、gateway/UI 出口）。
> 研究方法：代码走查 + 本机真实库（`~/.sati/knowledge/knowledge.db`）只读实测。本机库为 XiaoNuo 管道产出的统一主库，体积 3.50 GiB（3,753,725,952 字节）。
> 只读纪律：全部基准/验证均以只读方式打开数据库，未修改任何源库与源码。

## 1. 执行摘要

**可运行性判定：通过。**
- 后端测试 236 项：**233 通过 / 0 失败 / 3 跳过**（3 项跳过均为 legal-search 集成套件——本机未部署独立 laws-full.db，而该能力已有 knowledge.db 主路径，跳过符合设计）。
- 能力诊断 9 项：7 项 `ready`（patent-kg / patent-ipc / patent-wiki / legal-fts / case-law / semantic-vectors / kg-fts-tokenizer=trigram），2 项 `disabled`（semantic-embedding / rerank，因未配置 embedding 客户端——语义路安全关闭，符合设计语义）。
- `trim-knowledge-db.ts` 三档裁剪全部可运行：档 A 纯 VACUUM 字节级无收益（库无碎片，freelist=0）、档 B 压缩+重建同样 -0%（62% 正文已在数据源头 gzip 压缩）、档 C 极限裁剪 -78%（3.50 → 0.77 GiB），内置 4 组件验证通过（档 C 按 `--skip-verify` 跳过）。

**性能判定：检索延迟整体优秀，存在 2 个明显卡点（向量检索 ~195ms、判例引擎 ~100ms），1 个结构性问题（FTS 索引占库 68%）。**
- FTS5 trigram 全文检索（判例/法规/图谱）裸 SQL 延迟 **<5ms**，含热词"创造性"（命中 66,569 chunk）全量 bm25 排序也仅 **1.8ms**——此前"JOIN 场景 FTS 全量排序"的性能担忧被实测证伪。
- 引擎级真实调用链延迟：图谱 0.04–15ms、法规 28–64ms、判例 90–102ms（瓶颈为 top-N 全文 gzip 解压与 JS 后处理，而非 SQL）、判例全文分块 0.9ms。
- 语义检索为**唯一明显卡点**：int8 暴力扫描 144,069×1024 向量，**每查询 ~195ms 且同步阻塞主线程**；矩阵冷加载 353ms、驻留内存 ~141MB。
- 库体积 3.50 GiB 中 **docs_fts 索引 2,431MB（68%）** 为最大单项，正文（chunks）512MB，embeddings（int8）188MB。

**Top 3 优化建议**（完整清单见 §6）：① 向量检索加阈值剪枝或评估 sqlite-vec ANN（195ms → 目标 60-120ms 或 <20ms，B1）；② 判例/法规引擎延迟解压（102ms → 30-50ms，B2）；③ 消除静默降级与诊断盲区（ftsDegraded/LIKE 降级接入 stats 与日志，修复 A1/A2/A5 诊断-装配不一致）。体积侧：本机库已源头压缩且无碎片，trim 档位无收益，分发请直接用档 C（0.77 GiB，-78%）。

## 2. 架构说明

### 2.1 数据源矩阵

| 数据源 | 定位 | 现状 | 环境变量 |
|---|---|---|---|
| `knowledge.db`（统一主库，3.50 GiB） | 图谱 + 判例/法规全文 + 语义向量 + 项目笔记，唯一主路径 | 由 XiaoNuo 管道构建，Sati **只读消费**（代码内无建主库表 DDL，schema 见 `docs/design/import-xiaonuo-knowledge.md:62-84`） | `SATI_KNOWLEDGE_DB` / `SATI_KNOWLEDGE_DIR` |
| `patent_kg.db`（legacy 图谱） | `SATI_PATENT_KG_DB` 显式指向时绕过主库 | 已收敛进 knowledge.db，仅兼容保留 | `SATI_PATENT_KG_DB` |
| `laws-full.db`（legacy 法规） | knowledge.db 法规 `count()==0` 或打开失败时回退 | 兼容保留 | `SATI_LAW_DB` |
| `cases.db`（legacy 判例） | 仅 `patent_case_search` 工具侧消费 | 自动注入侧只看 knowledge.db（问题 A1/A7） | `SATI_CASE_DB` |
| `vectors.db`（legacy 语义索引） | 仅存在时被 `VectorDbSearch` 打开，喂 LegalMemoryProvider | 主路径已废弃（build-knowledge-vectors.ts 标 deprecated），有索引无消费者风险（A6） | `SATI_VECTORS_DB` |

统一主库表结构与体积（dbstat 实测，页大小 4096）：

| 表/索引 | 体积 | 说明 |
|---|---|---|
| `docs_fts`（含 shadow） | **2,431 MB** | FTS5 trigram contentless，判例+法规+笔记全文索引，占库 68% |
| `chunks` | 512 MB | 正文；**89,727 行（62%）已带 SC 魔数 gzip 压缩（数据源头已压）**，54,456 行明文 TEXT 全部 <800 字符（不满足压缩阈值） |
| `embeddings` | 188 MB | 144,069 条 int8 向量（1024 维）+ 2 个单列索引 |
| `kg_nodes_fts`（含 shadow） | 152 MB | 图谱节点 FTS（trigram contentless） |
| `kg_nodes` | 105 MB | 214,824 节点 |
| `kg_edges` | 36 MB | 233,891 边（5 个索引共 59MB） |
| `documents` | 21 MB | 81,546 文档元数据 |

### 2.2 模块结构（src/knowledge/）

扁平「子域 + shared」结构（与 CLAUDE.md 声称的 protocol/runtime/config 三层不符——`docs/technical-debt-report.md:98` 已指出）：

- `assemble.ts` — `buildKnowledgeResolvers()`：路径探测 → 引擎装配 → MemoryResolver 列表；唯一入口
- `diagnostics.ts` — `resolveKnowledgeCapabilities()`：8 项静态能力（路径探测 + 行数探测）+ 2 项运行时能力（仅传入 runtime 快照时追加）
- `config.ts` — `resolveKnowledgeDbPaths()`：环境变量路径解析
- `case-law/` 判例全文（CaseLawSearchEngine + CaseLawMemoryProvider 自动注入 + RRF 融合）、`legal/` 法规（knowledge.db 后端 + legacy 引擎 + 记忆注入）、`patent/` 图谱适配 + IPC 分类器 + wiki 卡片（~1548 张，内置 yaml）、`personal-note/` 项目笔记语义、`shared/`（kg-store、knowledge-embeddings、fts、circuit-breaker、chunk-compression、int8-matrix-search、knowledge-stats、embedding-consistency、composite-memory-resolver）

### 2.3 数据流

```
ProjectRuntime.retrieve
  → CompositeMemoryResolver.retrieve（并发，单子失败降级）
    → PatentMemoryProvider / LegalMemoryProvider / CaseLawMemoryProvider
      → KgStore / KnowledgeLawSearch / CaseLawSearchEngine / KnowledgeEmbeddingSearch
        → DatabaseSync(dbPath, { readOnly: true })  ← 各引擎独立句柄（同一库最多 5 个连接，无共享）
工具直调：patent_kg_query / patent_case_search / patent_wiki_search / law_search / knowledge_note_save（唯一写库工具）
出口：启动日志 logKnowledgeCapabilities + gateway `knowledge_capabilities` 方法 + UI REST GET /api/projects/:p/knowledge-capabilities
```

### 2.4 降级路径设计（评价：完备但可观测性弱）

**FTS5 → LIKE 四层防护**（设计良好）：
1. 编译选项探测 `sqliteHasFts5`（fts.ts:18-25）；2. prepare MATCH 的 try/catch；3. 查询期异常 → 粘性 `ftsDegraded=true` 永久走 LIKE；4. 短查询（<3 字符）与 FTS 无命中降级 LIKE。
**embedding 未配置 → 语义路安全关闭**：入口守卫返回空 + `CircuitBreaker`（3 连败开闸 120s，仅保护 embedding/rerank 两条 HTTP 路）+ wiki 预热延迟 30s 后台执行失败仅告警。
**缺口**：运行中降级（ftsDegraded、LIKE 回退、3 处 `catch {}` 空捕获）不记日志、不进 stats；`knowledge_capabilities` 是唯一按需出口，无持续遥测（telemetry 零 knowledge 引用）。

### 2.5 组装与诊断一致性问题清单（A1–A8）

| # | 问题 | 位置 | 严重度 |
|---|---|---|---|
| A1 | `case-law` 诊断依据 `paths.caseDb` 存在性，而自动注入装配只看 `options.knowledgeDb`（options 无 caseDb 字段）。仅设 `SATI_CASE_DB` 时诊断报 ready、自动注入实际未装配 | diagnostics.ts:122 vs assemble.ts:170 | 高（诊断误导） |
| A2 | assemble.ts:121 注释称"KG 打开失败跳过专利 provider（wiki/IPC 随 KG 缺失路径兜底）"，但 catch 分支不 push 任何 provider——KG 表缺失时专利 provider 整体丢失，IPC/wiki 不可用，而诊断恒报 `patent-ipc=ready`/`patent-wiki=ready` | assemble.ts:114-126 | 高（行为+诊断不一致） |
| A3 | 文档声称一致性自检失败"语义召回自动降级跳过（复用熔断路径）"，代码仅 warn + 写入 stats，无任何消费该结果做门控的代码 | docs/design/import-xiaonuo-knowledge.md:195 vs assemble.ts:231-240 | 中（文档承诺未实现） |
| A4 | legal/case 引擎的 `ftsDegraded` 降级在诊断中不可见（仅 KG 有 kg-fts-tokenizer 运行时项）——桌面端无 FTS5 的 Node 下 legal-fts/case-law 仍报 ready 但静默走 LIKE | diagnostics.ts:151-163 | 中（诊断盲区） |
| A5 | `case-law` 判定仅 existsSync 不看行数；空库/损坏库出现"诊断 ready、装配跳过" | diagnostics.ts:122 | 中 |
| A6 | `semantic-vectors` 在 vectors.db 存在时报 ready，但 VectorDbSearch 仅被 LegalMemoryProvider 以 "law" corpus 消费——只有 "kg" corpus 的 vectors.db 是"有索引无消费者" | diagnostics.ts:135 / legal-memory-provider.ts:181 | 低 |
| A7 | `SATI_CASE_DB` 与 knowledge.db 分离时，personal_note 语义路显式关闭并告警，但判例语义源仍注入 caseDb（工具侧可用）而自动注入缺位——两种能力行为不一致，无统一文档 | createLocalGateway.ts:881-899 | 低 |
| A8 | diagnostics.ts:161 的 migrate 提示未区分 unified/legacy schema（unified 恒为 trigram，提示仅对 legacy 生效） | diagnostics.ts:161 | 低（文档过期） |

## 3. 可运行性验证结论

### 3.1 后端测试（tests/knowledge/，31 文件）

命令：`pnpm build && node --test --test-force-exit --test-timeout 60000 "dist/tests/knowledge/**/*.test.js" "dist/tests/knowledge/**/*.spec.js"`

**结果：236 tests / 27 suites / 233 pass / 0 fail / 3 skipped（exit 0）**

- 3 项跳过均来自 `legal-search` 集成套件：本机未部署独立 laws-full.db（`local law database open failed (schema mismatch?)`），按 `describe({skip})` 设计跳过；法规能力已有 knowledge.db 主路径（count=96），不构成回归。
- case-law 集成 4 用例全过（真实 knowledge.db 命中"创造性 三步法"无效决定、最高院过滤、getById 全文分块）。
- 覆盖亮点：`case-law-search.spec.ts`（FTS/LIKE 双路径）、`kg-store-knowledge-db.spec.ts`（unified 双 schema）、`legal-search-fts-degrade.spec.ts`（降级）、`diagnostics.spec.ts`（判定矩阵）、`embedding-consistency.spec.ts`、`chunk-compression.spec.ts`（gzip 往返）。
- 已知瑕疵（非失败）：`case-law-search.test.ts:7-8` 注释称"缺失时跳过"，实际 `assert.ok(dbPath)` 在缺库时 FAIL（与 legal-search.test.ts 的 skip 模式不一致）——纯注释/行为漂移，不影响本机（库存在）。

**判定：通过。**

### 3.2 能力诊断（只读脚本，未启动 server）

`resolveKnowledgeCapabilities` 实际输出（embedding 未配置视角，与启动日志同源）：

```
patent-kg=ready(kg_nodes 214,824 节点（knowledge.db）)
patent-ipc=ready
patent-wiki=ready(内置 wiki 目录)
legal-fts=ready(法规 96 部（knowledge.db）)
case-law=ready
semantic-embedding=disabled(memory.embedding.enabled)
semantic-vectors=ready(knowledge.db embeddings 144,069 条)
rerank=disabled(memory.embedding.rerank)
kg-fts-tokenizer=ready(trigram)（运行时项，kgFtsMode 静态近似：kg_nodes_fts 建表 SQL 含 trigram）
```

- 语义两路在未配置 embedding 客户端时正确显示 `disabled`，关键词/FTS 检索不受影响——降级语义安全关闭得到实测确认。
- 与 §2.5 交叉比对：case-law=ready 的判定来源是 `paths.caseDb`（=knowledge.db，本机一致所以无偏差），印证 A1 仅在 `SATI_CASE_DB` 单独指向 legacy 库时显现。

**判定：通过。**

### 3.3 trim-knowledge-db.ts 三档实跑

> 源库无自由页碎片（`PRAGMA freelist_count=0`，journal_mode=delete），档位收益完全由内容裁剪决定。全部只读源库、输出至 /tmp。

| 档位 | 参数 | 输出体积 | 变化 | 组件验证 |
|---|---|---|---|---|
| A（纯 VACUUM） | `--keep-embeddings` | 3,753,725,952 B（与源字节级相同） | **-0%** | 全过（KgStore unified/trigram、法规 count=96、判例 count=81,546、语义 available=true） |
| B（压缩+重建） | `--keep-embeddings --compress-chunks --rebuild-kg-fts` | 3,753,316,352 B | **-0%**（差 409,600 B = 100 页） | 全过；kg_nodes_fts 重建并回填 214,824 节点 |
| C（极限） | `--no-fts --skip-verify` | 826,109,952 B（0.77 GiB） | **-78%** | 跳过（按 --skip-verify，报告注明"体积有效、检索未验证"） |

- 档 A 结论：本机库经 XiaoNuo 管道紧凑构建（freelist=0，journal_mode=delete），**VACUUM 档位无收益**（输出与源字节级相同）；trim 的 VACUUM INTO + 二次 VACUUM + 4 组件验证链路完整可运行（秒级-分钟级）。
- 档 B 结论：`--compress-chunks` 报告"压缩 0 条"——经核实**非故障**：89,727 行（62%）已在数据源头以 SC 魔数 gzip 压缩（平均 4,513 B/条），剩余 54,456 行明文均 <800 字符（`shouldCompress` 阈值下限）；kg_nodes_fts 重建（contentless_delete=1）回填 21.4 万节点。本机库体积已无压缩冗余。
- 档 C 结论：删除 FTS 索引 + embeddings 后体积 -78%（0.77 GiB），与脚本头部实测口径（7G→1.6G，-77%）一致；LIKE 降级路径读取端 `sati_uncompress` 兼容（明文/压缩混合内容可正常检索）。本档为"全文检索降级 LIKE"的最小分发形态。

**档位选型建议**：本机库（已源头压缩 + 无碎片）各裁剪档收益有限，**不建议再裁剪**；若需分发，档 C（0.77 GiB，-78%）是唯一有明显体积收益的档位，代价是全文检索降级 LIKE。

### 3.4 可运行性总体判定

**通过。** 测试 0 失败（3 项环境性跳过有明确归属）、诊断与降级语义符合设计、维护脚本全参数可运行。未通过项：无（A1–A8 为一致性/可观测性问题，非运行故障，见 §2.5 与 §6）。

## 4. 性能评估

### 4.1 基准方法

- **CLI 层**：`sqlite3 -readonly` + `.timer on`（输出走 stderr），每条查询独立进程跑 3 次（OS 页缓存热）；`EXPLAIN QUERY PLAN` 佐证执行计划。
- **引擎层**：直接实例化 `KgStore` / `KnowledgeLawSearch` / `CaseLawSearchEngine` 跑真实调用链（含 prepare、sati_uncompress 解压、JS 后处理），预热 2 次后 7 轮取 p50。
- **向量层**：`int8-matrix-search` 的 `loadChunkMatrix`/`searchChunkMatrix` 直接测（绕过未配置的 embedding 客户端），查询向量取真实 embeddings 行反量化，预热 2 次后 10 轮。
- 期间有 Sati 桌面端 server（PID 16213）只读持有库句柄（4 个 r FD），无写竞争（journal_mode=delete）。

### 4.2 实测数据

**CLI 裸 SQL（3.50 GiB 库，页缓存暖）：**

| 查询 | 命中/规模 | 耗时（run1/run2/run3） |
|---|---|---|
| G1 docs_fts MATCH '创造性' count | 66,569 | 1.7 / 1.6 / 1.6 ms |
| G1' 全量 bm25 排序+计数（无 LIMIT 下推） | 66,569 | **1.8 ms**（证伪"热词全排"担忧） |
| G2 判例引擎 SQL（JOIN chunks/documents + bm25 + sati_uncompress LIMIT 25） | — | 0.15 / 0.12 / 0.12 ms |
| G2b MATCH '创造性 三步法' LIMIT 5 | — | 0.13 / 0.11 / 0.12 ms |
| G3 MATCH '新颖性' count | — | 0.75 ms |
| G4 MATCH '创造性 AND 显而易见的' | — | 3.7–4.0 ms |
| G5 kg_nodes_fts MATCH '石墨烯' JOIN LIMIT 20 | — | 0.27 ms |
| G6 kg 三列 LIKE '%石墨烯%' count（LIKE 降级） | 全表 SCAN kg_nodes | **103 ms**（FTS 的 ~600 倍） |
| G7 判例 SQL + doc_type='case' 过滤 | — | 0.13–0.17 ms |
| G8 法规 count + 检索（law_article） | 96 部 | 0.16–0.21 ms |
| G9 kg_edges 单跳邻居（覆盖索引） | — | 0.12–0.16 ms |
| G10 两跳 JOIN 计数 | — | 0.14 ms |
| G11 embeddings 规模（count/scale/长度） | 144,069 | 46 ms |
| G13 dbstat 体积排行 | — | §2.1 表格 |
| G14 freelist_count × page_size | 0 × 4096 | — |

**引擎级真实调用链延迟（p50，含 JS 层）：**

| 路径 | p50 | min/max |
|---|---|---|
| KgStore.searchByKeyword('石墨烯') FTS | 0.04 ms | 0.04/0.05 |
| KgStore.searchByKeyword('创新') FTS（多命中） | 14.7 ms | 14.0/15.1 |
| KgStore.searchByKeyword('二') 短词→LIKE | 0.02 ms | 0.01/0.02 |
| KnowledgeLawSearch.search('新颖性') | 28.1 ms | 28.0/28.8 |
| KnowledgeLawSearch.search('创造性 显而易见') | 64.0 ms | 63.5/64.3 |
| CaseLawSearchEngine.search('创造性 三步法') | 89.8 ms | 88.4/93.9 |
| CaseLawSearchEngine.search('创造性') 热词 | 102.3 ms | 101.2/103.4 |
| CaseLawSearchEngine.getById 全文分块 | 0.9 ms | 0.9/0.9 |
| KnowledgeEmbeddingSearch 构造+available 判定 | 37.5 ms | 37.3/38.4 |

**向量检索（int8 暴力，144,069 chunks × 1024 维）：**

| 指标 | 实测 |
|---|---|
| loadChunkMatrix 冷加载（键集分页 + int8 转换 + 范数） | **353 ms** |
| 矩阵驻留内存 | 141 MB（RSS 434 MB） |
| searchChunkMatrix topK=10（10 轮） | **min 192 / p50 195 / max 200 ms** |
| 每次查询乘加量 | 1.475 亿（纯 JS 主线程同步） |
| 键集分页 ORDER BY（无复合索引，单列索引 + 末项排序） | 45 ms |

### 4.3 瓶颈清单（按实测影响排序）

1. **B1 向量检索 ~195ms/次，同步阻塞主线程**（int8-matrix-search.ts:121-150）：每次查询对全部 144K 向量做 1.47 亿次 int8 乘加；无 ANN/剪枝/阈值；库中 `ivf_index`/`index_meta` 为**空表（0 行，建表残留）且全仓零代码引用**。冷加载 353ms + 141MB 内存。这是全部检索路径中唯一"明显感知"的卡点。
2. **B2 判例引擎 ~100ms**（case-law-search.ts:155-164）：裸 SQL 0.15ms vs 引擎 102ms——开销不在 SQL 而在取回 top-N 全文后逐行 `sati_uncompress()` gzip 解压 + JS 后处理（FETCH_MULTIPLIER=5 → LIMIT 50）。法规引擎同理（28–64ms）。
3. **B3 LIKE 降级最坏情况全表扫描**（kg-store.ts:112-116, 233-249）：count 形态 103ms；引擎查询因 LIMIT 下推提前终止（实测 0.02ms），但**无命中/冷门词仍须扫全表 214,824 行**；`patent_kg_query` 工具强制 `mode:"or"` 使 LIKE 成为常态路径。
4. **B4 FTS 索引体积 2,431MB 占库 68%**：docs_fts trigram contentless 索引远大于正文（chunks 512MB 且 62% 已源头 gzip 压缩）——磁盘/分发/IO 成本，非查询延迟问题；kg_nodes_fts 另占 152MB。trigram 索引 ~2x 体积放大是社区已知特性（见 §5.2）。
5. **B5 同步 `DatabaseSync` 全链路无超时**：38 处同步 API 调用阻塞主线程，无 statement timeout/并发限制/熔断（熔断器仅保护 embedding/rerank HTTP 路）。当前数据量下延迟尚可接受，属结构性风险。
6. **B6 embeddings 缺 (document_id, chunk_id) 复合索引**：矩阵加载的键集分页排序走单列索引 + 末项 TEMP B-TREE（EXPLAIN 证实，45ms）——当前量级无害，但随库增长线性劣化。
7. **B7 构造期探测成本**：KnowledgeEmbeddingSearch 每次构造跑 COUNT + GROUP BY dim（37ms）；KgStore 热路径存在动态 prepare（kg-store.ts:246，多词 LIKE SQL 每查询重编译）。
8. **B8 图谱 BFS/展开宽度风险**（kg-store.ts:337-355）：maxDepth=5 × 每层 LIMIT 100（CITES_EVIDENCE 类边 74K 条），最坏队列膨胀；nodeCache 为无上限 Map（可缓存全部 21.4 万节点）。当前索引完备（每跳 0.15ms）未实测出问题，属规模风险。

**被证伪的候选**：FTS 热词 `ORDER BY bm25 LIMIT` 全量排序——EXPLAIN 确显示 `USE TEMP B-TREE FOR ORDER BY`，但 66K 命中行内存排序实测仅 1.8ms，非瓶颈。此前的"1-10s 预期"不成立。

### 4.4 可观测性缺口清单

1. FTS→LIKE 运行中降级（ftsDegraded、短词/未命中回退）无日志、无指标（kg-store.ts:210-215 等）
2. 3 处 `catch {}` 空捕获静默吞错：case-law-search.ts:214-216（判例语义）、:230-232（笔记语义）、patentCaseSearch.ts:208-211（工具语义回退）
3. `KnowledgeRuntimeStats` 纯计数器，无耗时/分位数字段（knowledge-stats.ts:46-130）
4. telemetry 零 knowledge 引用——无持续遥测，只能经 gateway `knowledge_capabilities` 按需拉取
5. 向量矩阵加载/内存占用无指标出口（仅诊断 API loadedChunkCount）
6. embedding 客户端 512 条向量缓存命中不计数（仅 provider 层 TtlCache 计）
7. 一致性自检（embeddingConsistency）仅启动后一次性写入，不复查、不门控（关联 A3）
8. 构造期 COUNT/GROUP BY 探测（B7）无耗时日志

## 5. 开源对标

> 检索渠道说明：本地 SearXNG（localhost:8888）实测不可达（HTTP 000），全部素材来自内置 WebSearch 检索到的真实来源；来源 URL 均出自检索结果或其确认的官方仓库，无编造。Sources 见 §5.4。

### 5.1 选型理由

| 项目 | 选型理由 |
|---|---|
| **sqlite-vec**（asg017，MIT+Apache-2.0） | 与本项目技术形态完全同构（SQLite 单文件内嵌扩展），`int8[N]` 原生类型与 Sati 的 int8 量化向量逐字节对齐；其"FTS5+vec0 同库混合检索"社区范式正是 Sati 现有架构的官方推崇形态；回应 ivf_index 空表问题（其实验性 IVF/DiskANN 即该设想的成熟化）。 |
| **SQLite FTS5 trigram tokenizer**（官方内建） | Sati 全文检索直接基于此技术——性能行为、contentless 限制、排序优化的权威来源；社区论坛记录了大量与 Sati 相同的工程坑（contentless LIKE 零结果、短查询退化、snippet 慢）。 |
| **txtai**（neuml，Apache-2.0） | "单库嵌入 + 可插拔 ANN 后端"的参考实现，与 Sati 的"统一主库 + 自研暴力扫描"同构；其暴力/ANN 双轨切换（NumPy/Torch ↔ Faiss/HNSW）为 Sati 的向量路演进提供现成决策模型；SQLite 后端本身基于 sqlite-vec，印证该扩展生态成熟度。 |
| **LightRAG**（HKUDS，MIT） | 图+向量+关键词三路混合检索的轻量代表，与 Sati 的"知识图谱 BFS + FTS5 + 语义"检索面几乎一一对应；法律域是其评测最强项（与 Sati 的专利/法律定位直接相关）；其"LLM 抽取关键词代替全文索引"与 Sati 的 FTS5 路形成成本/可控性对照。 |
| **CourtListener / Free Law Project**（BSD-3） | 判例检索的开源标杆（900 万+ 判例，PostgreSQL + Solr→ES 迁移中）；其相关性工程演进（collapse 去重、pagerank 弃用、复合排序规划）与 600GB 嵌入量级的 int8 量化讨论，直接映射 Sati 判例排序与向量存储决策。 |

### 5.2 六维对比表

| 维度 | sqlite-vec | FTS5 trigram（本项目所用） | txtai | LightRAG | CourtListener | **Sati 现状** |
|---|---|---|---|---|---|---|
| 架构形态 | C 扩展嵌入任意 SQLite，单文件无服务，与 Sati 同构 | SQLite 内建虚表，零外部依赖 | Python 单库嵌入（documents+vectors 两文件，后端可换） | Python 框架 + 可插拔多后端（默认全文件型） | 服务化大厂式（PostgreSQL + Solr/ES） | 单进程嵌入（Node + better-sqlite3），统一主库只读消费 |
| 检索能力 | 仅向量（float/int8/bit），FTS5 需自拼 | 仅全文/子串（BM25），可作关键词路 | 三路齐全：向量（多后端）+ 稀疏 BM25 + 图遍历 + SQL 过滤 | 三路齐全：LLM 关键词 + 向量 + 图 1-hop，四查询模式 | 全文为主（BM25）+ faceted；向量路规划中 | 三路齐全：FTS5 BM25 + int8 暴力语义 + 图谱 BFS（含 RRF 融合） |
| 中文与分词 | 与分词无关（纯向量） | trigram 免分词直配 CJK 子串；<3 字符退化需 LIKE 降级（Sati 已实现） | 无专用中文分词器，靠多语言 embedding | 中文支持最佳：推荐 bge-m3 + Neo4j CJK 全文索引 | 纯英文语料 | 中文 OK：trigram 子串 + LIKE 降级 + bge-m3 语义（与 LightRAG 推荐一致） |
| 性能机制 | 默认暴力扫描；IVF/DiskANN 实验性 alpha；v0.1.0 宣称百万 128 维 | 倒排索引近常数命中；rank 列排序优于 bm25 别名；snippet 须后置 LIMIT；~2x 体积 | 暴力（NumPy/Torch）与 ANN（Faiss/HNSW/GGML）按规模可切，量化省 2-8x 内存 | 默认 NanoVectorDB 暴力 + NetworkX 图内存加载，20 万+ 节点吃紧 | ES 分布式 BM25 百毫秒级；collapse 去重 | FTS <5ms 优秀；向量暴力 195ms（可对标 txtai 的暴力后端）；图 214K 节点存 SQLite（优于 LightRAG 内存后端） |
| 降级容错 | 无降级概念（查询失败即 SQL 错误）；readonly 兼容未官方确认 | contentless 下 LIKE/GLOB 打虚表**零结果**（社区证实）；短查询退化——降级必须打内容表 | 后端配置级热切换，暴力/ANN 双轨互为降级 | 模式路由（naive→mix）本身即降级设计 | 双引擎迁移期结果不一致（活教训） | 降级路径完备（FTS→LIKE 四层防护 + 语义守卫 + 熔断器）且打内容表（正确）；但运行中降级不可观测 |
| 可维护性与许可 | MIT+Apache-2.0；pre-v1 破坏性变更风险 | SQLite 官方内建，零维护零许可风险 | Apache-2.0；SQLite 单写者摄入瓶颈；缺大规模中文实测 | MIT；LLM 抽取依赖（token 成本/幻觉） | BSD-3；运维重，迁移期双写一致性成本高 | AGPL-3.0；内建技术零外部依赖，维护面小 |

### 5.3 关键借鉴点（映射到 §6 建议）

1. **FTS 排序优化（社区证实）**：`ORDER BY rank` 隐藏列排序快于 `bm25()` 表达式别名；`snippet()` 必须后置到 LIMIT 之后——Sati 当前无 snippet，排序为 `ORDER BY bm25(docs_fts)` 别名形态，两条优化直接可落地（§6 H5）。
2. **contentless LIKE 陷阱核查**：社区证实 contentless trigram 表的 LIKE 查询可能返回零结果——Sati 的 LIKE 降级必须打在内容表（kg 打 kg_nodes ✓，需核查 legal/case 路径，§6 H6）。
3. **向量路演进模型（txtai/sqlite-vec）**：暴力 → 阈值剪枝 → 量化 ANN（IVF/DiskANN）三级演进，与 Sati 的 int8 现状无缝衔接（§6 H1/M2）。
4. **判例排序增强（CourtListener）**：复合分 = BM25 + 网络分 + 时间衰减；Sati 已有知识图谱（边权重/authority_weight 字段），具备"citegeist"式网络分原料（§6 M5）。
5. **图存储优势**：Sati 的 214K 节点直接存 SQLite（SQL 索引 + 覆盖索引）优于 LightRAG 的 NetworkX 内存加载——架构选择正确，无需迁移。
6. **ivf_index 空表**：建表残留且零引用；未来接 sqlite-vec 时其 IVF 为现成演进路径（§6 M2）。

### 5.4 Sources

**sqlite-vec**：[GitHub asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) · [ARCHITECTURE.md](https://github.com/asg017/sqlite-vec/blob/main/ARCHITECTURE.md) · [releases（v0.1.0 百万向量声明）](https://github.com/asg017/sqlite-vec/releases) · [DeepWiki 高级用法](https://deepwiki.com/marcus-pousette/sqlite-vec/5.3-advanced-usage-patterns) · [FTS5+vec0 混合检索实践](https://dev.to/soytuber/building-a-hybrid-rag-in-200-lines-sqlite-fts5-sqlite-vec-rrf-38h1) · [MIT 双许可记录](https://www.freshports.org/databases/sqlite-ext-vec/#history) · [易混淆项目 sqliteai/sqlite-vector（EL2.0，非 MIT）](https://github.com/sqliteai/sqlite-vector)

**FTS5 trigram**：[官方文档 sqlite.org/fts5.html](https://www.sqlite.org/fts5.html) · [contentless trigram + LIKE 零结果（论坛）](https://sqlite.org/forum/info/41380704c379942c) · [snippet 慢/rank 列排序（论坛）](https://sqlite.org/forum/forumpost/8d50b4d43f561e05) · [FTS5 排序内部（深度文）](https://loke.dev/blog/sqlite-fts5-ranked-search-internals) · [CJK 子串与 trigram 修复](https://dev.to/omochi_dev/why-sqlite-fts5s-default-tokenizer-drops-your-japanese-substrings-and-the-one-line-fix-1k2d) · [contentless trigram 索引与 LIKE/GLOB（sqlite.work）](https://sqlite.work/contentless-trigram-indexes-and-glob-like-queries-in-sqlite-fts5/) · [contentless vs external content](https://sqlite.org/forum/info/741b3b2853d2bbc3) · [chroma 的 trigram 短查询 issue](https://github.com/chroma-core/chroma/issues/1073)

**txtai**：[GitHub neuml/txtai](https://github.com/neuml/txtai) · [文档](https://neuml.github.io/txtai/) · [索引格式 format.md](https://github.com/espoirMur/txtai/blob/master/docs/embeddings/format.md) · [ANN 后端架构](https://leeroopedia.com/index.php/Principle:Neuml_Txtai_ANN_Backend_Architecture)

**LightRAG**：[GitHub HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) · [论文 arXiv:2410.05779](https://arxiv.org/abs/2410.05779) · [存储后端（DeepWiki）](https://deepwiki.com/HKUDS/LightRAG/4-storage-backends) · [图存储后端](https://deepwiki.com/HKUDS/LightRAG/4.1-graph-storage-backends)

**CourtListener**：[GitHub freelawproject/courtlistener](https://github.com/freelawproject/courtlistener) · [API 文档](https://wiki.free.law/c/courtlistener/help/api) · [Solr→ES 迁移讨论](https://github.com/freelawproject/courtlistener/discussions/4406) · [600GB 向量估算 issue #3398](https://github.com/freelawproject/courtlistener/issues/3398) · [pagerank 弃用/复合排序（issue #3632）](https://github.com/freelawproject/courtlistener/issues/3632#issuecomment-2010815640)

## 6. 优化建议清单

> 优先级判定依据：实测影响 × 实现成本 × 风险。问题引用 A#（§2.5）/ B#（§4.3）。

### 6.0 执行状态（2026-08-13 已实施高优先级）

> 高优先级 H1–H6 已按报告落地（H5 实测证伪后回退）。实现后复测（本机 3.50 GiB 库，真实调用链 p50）：

| # | 状态 | 实测收益 | 说明 |
|---|---|---|---|
| H1 | **已实施** | 向量检索 **195 → 106ms（-46%）** | 无损 Hölder 上界剪枝（int8-matrix-search.ts）；冷加载 353→446ms（maxAbs 预计算）；测试：与暴力参照逐位一致（新增 4 用例） |
| H2 | **已实施（部分达成）** | 判例 **102 → 76ms（-25%）**；法规 28→26ms | 延迟解压（FTS 主查询不取正文 + top-N 命中 chunk 回源）；**追加发现**：node:sqlite JS UDF（sati_uncompress）单次 ~4ms 边界开销，回源改 SQL 取原始列 + JS decompressChunk 绕开；剩余 45ms 根因 = node:sqlite（3.51）下 FTS 排序查询渐进物化（CLI 3.54 同 SQL 0.15ms，版本差异），建议列入 M 级评估（better-sqlite3 或 Node SQLite 升级） |
| H3 | **已实施** | 静默降级全部可观测 | stats 新增 legalFtsDegraded/caseLawFtsDegraded/likeFallbacks；引擎降级 logger.warn + 打点；3 处 catch{} 补日志；诊断 runtime 联动（A4 修复） |
| H4 | **已实施** | 诊断-装配一致 | A1/A5：case-law 判据改 knowledge.db 行数探测（空库/损坏库不再误报 ready）；A2：KG 打开失败降级 push 无图谱 provider（wiki/IPC 保留） |
| H5 | **实测证伪，已回退** | — | JOIN 场景 `ORDER BY rank` 触发 FTS5 rank 全量物化（354ms vs bm25 0.12ms，3000 倍倒退）——rank 渐进优化仅适用无 JOIN 直查；保持 `ORDER BY bm25(docs_fts)`（代码注释留痕防回归） |
| H6 | **已实施** | 契约锁定 | 三引擎 LIKE 降级均打在内容表（核查通过）；新增回归测试（contentless 虚表 LIKE 零结果陷阱确认 + 引擎降级命中非零） |

实现后测试基线：**245 tests / 242 pass / 0 fail / 3 skipped**（新增 9 个测试：int8-matrix-search 4 + diagnostics 3 + knowledge-stats 1 + knowledge-law H6 1），typecheck / lint / format:check 全净。

### 高优先级（检索体验 / 正确性 / 可观测性）

### 高优先级（检索体验 / 正确性 / 可观测性）

| # | 建议 | 问题 | 预期收益 | 实现成本 | 风险 |
|---|---|---|---|---|---|
| H1 | **向量检索加入阈值剪枝或评估 sqlite-vec**：int8 点积循环内对 `(dot/queryNorm - normD) > 当前 topK 阈值` 的 chunk 提前跳过（当前 cosine 无任何剪枝）；中长期评估 sqlite-vec（int8[N] 与现状对齐，readonly 兼容需实测，其实验性 IVF 为 ANN 演进口） | B1 | 195ms → 60-120ms（剪枝）或 <20ms（ANN）；剪枝不动存储格式，改动仅 int8-matrix-search.ts 循环 | 剪枝：低（单函数）；sqlite-vec：中（新依赖 + 双写维护 + 评测） | 剪枝有召回损失，需用现有评测（patent-eval）回归；sqlite-vec pre-v1 破坏性变更 |
| H2 | **判例/法规引擎延迟解压**：SQL 只取 id/rank 排序，JS 层对 top-N 再按需解压正文（当前 FETCH_MULTIPLIER=5 → 先解压 50 行全文再 JS 后处理） | B2 | 判例 102ms → 30-50ms；法规 64ms → 20-30ms | 低（case-law-search.ts 查询拆分 + patentCaseSearch.ts 适配） | 低（需回归集成测试） |
| H3 | **消除静默降级**：ftsDegraded 粘性降级与 LIKE 回退接入 `KnowledgeRuntimeStats` + logger.warn；3 处 `catch {}` 空捕获补日志 | A4、可观测性缺口 1/2 | 诊断补齐"legal-fts/case-law 实际降级中"状态；桌面端无 FTS5 场景可观测 | 低 | 低 |
| H4 | **修复 A1/A2/A5 诊断-装配一致性**：case-law 判据改 `knowledgeDb 存在 && 判例行数>0`（或探测两源）；KG 打开失败时诊断联动 IPC/wiki 状态（或装配改为降级 push 无 KG provider） | A1/A2/A5 | 消除"诊断 ready、实际未装配"误导；KG 缺失时 wiki/IPC 不再整体丢失 | 低（diagnostics.ts/assemble.ts 局部） | 低 |
| H5 | **FTS 排序改 rank 列 + 核查 LIMIT 下推**：`ORDER BY bm25(docs_fts)` → `ORDER BY rank`（隐藏列，社区证实更快）；确认无 rank 优化的查询形态不必要全排 | B2（微）、§5.2 | 排序路径减到最小；与 H2 合并 | 极低（SQL 一行动） | 低 |
| H6 | **LIKE 降级路径内容表核查**：社区证实 contentless trigram 的 LIKE 打虚表会零结果——逐一核查 kg/legal/case 三引擎的 LIKE 降级 SQL 是否打在内容表（kg 已核查打 kg_nodes ✓），补测试用例 | §5.2 | 消除潜在"降级后零结果"bug | 低（代码核查 + 补测试） | 低 |

### 中优先级（规模韧性 / 观测完善）

| # | 建议 | 问题 | 预期收益 | 实现成本 | 风险 |
|---|---|---|---|---|---|
| M0 | **评估 node:sqlite 的 FTS 排序物化成本**（H2 追加发现）：实测判例引擎剩余 45ms 为 node:sqlite 3.51 下 FTS 排序查询渐进物化（CLI 3.54 同 SQL 0.15ms）；评估 better-sqlite3（自编译 FTS5 优化）或 Node SQLite 升级，或两阶段查询（纯 FTS 取 top-N + IN 回源）落地 | B2（剩余部分） | 判例 76ms → 目标 <30ms | 中（依赖/查询结构评估 + 语义回归） | 中（查询语义/依赖变更） |
| M1 | **耗时指标进 KnowledgeRuntimeStats**：p50/p95 + 慢查询（>100ms）计数；telemetry 接入 | 可观测性缺口 3/4 | 检索性能可量化运维 | 中（stats 结构 + 打点 + telemetry 契约） | 低 |
| M2 | **embeddings 加 (document_id, chunk_id) 复合索引 + ivf_index 空表清理** | B6 | 矩阵加载排序 45ms → ~5ms，防规模劣化；清理建表残留 | 低（DDL + trim 脚本同步） | 低（读多写少的库） |
| M3 | **同库共享连接**：5 个引擎句柄 → 1-2 个只读连接（或连接池） | B5（部分） | 减少页缓存重复 + 句柄开销 | 中（引擎构造签名改造） | 中（多引擎并发路径回归） |
| M4 | **图谱 BFS/缓存上限**：nodeCache 改 LRU（上限 ~10 万）；legal/case OR 查询加词数上限（kg 已有 MAX_OR_TERMS=8） | B8 | 防长期运行内存膨胀 + 多词查询失控 | 低-中 | 低 |
| M5 | **判例复合排序实验**：BM25 + 图谱网络分（kg_edges 权重/authority_weight 已有原料）+ 日期衰减 | §5.3-4 | 判例相关性提升（对标 CourtListener 排序演进） | 中（需评测集） | 中（排序回归需人工评估） |

### 低优先级（工程卫生）

| # | 建议 | 问题 | 预期收益 | 实现成本 | 风险 |
|---|---|---|---|---|---|
| L1 | 热路径动态 prepare 缓存（kg-store.ts:246 多词 LIKE SQL 每查询重编译） | B7 | 微（<1ms 级） | 低 | 低 |
| L2 | 工具层检索缓存（patent_case_search 等每次全量执行引擎查询，provider 层已有 60s TtlCache 但工具直调无缓存） | B2（辅助） | 重复查询省 100ms 级 | 中（缓存语义设计） | 中（缓存一致性） |
| L3 | A3/A7/A8 文档与行为修复（一致性自检门控或文档更正、SATI_CASE_DB 行为文档化、migrate 提示区分 schema） | A3/A7/A8 | 文档与行为一致 | 低 | 低 |
| L4 | chunks 压缩现状文档化（62% 已源头压缩；trim --compress-chunks 对已压库无操作） | 档 B 发现 | 避免后续误判"压缩失效" | 极低（注释/文档） | 低 |
| L5 | case-law-search.test.ts:7-8 注释与行为对齐（缺库 FAIL → 改为 skip 或改注释） | §3.1 瑕疵 | 测试语义正确 | 极低 | 低 |

### 不建议（当前阶段）

- **引入独立向量数据库/服务化**（Qdrant/Milvus/Elasticsearch）：当前 144K 向量规模下暴力扫描 195ms 尚可用，服务化违背单进程内嵌架构（对标 CourtListener 的迁移期双引擎不一致是反面教训）；待规模 >500 万向量再评估。
- **LLM 抽取式索引**（LightRAG 式）：token 成本与幻觉风险高，Sati 的规则/结构化抽取 + FTS5 更可控。

## 7. 附录：复现命令与数据

- 测试：`pnpm build && node --test --test-force-exit --test-timeout 60000 "dist/tests/knowledge/**/*.test.js" "dist/tests/knowledge/**/*.spec.js"`（日志 /tmp/kb-test-run.log；TAP 汇总 236 tests / 233 pass / 0 fail / 3 skipped）
- 诊断：`node /tmp/sati-kb-diag.mjs`（临时脚本，从 dist 导入 resolveKnowledgeCapabilities）
- CLI 基准：`bash /tmp/kb-bench.sh`（日志 /tmp/kb-bench.log；含 G1-G14 与 dbstat）
- 向量基准：`node /tmp/sati-kb-vec-bench.mjs`（日志 /tmp/kb-vec-bench.log；195ms p50）
- 引擎基准：`node /tmp/sati-kb-engine-bench.mjs`（引擎级延迟 p50）
- trim 三档：`pnpm tsx scripts/trim-knowledge-db.ts --input ~/.sati/knowledge/knowledge.db --output /tmp/kb-lite-{A,B,C}.db --keep-embeddings / --keep-embeddings --compress-chunks --rebuild-kg-fts / --no-fts --skip-verify`（日志 /tmp/kb-trim-{A,B,C}.log；档 A/B 产物已在研究完成后清理，档 C 保留于 /tmp/kb-lite-C.db 供分发测试）
- 关键前置：`sqlite3 -readonly <db> "PRAGMA freelist_count; PRAGMA integrity_check;"`（本机：freelist=0、integrity=ok、journal_mode=delete）
