# Agent Note: 专利知识检索的类型/分数过滤与二阶段精排

Status: implemented

## Problem

`patent_kg_query("创造性")` 会返回「侵权-原理-专利权评价报告」类节点：`searchRelevant` 只做关键词召回 + SIMILAR/CITE 扩展，没有类型过滤与分数阈值；中文 FTS 对三字词召回噪声大，关系扩展进一步稀释相关性。`patent_wiki_search` 对同名卡片重复返回。

## Decision

`PatentKgAdapter.searchRelevant` 为每条命中计算 0..1 相关性分（命中方式 75% + query 词面重合 25%），支持 `nodeTypes`（别名展开）与 `minScore` 过滤；有类型过滤时先超取再筛选，避免前 N 条全被过滤成空。结果按分数降序，`patent_kg_query` 输出 `score` / `nodeType`，并新增 `node_types` / `min_score` 入参。

新增可选 `rerank`：复用 `patent_candidate_rerank` 的 `rerankCandidatesWithModel` 做 LLM 二阶段精排；缺模型或调用失败时保持原序并返回 `rerank.degraded=true`。`patent_wiki_search` 先超取、按 title 去重保留最高分，再按分数截断，输出带 `score`。

5 条 golden query（创造性 / 新颖性 / 侵权 / 权利要求清楚性 / 无效证据）断言 top-3 的 `nodeType` 落在期望集合内。

## Alternatives considered

- **直接在 SQL 层加 BM25 阈值** — `KgStore` 的 FTS 查询只取 id，未暴露每行分数；改查询契约会影响所有图谱消费方。
- **用 embedding 精排替代 LLM 精排** — 需要额外模型与索引，超出本次整改范围；复用现成 rerank 通道成本最低。
- **按 title 去重时保留第一条** — 第一条未必是最高分；保留最高分才能让 `score` 与去重逻辑一致。
- **rerank 失败时抛错** — 检索主链路会因可选增强失败而中断；原序 + degraded 符合「降级但不静默」。

## Consequences

每条图谱命中都带分数，模型可以按阈值裁剪；`min_score` 过高时可能返回空结果，这是显式过滤而非解析失败。`node_types`/`min_score`/`rerank` 进入 `inputSchema`，llm-replay fixture 已重录。golden query 测试使用内存假 store，不依赖本地 knowledge.db。
