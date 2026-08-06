import { reciprocalRankFusion } from "../../context/vector/rrf.js";
import type { EmbeddingClient } from "../../model/embedding/types.js";
import type { RerankClient } from "../../model/embedding/rerank.js";
import type {
  MemoryCaptureTurnInput,
  MemoryDiagnostic,
  MemoryResolver,
  MemoryRetrieveInput,
  MemoryRetrieveResult,
} from "../../context/memory/MemoryResolver.js";
import { MIN_QUERY_LENGTH, type VectorDbSearch } from "../shared/vector-db.js";
import { CircuitBreaker, guarded } from "../shared/circuit-breaker.js";
import { TtlCache } from "../shared/ttl-cache.js";
import type { KnowledgeRuntimeStats } from "../shared/knowledge-stats.js";
import { LegalSearchEngine } from "./legal-search.js";
import type { LawRecord } from "./types.js";

/**
 * LegalMemoryProvider — 法律知识库 MemoryResolver。
 *
 * 检索时对 query 做 FTS5 全文搜索；配置 embedding + vectorDb 后叠加
 * 语义召回（vectors.db("law")），双路 RRF 融合；配置 rerank 后对融合
 * 候选做 cross-encoder 重排，取 top-N 注入 <law-database> 上下文块。
 * 知识库只读，captureTurn 为空操作。
 */

export type LegalMemoryProviderOptions = {
  /** 注入的法条条数上限（默认 3）。 */
  limit?: number;
  /** 每条法条正文截断长度（默认 800 字，超出仅保留头部）。 */
  contentMaxChars?: number;
  /** 语义检索客户端（可选）；与 vectorDb 同时配置时启用法条语义召回。 */
  embedding?: EmbeddingClient;
  /** 离线向量索引（vectors.db，可选）。 */
  vectorDb?: VectorDbSearch;
  /** 重排客户端（可选，阶段 C）；配置后对融合候选做 cross-encoder 重排。 */
  rerank?: RerankClient;
  /** 参与重排的候选上限（默认 16，与 patent provider 一致）。 */
  rerankTopN?: number;
  /** 检索结果缓存 TTL ms（默认 60_000；传 0 关闭缓存）。 */
  cacheTtlMs?: number;
  /** 降级日志（语义/重排失败时记录）。 */
  logger?: { warn?: (...args: unknown[]) => void };
  /** 运行时状态聚合（可选，可观测性出口）；不传时行为与现状一致。 */
  stats?: KnowledgeRuntimeStats;
};

export class LegalMemoryProvider implements MemoryResolver {
  private readonly engine: LegalSearchEngine;
  private readonly limit: number;
  private readonly contentMaxChars: number;
  private readonly embedding?: EmbeddingClient;
  private readonly vectorDb?: VectorDbSearch;
  private readonly rerank?: RerankClient;
  private readonly rerankTopN: number;
  private readonly logger?: { warn?: (...args: unknown[]) => void };
  private readonly stats?: KnowledgeRuntimeStats;
  private readonly semanticBreaker: CircuitBreaker;
  private readonly rerankBreaker: CircuitBreaker;
  private readonly cache?: TtlCache<string, string>;

  constructor(engine: LegalSearchEngine, options: LegalMemoryProviderOptions = {}) {
    this.engine = engine;
    this.limit = options.limit ?? 3;
    this.contentMaxChars = options.contentMaxChars ?? 800;
    this.embedding = options.embedding;
    this.vectorDb = options.vectorDb;
    this.rerank = options.rerank;
    this.rerankTopN = options.rerankTopN ?? 16;
    this.logger = options.logger;
    this.stats = options.stats;
    this.semanticBreaker = new CircuitBreaker({ logger: options.logger });
    this.rerankBreaker = new CircuitBreaker({ logger: options.logger });
    this.stats?.registerBreaker("legal:semantic", this.semanticBreaker);
    this.stats?.registerBreaker("legal:rerank", this.rerankBreaker);
    const cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.cache = cacheTtlMs > 0 ? new TtlCache<string, string>({ ttlMs: cacheTtlMs }) : undefined;
  }

  async retrieve(input: MemoryRetrieveInput): Promise<MemoryRetrieveResult> {
    const diagnostics: MemoryDiagnostic[] = [];
    const trimmed = input.query.trim();
    if (Array.from(trimmed).length < 2) {
      return { systemContext: undefined, diagnostics };
    }
    if (this.cache) {
      const cached = this.cache.get(trimmed);
      if (cached !== undefined) {
        this.stats?.recordCacheHit();
        return {
          systemContext: cached || undefined,
          diagnostics: [
            { code: "memory_cache_hit", message: "法律知识检索缓存命中（同 query 短时复用）", severity: "info" },
          ],
        };
      }
      this.stats?.recordCacheMiss();
    }

    // 1. 关键词路：FTS5 BM25
    const keywordResults = this.engine.search(trimmed, { limit: this.limit });

    // 2. 语义路（可选）：vectors.db("law") top-k，同名去重（与 FTS 一致）
    const semanticRecords = await this.searchSemantic(trimmed);

    if (keywordResults.length === 0 && semanticRecords.length === 0) {
      if (this.cache && !input.signal?.aborted) {
        this.cache.set(trimmed, "");
      }
      return { systemContext: undefined, diagnostics };
    }

    // 3. 双路 RRF 融合（按 name 对齐：FTS 已按 name 去重取最新版）
    const byName = new Map<string, LawRecord>();
    for (const result of keywordResults) {
      if (!byName.has(result.name)) byName.set(result.name, result);
    }
    for (const record of semanticRecords) {
      if (!byName.has(record.name)) byName.set(record.name, record);
    }
    const fused = reciprocalRankFusion<string>([
      keywordResults.map(result => ({ id: result.name })),
      semanticRecords.map(record => ({ id: record.name })),
    ]);
    let merged = fused.map(item => byName.get(item.id)).filter((record): record is LawRecord => record !== undefined);

    // 可选重排（阶段 C）：cross-encoder 对融合候选重新打分
    const rerank = this.rerank;
    if (rerank && merged.length > 1) {
      const rerankLimit = this.rerankTopN > 0 ? Math.min(this.rerankTopN, merged.length) : merged.length;
      merged = await guarded(
        this.rerankBreaker,
        merged,
        async () => {
          this.stats?.recordRerankCall();
          const docs = merged.map(record => `${record.name}\n${this.truncate(record.content ?? "")}`);
          const results = await rerank.rerank(trimmed, docs, rerankLimit);
          return results
            .map(result => merged[result.index])
            .filter((record): record is LawRecord => record !== undefined);
        },
        error => {
          this.stats?.recordRerankFailure();
          this.logger?.warn?.(`[legal-memory] rerank 失败，保持融合顺序: ${errorMessage(error)}`);
        },
      );
    }
    merged = merged.slice(0, this.limit);
    if (merged.length === 0) {
      return { systemContext: undefined, diagnostics };
    }

    const lines = merged.map(result => {
      const content = result.content ? this.truncate(result.content) : "";
      return `- [${result.level}] ${result.name}（${result.categoryName ?? "未分类"}）\n  ${content}`;
    });
    const blocks = [`<law-database>\n${lines.join("\n")}\n</law-database>`];

    if (this.cache && !input.signal?.aborted) {
      this.cache.set(trimmed, blocks.join("\n\n"));
    }

    return { systemContext: blocks.join("\n\n"), diagnostics };
  }

  async captureTurn(_input: MemoryCaptureTurnInput): Promise<void> {
    // 知识库只读，无记忆捕获。
  }

  private async searchSemantic(query: string): Promise<LawRecord[]> {
    const embedding = this.embedding;
    const vectorDb = this.vectorDb;
    if (!embedding || !vectorDb || !vectorDb.hasCorpus("law")) return [];
    if (Array.from(query).length < MIN_QUERY_LENGTH) return [];
    return guarded(
      this.semanticBreaker,
      [],
      async () => {
        this.stats?.recordSemanticCall();
        const [queryVector] = await embedding.embed([query]);
        if (!queryVector || queryVector.length === 0) return [];
        const hits = vectorDb.search("law", Float32Array.from(queryVector), this.limit * 2);
        // 批量按 id 取回（一次 IN 查询），再按 hits 的向量相似度顺序重排去重截断——
        // getByIds 无 ORDER BY（DB 行序），若直接按返回序去重会破坏相似度优先语义。
        const byId = new Map<string, LawRecord>();
        for (const record of this.engine.getByIds(hits.map(hit => hit.docId))) {
          byId.set(record.id, record);
        }
        const seenNames = new Set<string>();
        const deduped: LawRecord[] = [];
        for (const hit of hits) {
          const record = byId.get(hit.docId);
          if (!record || seenNames.has(record.name)) continue;
          seenNames.add(record.name);
          deduped.push(record);
          if (deduped.length >= this.limit) break;
        }
        return deduped;
      },
      error => {
        this.stats?.recordSemanticFailure();
        this.logger?.warn?.(`[legal-memory] 法条语义召回失败，降级为纯 FTS: ${errorMessage(error)}`);
      },
    );
  }

  private truncate(text: string): string {
    if (text.length <= this.contentMaxChars) return text;
    return `${text.slice(0, this.contentMaxChars)}…（截断）`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
