import { join } from "node:path";
import { reciprocalRankFusion } from "../../context/vector/rrf.js";
import type { EmbeddingClient } from "../../model/embedding/types.js";
import type { RerankClient } from "../../model/embedding/rerank.js";
import { MIN_QUERY_LENGTH, type VectorDbSearch } from "../shared/vector-db.js";
import { CircuitBreaker, guarded } from "../shared/circuit-breaker.js";
import { TtlCache } from "../shared/ttl-cache.js";
import { defaultEmbeddingDir } from "../config.js";
import type {
  MemoryCaptureTurnInput,
  MemoryDiagnostic,
  MemoryResolver,
  MemoryRetrieveInput,
  MemoryRetrieveResult,
} from "../../context/memory/MemoryResolver.js";
import { classifyIpc, isHighConfidence } from "./ipc-classifier.js";
import { formatStandardsAsContext, queryIpcStandards } from "./ipc-standards-loader.js";
import { PatentKgAdapter } from "./patent-kg-adapter.js";
import { WikiCardLoader } from "./wiki-card-loader.js";
import { WikiCardVectorIndex } from "./wiki-card-vector-index.js";

/**
 * PatentMemoryProvider — 专利知识库 MemoryResolver。
 *
 * 检索时按输入 query 做 IPC 分类，注入对应部（A-H）的审查标准卡片；
 * 再查询知识图谱相关节点（关键词 + 可选语义双路，RRF 融合，可选 rerank）；
 * 图谱命中 WikiCard 节点时联动加载卡片正文。知识库只读，captureTurn 为空操作。
 *
 * 可选语义增强：配置 `embedding` 后启用 wiki 卡语义召回；
 * 再配置 `vectorDb`（build-knowledge-vectors.ts 产物）后启用 KG 节点语义召回；
 * 配置 `rerank` 后对融合候选做 cross-encoder 重排。
 */

type GraphHit = {
  node: { id: string; nodeType: string; name?: string; title?: string };
  via: "keyword" | "similar" | "cites" | "semantic";
  relation?: string;
  /** 节点正文预览（供 rerank 打分；不注入上下文）。 */
  text?: string;
};

export type PatentMemoryProviderOptions = {
  /** 知识图谱适配器；缺省时跳过图谱检索。 */
  kgAdapter?: PatentKgAdapter;
  /** wiki 卡片加载器；缺省时跳过卡片正文注入。 */
  wikiLoader?: WikiCardLoader;
  /** 是否注入知识图谱上下文（默认 true）。 */
  enableGraph?: boolean;
  /** 是否注入 IPC 审查标准（默认 true）。 */
  enableStandards?: boolean;
  /** 图谱相关节点上限（默认 8）。 */
  graphLimit?: number;
  /** 卡片正文注入上限（默认 2）。 */
  cardLimit?: number;
  /** 语义检索客户端（可选）；配置后启用 wiki 卡/KG 节点语义召回。 */
  embedding?: EmbeddingClient;
  /** 向量持久化目录（默认见 knowledge/config.ts 的 defaultEmbeddingDir）。 */
  embeddingDir?: string;
  /** 离线向量索引（vectors.db，可选）；配置后启用 KG 节点语义召回。 */
  vectorDb?: VectorDbSearch;
  /** 重排客户端（可选，阶段 C）；配置后对融合候选做 cross-encoder 重排。 */
  rerank?: RerankClient;
  /** 参与重排的候选上限（默认 16）。 */
  rerankTopN?: number;
  /**
   * 是否启用 wiki 卡语义索引（默认 true）。
   *
   * ⚠️ 写路径声明：启用后首次使用会在运行时**写入** `${embeddingDir}/wiki.jsonl`
   * （后台预热全量 embed 并持久化）——这是知识库唯一"运行时写"路径，与
   * "知识库只读"的总体约束不同。需要完全只读时置 false（KG 语义召回
   * 经 vectors.db 离线索引，不受此开关影响）。
   */
  semanticIndexEnabled?: boolean;
  /** 检索结果缓存 TTL ms（默认 60_000；传 0 关闭缓存）。 */
  cacheTtlMs?: number;
  /** 降级日志（语义/重排失败时记录）。 */
  logger?: { warn?: (...args: unknown[]) => void };
};

export class PatentMemoryProvider implements MemoryResolver {
  private readonly kgAdapter?: PatentKgAdapter;
  private readonly wikiLoader?: WikiCardLoader;
  private readonly enableGraph: boolean;
  private readonly enableStandards: boolean;
  private readonly graphLimit: number;
  private readonly cardLimit: number;
  private readonly embedding?: EmbeddingClient;
  private readonly embeddingDir: string;
  private readonly vectorDb?: VectorDbSearch;
  private readonly rerank?: RerankClient;
  private readonly rerankTopN: number;
  private readonly semanticIndexEnabled: boolean;
  private readonly logger?: { warn?: (...args: unknown[]) => void };
  private semanticCards?: WikiCardVectorIndex;
  private readonly semanticBreaker: CircuitBreaker;
  private readonly rerankBreaker: CircuitBreaker;
  private readonly cache?: TtlCache<string, string>;

  constructor(options: PatentMemoryProviderOptions = {}) {
    this.kgAdapter = options.kgAdapter;
    this.wikiLoader = options.wikiLoader;
    this.enableGraph = options.enableGraph ?? true;
    this.enableStandards = options.enableStandards ?? true;
    this.graphLimit = options.graphLimit ?? 8;
    this.cardLimit = options.cardLimit ?? 2;
    this.embedding = options.embedding;
    this.embeddingDir = options.embeddingDir ?? defaultEmbeddingDir();
    this.vectorDb = options.vectorDb;
    this.rerank = options.rerank;
    this.rerankTopN = options.rerankTopN ?? 16;
    this.semanticIndexEnabled = options.semanticIndexEnabled ?? true;
    this.logger = options.logger;
    this.semanticBreaker = new CircuitBreaker({ logger: options.logger });
    this.rerankBreaker = new CircuitBreaker({ logger: options.logger });
    const cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.cache = cacheTtlMs > 0 ? new TtlCache<string, string>({ ttlMs: cacheTtlMs }) : undefined;
  }

  async retrieve(input: MemoryRetrieveInput): Promise<MemoryRetrieveResult> {
    const cacheKey = input.query.trim();
    if (this.cache && cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        return {
          systemContext: cached || undefined,
          diagnostics: [
            { code: "memory_cache_hit", message: "知识检索缓存命中（同 query 短时复用）", severity: "info" },
          ],
        };
      }
    }

    const diagnostics: MemoryDiagnostic[] = [];
    const blocks: string[] = [];

    // 1. IPC 分类 → 注入审查标准
    if (this.enableStandards) {
      const classification = classifyIpc(input.query);
      const top = classification[0];
      // 门槛：≥2 个关键词命中才注入（单关键词碰巧命中不注入，避免普通
      // 对话被注入 IPC 审查标准；无命中默认 B/0.15 也不注入）
      if (top && top.matchedKeywords.length >= 2) {
        const cards = queryIpcStandards(top.section);
        if (cards.length > 0) {
          const text = formatStandardsAsContext(cards);
          blocks.push(`<ipc-standards section="${top.section}">\n${text}\n</ipc-standards>`);
        }
        if (isHighConfidence(top.confidence)) {
          diagnostics.push({
            code: "memory_ipc_classified",
            message: `IPC 分类 ${top.section} 高置信度（${top.confidence.toFixed(2)}）`,
            severity: "info",
          });
        }
      }
    }

    // 2. 知识图谱检索（关键词 + 可选语义，RRF 融合；query 足够长才触发）
    const graphNodes = await this.queryGraph(input);
    if (graphNodes.length > 0) {
      const lines = graphNodes.map(hit => {
        const label = hit.node.name || hit.node.title || hit.node.id;
        const viaLabel =
          hit.via === "similar"
            ? `（相似:${hit.relation ?? ""}）`
            : hit.via === "cites"
              ? `（引用:${hit.relation ?? ""}）`
              : hit.via === "semantic"
                ? "（语义）"
                : "";
        return `- [${hit.node.nodeType}] ${label}${viaLabel}`;
      });
      blocks.push(`<knowledge-graph>\n${lines.join("\n")}\n</knowledge-graph>`);
    }

    // 3. 图谱命中 WikiCard 节点时联动加载卡片正文
    if (this.wikiLoader) {
      const cardContexts = await this.loadWikiCards(graphNodes, input);
      blocks.push(...cardContexts);
    }

    const systemContext = blocks.length > 0 ? blocks.join("\n\n") : undefined;
    if (this.cache && cacheKey && !input.signal?.aborted) {
      this.cache.set(cacheKey, systemContext ?? "");
    }
    return { systemContext, diagnostics };
  }

  async captureTurn(_input: MemoryCaptureTurnInput): Promise<void> {
    // 知识库只读，无记忆捕获。
  }

  /** 知识图谱检索：关键词路（+ 关系扩展）与语义路（vectors.db）RRF 融合，可选 rerank。 */
  private async queryGraph(input: MemoryRetrieveInput): Promise<GraphHit[]> {
    if (!this.enableGraph || !this.kgAdapter || Array.from(input.query.trim()).length < MIN_QUERY_LENGTH) return [];
    if (input.signal?.aborted) return [];

    const keywordHits = this.kgAdapter.searchRelevant(input.query, { keywordLimit: 4, expandLimit: 5 }).map(hit => ({
      node: { id: hit.node.id, nodeType: hit.node.nodeType, name: hit.node.name, title: hit.node.title },
      via: hit.via,
      relation: hit.relation,
      text: buildNodeText(hit.node),
    }));
    const semanticHits = await this.queryGraphSemantic(input);

    const all = [...keywordHits, ...semanticHits];
    if (all.length === 0) return [];
    if (semanticHits.length === 0) {
      const reranked = await this.tryRerankOrder(
        input.query,
        keywordHits,
        hit => this.graphHitText(hit),
        this.rerankTopN,
      );
      return reranked.slice(0, this.graphLimit);
    }

    // 双路 RRF 融合排序（关键词路 rank 与语义路 rank 各自贡献）
    const fused = reciprocalRankFusion<string>([
      keywordHits.map(hit => ({ id: hit.node.id })),
      semanticHits.map(hit => ({ id: hit.node.id })),
    ]);
    const byId = new Map(all.map(hit => [hit.node.id, hit]));
    const ordered = fused.map(item => byId.get(item.id)).filter((hit): hit is GraphHit => hit !== undefined);
    const reranked = await this.tryRerankOrder(input.query, ordered, hit => this.graphHitText(hit), this.rerankTopN);
    return reranked.slice(0, this.graphLimit);
  }

  private graphHitText(hit: GraphHit): string {
    return hit.text || hit.node.name || hit.node.title || hit.node.id;
  }

  /** 语义召回路：embed query → vectors.db("kg") top-k → 回查节点详情。 */
  private async queryGraphSemantic(input: MemoryRetrieveInput): Promise<GraphHit[]> {
    const embedding = this.embedding;
    const vectorDb = this.vectorDb;
    if (!embedding || !vectorDb || !vectorDb.hasCorpus("kg")) return [];
    if (input.signal?.aborted) return [];
    return guarded(
      this.semanticBreaker,
      [],
      async () => {
        const [queryVector] = await embedding.embed([input.query]);
        if (!queryVector || queryVector.length === 0) return [];
        const hits = vectorDb.search("kg", Float32Array.from(queryVector), this.graphLimit);
        const graphHits: GraphHit[] = [];
        for (const hit of hits) {
          const node = this.kgAdapter?.getNode(hit.docId);
          if (!node) continue;
          graphHits.push({
            node: { id: node.id, nodeType: node.nodeType, name: node.name, title: node.title },
            via: "semantic",
            text: buildNodeText(node),
          });
        }
        return graphHits;
      },
      error => this.logger?.warn?.(`[patent-memory] KG 语义召回失败，降级为纯关键词: ${errorMessage(error)}`),
    );
  }

  /** wiki 卡片检索：图谱 WikiCard 节点 + query 关键词 + 语义召回三路命中。 */
  private async loadWikiCards(
    graphNodes: Array<{ node: { id: string; name?: string; title?: string; nodeType: string } }>,
    input: MemoryRetrieveInput,
  ): Promise<string[]> {
    if (input.signal?.aborted) return [];
    const contexts: string[] = [];
    let loaded = 0;
    const seen = new Set<string>();

    const loader = this.wikiLoader;
    if (!loader) return [];

    const pushCard = (id: string) => {
      if (loaded >= this.cardLimit || seen.has(id)) return;
      seen.add(id);
      const text = loader.formatAsContext(id, 800);
      if (!text) return;
      contexts.push(`<wiki-card>${text}</wiki-card>`);
      loaded += 1;
    };

    // 1. 图谱 WikiCard 节点 → 按 id/标题匹配
    for (const hit of graphNodes) {
      if (loaded >= this.cardLimit) break;
      if (hit.node.nodeType !== "WikiCard") continue;
      const byId = loader.getById(hit.node.id);
      const byTitle = byId ? undefined : loader.search(hit.node.name ?? hit.node.title ?? "", 1)[0];
      if (byId) pushCard(byId.id);
      else if (byTitle) pushCard(byTitle.id);
    }

    // 2. query 关键词 → 标题/概念/领域搜索（卡片独立于图谱可用）
    if (loaded < this.cardLimit) {
      const keywords = this.extractCardKeywords(input.query);
      for (const kw of keywords) {
        if (loaded >= this.cardLimit) break;
        const hits = loader.search(kw, 3);
        for (const hit of hits) {
          pushCard(hit.id);
          if (loaded >= this.cardLimit) break;
        }
      }
    }

    // 3. 语义召回（可选）：embedding 检索卡片正文，补充关键词漏召回；
    //    配置 rerank 时先取更多候选再 cross-encoder 重排
    if (loaded < this.cardLimit) {
      const semantic = this.getSemanticCards();
      if (semantic) {
        await guarded(
          this.semanticBreaker,
          undefined,
          async () => {
            const remaining = this.cardLimit - loaded;
            const candidateLimit = this.rerank ? remaining * 3 : remaining;
            const hits = await semantic.search(input.query, candidateLimit);
            const orderedIds = await this.tryRerankOrder(
              input.query,
              hits.map(hit => hit.id),
              id => loader.formatAsContext(id, 500),
              remaining,
            );
            for (const id of orderedIds) {
              pushCard(id);
              if (loaded >= this.cardLimit) break;
            }
          },
          error =>
            this.logger?.warn?.(`[patent-memory] wiki 语义召回失败，降级为图谱/关键词路径: ${errorMessage(error)}`),
        );
      }
    }
    return contexts;
  }

  /** 通用重排助手：cross-encoder 对候选重新打分（失败/未配置保持原序）。 */
  private async tryRerankOrder<T>(query: string, items: T[], toText: (item: T) => string, topN: number): Promise<T[]> {
    const rerank = this.rerank;
    if (!rerank || items.length <= 1) return items;
    return guarded(
      this.rerankBreaker,
      items,
      async () => {
        const docs = items.map(toText);
        const results = await rerank.rerank(query, docs, topN);
        return results.map(result => items[result.index]).filter((item): item is T => item !== undefined);
      },
      error => this.logger?.warn?.(`[patent-memory] rerank 失败，保持原序: ${errorMessage(error)}`),
    );
  }

  /** 懒建 wiki 卡语义索引（首次使用触发全量索引 + 后台预热）。 */
  private getSemanticCards(): WikiCardVectorIndex | undefined {
    // semanticIndexEnabled=false 时跳过（保持"知识库完全只读"；KG 语义召回走离线 vectors.db）
    if (!this.embedding || !this.wikiLoader || !this.semanticIndexEnabled) return undefined;
    if (!this.semanticCards) {
      const storePath = join(this.embeddingDir, "wiki.jsonl");
      const index = new WikiCardVectorIndex({
        loader: this.wikiLoader,
        client: this.embedding,
        storePath,
      });
      this.semanticCards = index;
      // 后台预热：wiki 卡静态，首次全量索引后持久化到 storePath（知识库唯一运行时写路径），
      // 不阻塞当前检索。写入失败由 VectorIndex.persist 的 logger.warn 报告。
      void index.warmup().catch(error => {
        this.logger?.warn?.(`[patent-memory] wiki 语义索引预热失败，search 时会重试: ${errorMessage(error)}`);
      });
    }
    return this.semanticCards;
  }

  /** 提取 query 中的检索词（长句切分，供卡片标题匹配）。 */
  private extractCardKeywords(query: string): string[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const runes = Array.from(trimmed);
    if (runes.length <= 8) return [trimmed];
    const parts = trimmed
      .split(/[\s，。？！、；：,.;!?]+/)
      .flatMap(p => p.split(/(?:的|是|吗|呢|什么|如何|怎么|是否|哪些|一个|一种|以及|如果|那么)/))
      .map(p => p.trim())
      .filter(p => Array.from(p).length >= 4);
    return parts.length > 0 ? parts.slice(0, 3) : [trimmed];
  }
}

/** 节点正文预览（供 rerank 打分；不注入上下文）。 */
function buildNodeText(node: { name?: string; title?: string; content?: string }): string {
  return [node.name, node.title, node.content]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .slice(0, 600);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
