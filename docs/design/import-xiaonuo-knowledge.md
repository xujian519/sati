# 复用 XiaoNuo 知识库产物 — knowledge.db 统一接入设计

- 状态：**已实施**（2026-08-06；P1–P6 全部完成，`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` 全绿）
- 日期：2026-08-06
- 范围：Sati 知识库（KG 图谱 / 判例全文 / 法规 / 语义召回）统一以 XiaoNuo 管道产物 `knowledge.db` 为数据源，**零重新构建**
- 产物源头：`/Users/xujian/projects/XiaoNuo Agent`（`@nuo/knowledge` 管道构建 knowledge.db，mady 直接复用同一份文件于 `~/.mady/knowledge/knowledge.db`）
- 参考实现：`@nuo/knowledge` 的 `vector-search.ts` / `hybrid-retriever.ts` / `graph-query.ts`（仅参考设计，不引入依赖；Sati 复用其**产物与数据**，代码自研）

---

## 1. 背景与目标

### 1.1 现状问题

Sati 知识库目前是「三库割裂 + 一套未完成的重新构建」：

| 数据源 | 规模 | 问题 |
|--------|------|------|
| `patent_kg.db`（XiaoNuo data 符号链接） | nodes 116K（2026-06-19） | **旧**；knowledge.db 的 `kg_nodes` 214K 已合并更多来源（判例/证据/法条节点） |
| `laws-full-local.db` / `laws-full.db` | law 9,121 条 | 使用频率低；knowledge.db 已有法规文档 + LawArticle 节点 + 向量 |
| `knowledge.db`（caseDb） | documents 81,541 / chunks 144,178 / docs_fts | **只用了判例全文（caseDb），未用 embeddings 向量与 kg_nodes 图谱** |
| `vectors.db`（scripts/build-knowledge-vectors.ts） | **未构建** | 方案本身是"重新 embedding"，与 XiaoNuo 产物重复且数据源更旧；构建脚本存在空路径 bug（已修复但方案应废弃） |

### 1.2 决策前提（已与业务确认）

1. **不重新构建任何向量**：语义召回直接读 knowledge.db `embeddings` 表现成向量（144,069 行，bge-m3 1024 维）
2. **不建 KG 节点向量**：KG 检索走 trigram FTS + 图谱邻居扩展 + wiki 卡语义索引（与 XiaoNuo 设计定位一致）
3. **放弃 laws-full**：法规检索改用 knowledge.db 法规文档（`doc_type='law_article'`，96 部）+ `kg_nodes` LawArticle 节点（3,500 条）；`SATI_LAW_DB` 显式配置时保留 laws-full 作为可选降级
4. **查询向量模型**：默认 Ollama bge-m3（Sati 现状，实测与库向量余弦 0.985，同源可接受）；启动时做**一致性自检**（§4.4）；不捆绑 embed-local（+650MB 不值得）

### 1.3 目标

- 知识库数据源**收敛为单个 knowledge.db**（KG 图谱 + 判例 + 法规 + 向量），消除 patent_kg.db / laws-full / vectors.db 三套并行
- 语义召回**直接消费现成 embeddings**，零 embedding 计算
- 保持"知识库只读"约束（除既有 wiki.jsonl 运行时写路径外）

---

## 2. 现状核对（代码级）

### 2.1 XiaoNuo 管道与产物（已核实）

- `scripts/build-local-data.ts` → `buildIndex()`（`@nuo/knowledge`）：从 `data/raw/`（判决/审查指南/法规/无效决定/专利判决）+ `data/wiki/` + IPC 构建 `knowledge.db`
- 向量生成：`indexer/embedding-builder.ts`，模型 **BGE-M3 ONNX int8**（`gpahal/bge-m3-onnx-int8`，本地推理 `@nuo/embed-local`）
- 图谱合并：`indexer/merge-patent-kg.ts` 把 patent_kg.db nodes/edges 并入 `kg_nodes`/`kg_edges`
- 检索设计：`retrieval/hybrid-retriever.ts`（FTS + 向量 + 图谱扩展，RRF 融合）——与 Sati 现有双路 RRF 同构

### 2.2 knowledge.db schema（关键 DDL，已核实）

```sql
-- 文档（判例/判决/概念/审查指南规则/法规条文）
documents(id TEXT PK, source, doc_type, domain, title, file_path, module,
          priority, level, publish_date, case_number, court, decision_number,
          article_number, content_hash, indexed_at, char_count, chunk_count)
-- 分块（语义/全文检索回源单元）
chunks(id INTEGER PK, document_id REFERENCES documents(id), chunk_index,
       chunk_type, heading, content, char_count)
-- 全文检索（contentless FTS5 trigram；rowid = chunks.id，正文须 JOIN chunks 回源）
docs_fts VIRTUAL TABLE fts5(title, content, module, domain, tags,
                            tokenize='trigram', content='', contentless_delete=1)
-- 向量（float32 × dim，已归一化 norm≈1.0）
embeddings(id INTEGER PK, chunk_id REFERENCES chunks(id), document_id,
           vector BLOB, model DEFAULT 'bge-m3', dim DEFAULT 1024,
           indexed_at, norm REAL)
-- 图谱节点（214,824 行；IPC 75,964 / Case 65,165 / Evidence 62,535 /
-- Judgment 6,831 / LawArticle 3,500 / Concept 699 / GuidelineRule 108）
kg_nodes(id TEXT PK, node_type, name, title, content, domain, source,
         full_ref, chapter, article_number, law_refs TEXT,  -- JSON 数组
         priority, authority_weight, level_in_hierarchy)
-- 图谱边（233,891 行）
kg_edges(id INTEGER PK, source_id, target_id, relation, weight, evidence)
-- 图谱 FTS（trigram）
kg_nodes_fts VIRTUAL TABLE fts5(name, title, content, tokenize='trigram', content='')
```

行数：documents 81,541 / chunks 144,178 / docs_fts 144,069 / **embeddings 144,069** / kg_nodes 214,824 / kg_edges 233,891。向量 dim=1024、norm≈1.0（已归一化）。

### 2.3 Sati 消费端现状

| 模块 | 现状 | 数据源 |
|------|------|--------|
| `src/knowledge/shared/kg-store.ts`（335 行） | `KgStore`：nodes/edges 表 + FTS（`nodes_fts_trigram`/`nodes_fts` 探测）+ LIKE 降级 + 邻居/BFS | patent_kg.db |
| `src/knowledge/shared/vector-db.ts`（205 行） | `VectorDbSearch`：vectors.db int8 余弦，按 corpus 惰性加载 | vectors.db |
| `src/knowledge/patent/patent-memory-provider.ts` | IPC 标准注入 + 图谱检索（关键词/邻居 + **vectorDb("kg") 语义**）+ wiki 卡语义（`WikiCardVectorIndex`） | patent_kg.db + wiki.jsonl |
| `src/knowledge/legal/legal-memory-provider.ts` | `LegalSearchEngine` FTS5（law 表）+ **vectorDb("law") 语义** → RRF | laws-full.db |
| `src/knowledge/case-law/case-law-search.ts`（250 行） | 判例全文：docs_fts（contentless trigram）→ JOIN chunks/documents 回源；FTS5 能力探测 + LIKE 降级 | **knowledge.db（已接）** |
| `src/knowledge/config.ts` | `resolveKnowledgeDbPaths`：patentKgDb / lawDb / wikiDir / vectorsDb / caseDb | 多路径探测 |
| `src/knowledge/diagnostics.ts` | 能力自检清单（含 `semantic-vectors` 项，提示 build-knowledge-vectors） | — |

### 2.4 关键兼容性差异（已核实）

| KgStore 依赖（patent_kg.db） | knowledge.db 对应 | 适配 |
|---|---|---|
| `nodes` 表 | `kg_nodes` 表 | 表名 |
| `edges` 表（source/target/relation） | `kg_edges`（**source_id/target_id**/relation/weight/evidence） | 列名 |
| `nodes_fts_trigram` / `nodes_fts` | `kg_nodes_fts` | 探测名 |
| `nodes.law_refs_count`（INT） | `kg_nodes.law_refs`（TEXT JSON 数组） | 解析 JSON 取长度 |
| `nodes.version` | 无 | 置 undefined |
| FTS tokenize | **trigram**（与 patent_kg 迁移后一致） | 兼容 |

---

## 3. 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 数据源收敛 | **统一 knowledge.db**：KG、判例、法规、向量全部取自该库；`patent_kg.db`/`laws-full.db` 退为 SATI_* 显式配置的降级路径 | 消除三库割裂；knowledge.db 是 XiaoNuo 管道最新产物（2026-07-02） |
| KG 检索 | **kg_nodes/kg_edges/kg_nodes_fts（trigram）**，不建节点向量 | 与 XiaoNuo 设计定位一致；语义主路径由 wiki 卡索引承担（§1.2-2） |
| 语义召回 | **新增 `KnowledgeEmbeddingSearch`** 读 `embeddings` 表（float32），加载时 int8 量化（内存 147MB），document 级聚合 top-k | 复用现成向量；内存可控（float32 全量 590MB 不可行） |
| 查询向量模型 | 默认 Ollama bge-m3（现状）；**启动一致性自检**（锚点余弦阈值 0.97）；可选其他 bge-m3 端点 | 与库向量同源可比（实测 0.985）；零新依赖；不捆绑 embed-local |
| 法条 | knowledge.db 法规文档（`doc_type='law_article'`）+ LawArticle 节点；`SATI_LAW_DB` 显式配置时保留 laws-full | 使用频率低，现有知识库足够（§1.2-3） |
| KG 语义候选（PatentMemoryProvider `via: semantic`） | **移除 vectorDb("kg") 依赖**，保留关键词/邻居/wiki 语义三路 | 决策 2：不建 KG 向量 |
| 向量库产物 | `scripts/build-knowledge-vectors.ts` 标记 **deprecated**（保留代码，注释标注废弃），`vectors.db` 不再作为主路径 | 避免误导后续维护 |
| 只读约束 | 语义 reader 只读 embeddings/chunks/documents；无新运行时写路径 | 维持知识库只读（除既有 wiki.jsonl） |
| 能力诊断 | `semantic-vectors` 项改为检测 knowledge.db `embeddings` 行数；文案移除 build 提示 | 对齐新数据源 |

---

## 4. 数据模型与适配设计

### 4.1 数据源解析（`src/knowledge/config.ts`）

`resolveKnowledgeDbPaths` 调整探测优先级：

```
knowledgeDb = SATI_KNOWLEDGE_DB ?? firstExisting([join(dataDir, "knowledge.db")])   // 7G 主库
patentKgDb  = SATI_PATENT_KG_DB ?? (knowledgeDb 存在 ? knowledgeDb : 旧路径)         // 图谱读 knowledge.db kg_nodes
lawDb       = SATI_LAW_DB ?? (knowledgeDb 存在 ? knowledgeDb : 旧 laws-full 路径)     // 法规读 knowledge.db
vectorsDb   = 保留字段但默认 undefined（不再探测 build 产物）
caseDb      = knowledgeDb（不变）
```

- 新增 `knowledgeDb?: string` 字段（主库路径，供诊断与新 reader 使用）
- 向后兼容：`SATI_PATENT_KG_DB`/`SATI_LAW_DB` 显式设置时仍指向旧库

### 4.2 KgStore 适配（`src/knowledge/shared/kg-store.ts`）

构造时按 `dbPath` 探测表存在性，自动选择 schema：

| 探测 | patent_kg.db（旧） | knowledge.db（新） |
|------|--------------------|--------------------|
| 节点表 | `nodes` | `kg_nodes` |
| 边表 | `edges` | `kg_edges` |
| FTS | `nodes_fts_trigram`/`nodes_fts` | `kg_nodes_fts` |
| getNode 列 | `law_refs_count, version` | `law_refs`（JSON → count）、无 version |

- `getNode` 映射：`lawRefsCount = row.law_refs ? JSON.parse(row.law_refs).length : undefined`（`law_refs` 非法 JSON 时容错为 undefined）
- 邻居查询：`edges.source/target` → `kg_edges.source_id/target_id`
- FTS 探测 SQL 增加 `kg_nodes_fts`；其余逻辑（LIKE 降级、or 分词、BFS、expandNeighbors）**不变**

### 4.3 语义召回 reader（新增 `src/knowledge/shared/knowledge-embeddings.ts`）

```ts
export type KnowledgeEmbeddingHit = { docId: string; score: number };

export type KnowledgeEmbeddingSearchOptions = {
  dbPath: string;                    // knowledge.db 路径
  logger?: { warn?: (...args: unknown[]) => void };
  /** 可选 doc_type 白名单（如 ["case","judgment"] / ["law_article"]）；缺省全部 */
  docTypes?: string[];
};

export class KnowledgeEmbeddingSearch {
  // 惰性加载：SELECT e.chunk_id, e.document_id, e.vector, d.doc_type
  //   FROM embeddings e JOIN documents d ON d.id = e.document_id
  //   [WHERE d.doc_type IN (...)]
  // 内存中 float32 → quantizeInt8（1024 维），复用 cosine.ts 原语；
  // 按 document_id 聚合 [start,end)，chunk 最高余弦即文档得分（对齐 VectorDbSearch）。
  search(queryVector: Float32Array, limit: number): KnowledgeEmbeddingHit[];
  loadedChunkCount(): number;
  docTypeFilter: string[] | undefined;
  close(): void;
}
```

内存与性能：
- 144,069 chunks × 1024 × int8 = **~147MB**（float32 全量 590MB 不可行，故加载时量化；查询向量同样 int8 后做纯 int8 点积，复用 `quantizeInt8/int8Dot/l2Norm/topK`）
- 加载策略对齐 `VectorDbSearch.loadCorpus`：键集分页 + 平铺 `Int8Array`
- 按 `doc_type` 过滤加载（法规检索只加载 96 部法规的 chunk，内存进一步缩小）

### 4.4 一致性自检（新增 `src/knowledge/shared/embedding-consistency.ts`）

```ts
/** 取 knowledge.db 锚点样本，用当前 embedding client 生成向量并与库向量比对余弦。 */
export async function checkEmbeddingConsistency(
  dbPath: string,
  client: EmbeddingClient,
  sampleSize = 8,
  threshold = 0.97,
): Promise<{ ok: boolean; meanCosine: number; samples: Array<{ text: string; cosine: number }> }>;
```

- 取样：`SELECT c.content, e.vector FROM chunks c JOIN embeddings e ON e.chunk_id = c.id
  WHERE length(c.content) BETWEEN 100 AND 500 ORDER BY RANDOM() LIMIT 8`（content 短于 100 字信噪比低）
- 判定：平均余弦 < 0.97 → `warn`（"当前 embedding 模型与知识库向量不匹配，建议改用 bge-m3"），语义召回自动降级跳过（复用既有 `CircuitBreaker`/`guarded` 语义降级路径）
- 挂载点：`assemble.ts` 构造知识解析器时执行一次；结果写入 `KnowledgeRuntimeStats`（供诊断展示）

### 4.5 消费端接线

**PatentMemoryProvider**（`src/knowledge/patent/patent-memory-provider.ts`）
- `queryGraphSemantic`（L249-268，vectorDb("kg")）→ **删除**；`GraphHit.via` 保留 `"semantic"` 类型定义但不再产生该来源（或改为接入文档语义候选，见下）
- 可选增强：叠加 `KnowledgeEmbeddingSearch`（docTypes 含 concept/guideline_rule）作为图谱相关概念召回，与关键词路 RRF 融合——**默认关闭**（本期只做数据源切换，行为变化最小）
- `WikiCardVectorIndex`（wiki.jsonl 语义）**不变**

**LegalMemoryProvider**（`src/knowledge/legal/`）
- `LegalSearchEngine` 增加 knowledge.db 后端：`doc_type='law_article'` 的 documents/chunks 上做 trigram FTS（复用 case-law-search 的 contentless 回源模式），返回 `LawRecord`（name=title、content=最长 chunk 或逐条合并）
- 语义路：`KnowledgeEmbeddingSearch`（docTypes=['law_article']）→ 与 FTS 双路 RRF（对齐现有 `vectors.db("law")` 融合逻辑）
- 降级：构造 knowledge.db 后端失败（无 law_article 文档）时回退 `SATI_LAW_DB` laws-full 引擎

**case-law 判例检索**（`src/knowledge/case-law/`）
- 现状已接 knowledge.db（docs_fts → JOIN 回源），**不动**
- 可选增强：`KnowledgeEmbeddingSearch`（docTypes=['case','judgment']）叠加语义召回，与 docs_fts RRF 融合——**默认开启**（判例语义是 knowledge.db embeddings 的最大价值点，成本仅 reader 接线）

**诊断**（`src/knowledge/diagnostics.ts`）
- `patent-kg`：检测 `knowledgeDb` 的 kg_nodes 行数（>0 → ready）
- `legal-fts`：检测 law_article 文档数（>0 → ready）
- `semantic-vectors`：检测 embeddings 行数（>0 → ready），detail 改为 "knowledge.db embeddings（XiaoNuo 产物，144K 向量）"
- 移除 build-knowledge-vectors 提示文案

---

## 5. 文件级改动清单

### 5.1 新增

| 文件 | 内容 | 规模估算 |
|---|---|---|
| `src/knowledge/shared/knowledge-embeddings.ts` | `KnowledgeEmbeddingSearch`（§4.3：int8 量化加载 + doc 聚合 top-k + doc_type 过滤） | ~180 行 |
| `src/knowledge/shared/embedding-consistency.ts` | `checkEmbeddingConsistency`（§4.4 锚点自检） | ~90 行 |

### 5.2 修改

| 文件 | 改动 |
|---|---|
| `src/knowledge/shared/kg-store.ts` | 表/列/FTS 探测适配 knowledge.db schema（§4.2）；`law_refs` JSON 解析 |
| `src/knowledge/config.ts` | `KnowledgeDbPaths` 增 `knowledgeDb`；探测优先级调整（§4.1）；`vectorsDb` 默认 undefined |
| `src/knowledge/assemble.ts` | 构造 `KnowledgeEmbeddingSearch` + 一致性自检；接线到 provider options |
| `src/knowledge/legal/legal-search.ts`（+ types） | 新增 knowledge.db 后端（law_article FTS + 回源）；保留 laws-full 引擎 |
| `src/knowledge/legal/legal-memory-provider.ts` | 语义路从 `vectors.db("law")` 切到 `KnowledgeEmbeddingSearch`；后端选择逻辑 |
| `src/knowledge/patent/patent-memory-provider.ts` | 删除 `queryGraphSemantic`（vectorDb("kg")）；`vectorDb` option 标记废弃 |
| `src/knowledge/case-law/case-law-search.ts` | 可选叠加 `KnowledgeEmbeddingSearch`（case/judgment 语义路） |
| `src/knowledge/diagnostics.ts` | 能力项检测改 knowledge.db 各表；文案更新 |
| `src/knowledge/index.ts` | barrel 导出新模块 |
| `src/cli/createLocalGateway.ts` | 知识解析器构造参数接线（knowledgeDb 路径传递） |
| `scripts/build-knowledge-vectors.ts` | 文件头标注 **deprecated**（保留代码，注明"已被 knowledge.db embeddings 复用取代"） |

### 5.3 不改动

- `src/knowledge/shared/vector-db.ts`（保留：测试/旧路径兼容；不再作为生产主路径）
- `src/knowledge/patent/wiki-card-vector-index.ts`（wiki 语义索引独立，维持现状）
- `src/knowledge/case-law/case-law-search.ts` 的 FTS 主体（已接 knowledge.db）

---

## 6. 测试计划（`tests/knowledge/` 镜像）

| 测试文件 | 覆盖 |
|---|---|
| `kg-store-knowledge-db.spec.ts` | kg_nodes/kg_edges/kg_nodes_fts schema 适配：getNode（law_refs JSON 解析、version undefined）、searchByKeyword（trigram）、邻居（source_id/target_id）、LIKE 降级、BFS；旧 patent_kg.db schema 仍通过（双 schema 兼容） |
| `knowledge-embeddings.spec.ts` | 加载（行数/维度/量化正确性）；查询 top-k 与 doc 聚合（chunk 最高余弦）；doc_type 过滤（law_article 只召回法规）；空库/维度不匹配容错；内存视图复用（不重复加载） |
| `embedding-consistency.spec.ts` | 锚点取样；高一致性（同源 stub）通过；低一致性（阈值 0.97 以下）返回 ok=false；空 embeddings 库跳过 |
| `legal-memory-provider-knowledge-db.spec.ts` | law_article FTS 召回 + 语义路 RRF 融合；无 law_article 时回退 laws-full 引擎；降级日志 |
| `patent-memory-provider.spec.ts`（回归） | 移除 KG 语义后：关键词/邻居/wiki 三路仍工作；`via:"semantic"` 不再产生 |
| `case-law-search.spec.ts`（回归） | docs_fts 语义叠加后原 FTS 行为不变；语义路加分 |

验收命令：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`。

---

## 7. 分阶段实施计划

| Phase | 内容 | 交付 | 验证 |
|---|---|---|---|
| **P1** | `kg-store.ts` schema 适配（kg_nodes/kg_edges/kg_nodes_fts + law_refs JSON） | 图谱切 knowledge.db（214K 节点） | kg-store-knowledge-db.spec 全绿 + 旧 schema 回归 |
| **P2** | `knowledge-embeddings.ts` reader（int8 量化加载 + doc 聚合 + doc_type 过滤） | 语义召回核心 | knowledge-embeddings.spec 全绿 |
| **P3** | `embedding-consistency.ts` 自检 + `assemble.ts` 接线 | 查询端模型校验 | embedding-consistency.spec 全绿 |
| **P4** | legal-search knowledge.db 后端 + LegalMemoryProvider 语义切换 | 法规走 knowledge.db | legal-memory-provider-knowledge-db.spec 全绿 |
| **P5** | PatentMemoryProvider 移除 KG 语义 + case-law 语义叠加 + diagnostics/config 更新 | 消费端完整切换 | 回归 + 诊断正确 |
| **P6** | build-knowledge-vectors.ts 标注 deprecated + 全量验证 + 文档收尾 | 收尾 | `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` 全绿 |

依赖：P1 独立；P2/P3 独立（可并行）；P4 依赖 P2/P3；P5 依赖 P1–P4；P6 最后。

---

## 8. 风险与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| **查询模型与库向量一致性**（Ollama vs ONNX int8，实测 0.985） | 中 | §4.4 一致性自检（阈值 0.97）+ 语义降级熔断；文档明示"查询端须 bge-m3" |
| **embeddings 全量内存 590MB**（float32） | 高 | 加载时 int8 量化（147MB）+ doc_type 过滤加载；对齐 VectorDbSearch 既有设计 |
| **kg_nodes schema 差异**（law_refs JSON / version 缺失 / 列名） | 中 | §4.2 适配层 + 双 schema 测试（旧 patent_kg.db 与新 knowledge.db 同跑） |
| **docs_fts contentless 回源** | 低 | case-law-search 已验证（rowid=chunks.id → JOIN 回源）；法条后端复用同一模式 |
| 桌面端捆绑 Node 无 FTS5 | 低 | 既有 FTS5 能力探测 + LIKE 降级机制复用（kg-store / case-law-search） |
| 214K 节点 FTS 检索性能 | 低 | trigram FTS 毫秒级（XiaoNuo 生产已用）；LIKE 降级有 MAX_OR_TERMS 限流 |
| 迁移期间旧数据源并存 | 低 | 显式 SATI_PATENT_KG_DB / SATI_LAW_DB 环境变量保留为覆盖/降级路径 |
| knowledge.db 被 mady 写锁（WAL） | 中 | 一律 `readOnly: true` 打开（既有模式）；WAL 下并发读安全 |

---

## 9. 不做（本期明确排除）

- **不重新构建向量**：不运行 build-knowledge-vectors，不新增任何 embedding 计算任务
- **不建 KG 节点向量**：kg_nodes 只有 FTS + 图谱检索（决策 2）
- **不引入 @nuo/embed-local / onnxruntime-node**：桌面端不捆绑 650MB 模型；查询端 Ollama bge-m3（同源可比）
- **不引入 @nuo/knowledge 依赖**：只复用其产物（knowledge.db）与设计模式，代码自研（Sati 项目边界）
- **不迁移 wiki 卡语义索引**（WikiCardVectorIndex 保持现状）
- **不删除** `vector-db.ts` / `build-knowledge-vectors.ts`（保留兼容，标注废弃）
- **不处理** mady 侧数据同步/版本管理（knowledge.db 的更新由 XiaoNuo 管道负责，Sati 只消费）

---

## 10. 验收标准

1. 启动后诊断清单：`patent-kg=ready`（214K）、`legal-fts=ready`（law_article）、`semantic-vectors=ready`（144K embeddings）、`kg-fts-tokenizer=trigram`；无 build-knowledge-vectors 提示
2. 图谱检索：查"无效宣告/创造性"能命中 kg_nodes 的 Case/Concept/LawArticle 节点（trigram + 邻居扩展），无 `via:"semantic"` 来源
3. 法条检索：查"专利法 第二十六条"命中 law_article 文档，FTS + 语义双路 RRF 融合
4. 判例检索：原 docs_fts 行为不变，语义路叠加后可召回措辞不同的判例
5. 一致性自检：Ollama bge-m3 下 `ok=true`（均值 ≥0.97）；换非 bge-m3 模型时 `ok=false` 且语义路降级
6. 内存：语义 reader 全量加载 ≤ 150MB（int8）
7. `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` 全绿
