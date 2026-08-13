/**
 * 知识库运行时状态聚合（可观测性出口的数据源）。
 *
 * 由各 MemoryResolver（Patent/Legal）在检索路径打点，熔断器实例注册后
 * 透传状态；诊断端（diagnostics.resolveKnowledgeCapabilities）与 gateway
 * `knowledge.capabilities` 命令通过 `snapshot()` 只读消费。
 *
 * 设计约束：
 * - 打点全部为可选注入（provider 不传 stats 时行为与现状完全一致）；
 * - snapshot 为纯读取，不加锁——单进程内 JS 事件循环保证计数自洽；
 * - 不持有 provider 引用，仅注册熔断器（弱引用语义由调用方生命周期保证）。
 */

import type { CircuitBreaker, CircuitBreakerState } from "./circuit-breaker.js";

/** 知识图谱 FTS tokenizer 实际生效模式（kg-store 探测结果）。 */
export type KgFtsMode = "trigram" | "unicode61" | "like" | "unknown";

/** wiki 卡语义索引（运行时 JSONL）生命周期状态。 */
export type WikiSemanticIndexState = "disabled" | "warming" | "ready" | "failed";

export type KnowledgeRuntimeStatsSnapshot = {
  /** 检索结果缓存命中/未命中次数（同 query 60s TTL 复用）。 */
  cacheHits: number;
  cacheMisses: number;
  /** 语义召回（embedding/vectors.db）发起次数与失败次数。 */
  semanticCalls: number;
  semanticFailures: number;
  /** 重排（rerank）发起次数与失败次数。 */
  rerankCalls: number;
  rerankFailures: number;
  /** 已注册熔断器状态（semantic/rerank × 各 provider）。 */
  breakers: Array<{ name: string; state: CircuitBreakerState }>;
  /** KG FTS tokenizer 模式（无 KG 时 unknown）。 */
  kgFtsMode: KgFtsMode;
  /** wiki 卡语义索引状态。 */
  wikiSemanticIndex: WikiSemanticIndexState;
  /** 判例自动注入（CaseLawMemoryProvider）是否可用。 */
  caseLawAvailable: boolean;
  /** 判例自动注入累计条数。 */
  caseLawInjects: number;
  /** embedding 查询端与 knowledge.db 库向量一致性自检结果（未自检时 undefined）。 */
  embeddingConsistency?: { ok: boolean; meanCosine: number };
  /** 法规全文引擎 FTS5 已粘性降级（查询期异常后永久走 LIKE；false=未降级/无引擎）。 */
  legalFtsDegraded: boolean;
  /** 判例全文引擎 FTS5 已粘性降级（同上）。 */
  caseLawFtsDegraded: boolean;
  /** 关键词检索 LIKE 回退累计次数（短词/未命中/FTS 降级等设计内路径）。 */
  likeFallbacks: number;
};

export class KnowledgeRuntimeStats {
  private cacheHits = 0;
  private cacheMisses = 0;
  private semanticCalls = 0;
  private semanticFailures = 0;
  private rerankCalls = 0;
  private rerankFailures = 0;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private kgFtsMode: KgFtsMode = "unknown";
  private wikiSemanticIndex: WikiSemanticIndexState = "disabled";
  private caseLawAvailable = false;
  private caseLawInjects = 0;
  private embeddingConsistency?: { ok: boolean; meanCosine: number };
  private legalFtsDegraded = false;
  private caseLawFtsDegraded = false;
  private likeFallbacks = 0;

  recordCacheHit(): void {
    this.cacheHits += 1;
  }

  recordCacheMiss(): void {
    this.cacheMisses += 1;
  }

  /** 语义召回发起一次（进入 guarded 业务闭包即计数）。 */
  recordSemanticCall(): void {
    this.semanticCalls += 1;
  }

  recordSemanticFailure(): void {
    this.semanticFailures += 1;
  }

  recordRerankCall(): void {
    this.rerankCalls += 1;
  }

  recordRerankFailure(): void {
    this.rerankFailures += 1;
  }

  /** 注册熔断器（同名后注册覆盖，供 runtime 重建场景）。 */
  registerBreaker(name: string, breaker: CircuitBreaker): void {
    this.breakers.set(name, breaker);
  }

  setKgFtsMode(mode: KgFtsMode): void {
    this.kgFtsMode = mode;
  }

  setWikiSemanticIndexState(state: WikiSemanticIndexState): void {
    this.wikiSemanticIndex = state;
  }

  /** 判例自动注入可用性（CaseLawMemoryProvider 构造时打点）。 */
  setCaseLawAvailable(available: boolean): void {
    this.caseLawAvailable = available;
  }

  /** 判例自动注入一次（记录注入条数，供诊断观察注入强度）。 */
  recordCaseLawInject(count: number): void {
    this.caseLawInjects += count;
  }

  /** 记录 embedding 一致性自检结果（不达标时语义召回已降级，此处仅留痕）。 */
  setEmbeddingConsistency(result: { ok: boolean; meanCosine: number }): void {
    this.embeddingConsistency = result;
  }

  /** 法规全文引擎 FTS5 粘性降级（引擎查询期异常后打点一次）。 */
  setLegalFtsDegraded(degraded: boolean): void {
    this.legalFtsDegraded = degraded;
  }

  /** 判例全文引擎 FTS5 粘性降级（同上）。 */
  setCaseLawFtsDegraded(degraded: boolean): void {
    this.caseLawFtsDegraded = degraded;
  }

  /** 关键词检索 LIKE 回退一次（短词/未命中/FTS 降级等设计内路径）。 */
  recordLikeFallback(): void {
    this.likeFallbacks += 1;
  }

  /** 只读快照（每次新建对象，消费方可安全序列化）。 */
  snapshot(): KnowledgeRuntimeStatsSnapshot {
    return {
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      semanticCalls: this.semanticCalls,
      semanticFailures: this.semanticFailures,
      rerankCalls: this.rerankCalls,
      rerankFailures: this.rerankFailures,
      breakers: Array.from(this.breakers.entries(), ([name, breaker]) => ({ name, state: breaker.state })),
      kgFtsMode: this.kgFtsMode,
      wikiSemanticIndex: this.wikiSemanticIndex,
      caseLawAvailable: this.caseLawAvailable,
      caseLawInjects: this.caseLawInjects,
      embeddingConsistency: this.embeddingConsistency,
      legalFtsDegraded: this.legalFtsDegraded,
      caseLawFtsDegraded: this.caseLawFtsDegraded,
      likeFallbacks: this.likeFallbacks,
    };
  }
}
