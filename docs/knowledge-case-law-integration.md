# 专利判例全文检索接线（patent_case_search / knowledge.db）

> 状态：已实现（Phase 1：工具显式调用）
> 涉及工具：`patent_case_search`（domain: patent）
> 数据源：外接 `knowledge.db`（判例全文库，**通过其他渠道交付给最终用户，不随代码仓库分发**）

## 1. 用途

无效宣告分析、OA 答复需要"相似在先决定的理由论证与证据认定"作为实例支撑。`patent_case_search` 检索本地判例全文：

| 数据 | 规模 | 说明 |
|------|------|------|
| 无效复审决定（doc_type=case） | ~73,682 篇 | 含决定号（decision_number）、案号（case_number）、全文论证 |
| 专利判决（doc_type=judgment） | ~6,863 篇 | 含审理法院（court）、全文 |

检索能力：FTS5（trigram, BM25）优先 → 短查询/无 FTS 时 LIKE 降级；支持 doc_type / court 过滤；结果按文档去重（一文档一行），附命中片段（默认 ≤800 字）。

## 2. 接入方式（用户告知 knowledge.db 位置后配置）

三种方式任选其一（优先级从高到低）：

```bash
# 方式 A：环境变量指定（推荐，用户给路径即用）
export SATI_CASE_DB=/path/to/knowledge.db
pnpm dev

# 方式 B：放入默认目录（自动探测）
mkdir -p ~/.mady/knowledge
cp /path/to/knowledge.db ~/.mady/knowledge/knowledge.db

# 方式 C：自定义数据目录
export SATI_KNOWLEDGE_DIR=/custom/data/dir   # 该目录下需存在 knowledge.db 或 cases.db
```

> 与 `SATI_LAW_DB` / `SATI_PATENT_KG_DB` 机制一致：环境变量单文件覆盖 > 默认目录探测。

## 3. 验证是否接入成功

1. **启动日志**：应出现 `knowledge: ... case-law=ready ...`；若缺失则显示 `case-law=missing(SATI_CASE_DB)`
2. **直接调用**：对话中触发检索（如"检索无效宣告中创造性三步法论证的在先决定"）

## 4. 数据库结构要求（只读消费，不改写）

| 表 | 关键字段 | 说明 |
|----|---------|------|
| `documents` | id(TEXT PK), doc_type(case/judgment), title, decision_number, case_number, court, char_count | 判例元数据 |
| `chunks` | id(PK), document_id→documents.id, chunk_index, content | 全文分块 |
| `docs_fts` | FTS5 virtual table（trigram, **contentless**），rowid=chunks.id | 全文索引（缺失时自动降级 LIKE） |

- 数据库以 `readOnly` 打开，进程内单连接缓存，不产生写操作
- 无 `docs_fts` 表或运行时 SQLite 未编译 FTS5（如旧版 Node）时自动降级 LIKE，功能不崩溃但检索精度下降

## 5. 接线范围（Phase 1）

| 位置 | 变更 |
|------|------|
| `src/knowledge/config.ts` | `SATI_CASE_DB` 解析 + `KnowledgeDbPaths.caseDb` |
| `src/knowledge/case-law/` | `CaseLawSearchEngine`（FTS5 BM25 三级降级 + 文档去重） |
| `src/tool/builtin/patentCaseSearch.ts` | `patent_case_search` 内置工具 |
| `src/tool/registry/createBuiltinRegistry.ts` | 工具注册（domain: patent） |
| `src/knowledge/diagnostics.ts` | 能力自检 `case-law` 项 |
| `skills/patent-invalidity` / `patent-oa-response` / `patent-agent` | 检索接线（优先本地判例全文，网络库降级） |

## 6. 后续规划（未实现）

- **Phase 2**：`CaseLawMemoryProvider` 自动注入 `<case-law>` 摘要块（默认关闭，控制 token 成本）
- **Phase 3**：embeddings 表向量检索（需经 `scripts/build-knowledge-vectors.ts` 管道对齐 int8 量化）
