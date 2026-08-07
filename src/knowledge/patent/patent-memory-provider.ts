import { join } from "node:path";
import type { EmbeddingClient } from "../../model/embedding/types.js";
import type { RerankClient } from "../../model/embedding/rerank.js";
import { MIN_QUERY_LENGTH } from "../shared/vector-db.js";
import { CircuitBreaker, guarded } from "../shared/circuit-breaker.js";
import { TtlCache } from "../shared/ttl-cache.js";
import type { KnowledgeRuntimeStats } from "../shared/knowledge-stats.js";
import { defaultEmbeddingDir } from "../config.js";
import type {
  MemoryCaptureTurnInput,
  MemoryDiagnostic,
  MemoryResolver,
  MemoryRetrieveInput,
  MemoryRetrieveResult,
  TaskIntent,
} from "../../context/memory/MemoryResolver.js";
import {
  classifyIpc,
  IPC_DETAIL_MIN_CONFIDENCE,
  isHighConfidence,
  MULTI_CLASSIFY_MIN_CONFIDENCE,
} from "./ipc-classifier.js";
import { formatStandardsAsContext, queryIpcDetail, queryIpcStandards } from "./ipc-standards-loader.js";
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
 * 配置 `rerank` 后对融合候选做 cross-encoder 重排。
 * 注：KG 节点不建向量（与 XiaoNuo 设计一致），图谱检索为关键词 + 关系扩展。
 */

type GraphHit = {
  node: { id: string; nodeType: string; name?: string; title?: string };
  via: "keyword" | "similar" | "cites";
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
  /** IPC 审查标准注入上限（默认 0 = 不截断；>0 时按卡片顺序截取前 N 张，防止部级回退时上下文膨胀）。 */
  standardsLimit?: number;
  /** 多重分类并行注入的部/大类数上限（默认 2：top + 并列高置信部；1 等价关闭多重注入）。 */
  multiSectionLimit?: number;
  /** 语义检索客户端（可选）；配置后启用 wiki 卡语义召回。 */
  embedding?: EmbeddingClient;
  /** 向量持久化目录（默认见 knowledge/config.ts 的 defaultEmbeddingDir）。 */
  embeddingDir?: string;
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
  /** 运行时状态聚合（可选，可观测性出口）；不传时行为与现状一致。 */
  stats?: KnowledgeRuntimeStats;
};

export class PatentMemoryProvider implements MemoryResolver {
  private readonly kgAdapter?: PatentKgAdapter;
  private readonly wikiLoader?: WikiCardLoader;
  private readonly enableGraph: boolean;
  private readonly enableStandards: boolean;
  private readonly graphLimit: number;
  private readonly cardLimit: number;
  private readonly standardsLimit: number;
  private readonly multiSectionLimit: number;
  private readonly embedding?: EmbeddingClient;
  private readonly embeddingDir: string;
  private readonly rerank?: RerankClient;
  private readonly rerankTopN: number;
  private readonly semanticIndexEnabled: boolean;
  private readonly logger?: { warn?: (...args: unknown[]) => void };
  private readonly stats?: KnowledgeRuntimeStats;
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
    this.standardsLimit = options.standardsLimit ?? 0;
    this.multiSectionLimit = options.multiSectionLimit ?? 2;
    this.embedding = options.embedding;
    this.embeddingDir = options.embeddingDir ?? defaultEmbeddingDir();
    this.rerank = options.rerank;
    this.rerankTopN = options.rerankTopN ?? 16;
    this.semanticIndexEnabled = options.semanticIndexEnabled ?? true;
    this.logger = options.logger;
    this.stats = options.stats;
    this.semanticBreaker = new CircuitBreaker({ logger: options.logger });
    this.rerankBreaker = new CircuitBreaker({ logger: options.logger });
    this.stats?.registerBreaker("patent:semantic", this.semanticBreaker);
    this.stats?.registerBreaker("patent:rerank", this.rerankBreaker);
    // KG FTS 探测（诊断用）：kgAdapter.ftsMode 反映 kg-store 实际生效的分词器
    // （trigram/unicode61/none；none 表示 FTS5 不可用已回退 LIKE）。
    if (this.stats && options.kgAdapter) {
      const mode = options.kgAdapter.ftsMode();
      this.stats.setKgFtsMode(mode === "none" ? "like" : mode);
    }
    const cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.cache = cacheTtlMs > 0 ? new TtlCache<string, string>({ ttlMs: cacheTtlMs }) : undefined;
  }

  async retrieve(input: MemoryRetrieveInput): Promise<MemoryRetrieveResult> {
    const cacheKey = input.query.trim();
    if (this.cache && cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        this.stats?.recordCacheHit();
        return {
          systemContext: cached || undefined,
          diagnostics: [
            { code: "memory_cache_hit", message: "知识检索缓存命中（同 query 短时复用）", severity: "info" },
          ],
        };
      }
      this.stats?.recordCacheMiss();
    }

    const diagnostics: MemoryDiagnostic[] = [];
    const blocks: string[] = [];

    // 1. IPC 分类 → 注入审查标准（多重分类：置信度达门槛的部并行注入）
    if (this.enableStandards) {
      const classification = classifyIpc(input.query);
      // 门槛：confidence >= MULTI_CLASSIFY_MIN_CONFIDENCE（与部级命中 ≥2 词等价），
      // 或大类命中达标（detailConfidence >= IPC_DETAIL_MIN_CONFIDENCE，≈ 大类 ≥2 词）——
      // 后者覆盖"部级单命中但大类多命中"的典型专利 query（如"汽车座椅"部级仅 1 词、
      // B60 大类 3 词）。单关键词碰巧命中不注入，避免普通对话被注入 IPC 审查标准；
      // 无命中默认 B/0.15 低于门槛也不注入。最多并行注入 multiSectionLimit 个部。
      const candidates = classification.filter(
        c =>
          c.confidence >= MULTI_CLASSIFY_MIN_CONFIDENCE ||
          (c.detailConfidence !== undefined && c.detailConfidence >= IPC_DETAIL_MIN_CONFIDENCE),
      );
      // 项目知识偏好：声明了 ipcSections 的部，若 query 已命中其任一候选
      // （classification 中存在该 section），则无视置信度门槛强制纳入注入并
      // 提升优先级——覆盖"项目专注领域但本次 query 措辞弱命中"的场景。
      let effectiveCandidates = candidates;
      const profile = input.knowledgeProfile;
      if (profile?.ipcSections && profile.ipcSections.length > 0) {
        const wanted = new Set(profile.ipcSections);
        effectiveCandidates = [...candidates];
        for (const cand of classification) {
          if (wanted.has(cand.section) && !effectiveCandidates.includes(cand)) effectiveCandidates.push(cand);
        }
        effectiveCandidates.sort((a, b) => {
          const aw = wanted.has(a.section) ? 1 : 0;
          const bw = wanted.has(b.section) ? 1 : 0;
          return bw - aw || b.confidence - a.confidence;
        });
      }
      for (const cand of effectiveCandidates.slice(0, this.multiSectionLimit)) {
        // 两级分类：大类命中置信度达标（≈ 大类关键词 ≥2 个）时精注入大类卡片，
        // 否则回退部级注入（向后兼容；未列入高频大类的部永远走回退）。
        const cards =
          cand.detail && cand.detailConfidence !== undefined && cand.detailConfidence >= IPC_DETAIL_MIN_CONFIDENCE
            ? queryIpcDetail(cand.detail)
            : queryIpcStandards(cand.section);
        const limited = this.standardsLimit > 0 ? cards.slice(0, this.standardsLimit) : cards;
        if (limited.length > 0) {
          const text = formatStandardsAsContext(limited);
          blocks.push(`<ipc-standards section="${cand.section}">\n${text}\n</ipc-standards>`);
        }
        if (isHighConfidence(cand.confidence)) {
          diagnostics.push({
            code: "memory_ipc_classified",
            message: `IPC 分类 ${cand.section}${cand.detail ? `/${cand.detail}` : ""} 高置信度（${cand.confidence.toFixed(2)}）`,
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
              : "";
        return `- [${hit.node.nodeType}] ${label}${viaLabel}`;
      });
      blocks.push(`<knowledge-graph>\n${lines.join("\n")}\n</knowledge-graph>`);
    }

    // 3. 图谱命中 WikiCard 节点时联动加载卡片正文
    if (this.wikiLoader) {
      const cardContexts = await this.loadWikiCards(graphNodes, input, this.effectiveCardLimit(input.taskIntent));
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

  /**
   * 预热 wiki 卡语义索引（幂等；全量 embed 在后台执行，不阻塞调用方）。
   *
   * 由组装层（buildKnowledgeResolvers）在启动时调用，把首次全量 embed
   * 移出用户检索路径——否则首次检索会撞上分钟级全量 embed。未配置
   * embedding / wikiLoader 或 indexWiki=false 时为空操作。
   * 返回 promise 供调用方选择等待（测试/预热完成确认）。
   */
  warmupSemanticIndex(): Promise<void> {
    const semantic = this.getSemanticCards();
    if (!semantic) return Promise.resolve();
    return semantic.warmup();
  }

  /**
   * 按任务意图调整 wiki 卡片注入上限：OA/无效类任务知识需求密集
   * （必查清单常超过默认 2 张上限），提升至 ≥4；其余任务保持默认，
   * 避免普通对话上下文膨胀。
   */
  private effectiveCardLimit(taskIntent?: TaskIntent): number {
    return taskIntent === "oa" || taskIntent === "invalidity" ? Math.max(this.cardLimit, 4) : this.cardLimit;
  }

  /** 知识图谱检索：关键词路（+ 关系扩展），可选 rerank（KG 节点不建向量，无语义路）。 */
  private async queryGraph(input: MemoryRetrieveInput): Promise<GraphHit[]> {
    if (!this.enableGraph || !this.kgAdapter || Array.from(input.query.trim()).length < MIN_QUERY_LENGTH) return [];
    if (input.signal?.aborted) return [];

    const keywordHits = this.kgAdapter.searchRelevant(input.query, { keywordLimit: 4, expandLimit: 5 }).map(hit => ({
      node: { id: hit.node.id, nodeType: hit.node.nodeType, name: hit.node.name, title: hit.node.title },
      via: hit.via,
      relation: hit.relation,
      text: buildNodeText(hit.node),
    }));
    if (keywordHits.length === 0) return [];

    const reranked = await this.tryRerankOrder(
      input.query,
      keywordHits,
      hit => this.graphHitText(hit),
      this.rerankTopN,
    );
    return reranked.slice(0, this.graphLimit);
  }

  private graphHitText(hit: GraphHit): string {
    return hit.text || hit.node.name || hit.node.title || hit.node.id;
  }

  /** wiki 卡片检索：图谱 WikiCard 节点 + query 关键词 + 语义召回三路命中。 */
  private async loadWikiCards(
    graphNodes: Array<{ node: { id: string; name?: string; title?: string; nodeType: string } }>,
    input: MemoryRetrieveInput,
    cardLimit: number = this.cardLimit,
  ): Promise<string[]> {
    if (input.signal?.aborted) return [];
    const contexts: string[] = [];
    let loaded = 0;
    const seen = new Set<string>();

    const loader = this.wikiLoader;
    if (!loader) return [];

    const pushCard = (id: string) => {
      if (loaded >= cardLimit || seen.has(id)) return;
      seen.add(id);
      const text = loader.formatAsContext(id, 800);
      if (!text) return;
      contexts.push(`<wiki-card>${text}</wiki-card>`);
      loaded += 1;
    };

    // 1. 图谱 WikiCard 节点 → 按 id/标题匹配
    for (const hit of graphNodes) {
      if (loaded >= cardLimit) break;
      if (hit.node.nodeType !== "WikiCard") continue;
      const byId = loader.getById(hit.node.id);
      const byTitle = byId ? undefined : loader.search(hit.node.name ?? hit.node.title ?? "", 1)[0];
      if (byId) pushCard(byId.id);
      else if (byTitle) pushCard(byTitle.id);
    }

    // 2. query 关键词 → 标题/概念/领域搜索（卡片独立于图谱可用）
    if (loaded < cardLimit) {
      const keywords = this.extractCardKeywords(input.query);
      for (const kw of keywords) {
        if (loaded >= cardLimit) break;
        const hits = loader.search(kw, 3);
        for (const hit of hits) {
          pushCard(hit.id);
          if (loaded >= cardLimit) break;
        }
      }
    }

    // 3. 语义召回（可选）：embedding 检索卡片正文，补充关键词漏召回；
    //    配置 rerank 时先取更多候选再 cross-encoder 重排
    if (loaded < cardLimit) {
      const semantic = this.getSemanticCards();
      if (semantic) {
        await guarded(
          this.semanticBreaker,
          undefined,
          async () => {
            this.stats?.recordSemanticCall();
            const remaining = cardLimit - loaded;
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
              if (loaded >= cardLimit) break;
            }
          },
          error => {
            this.stats?.recordSemanticFailure();
            this.logger?.warn?.(`[patent-memory] wiki 语义召回失败，降级为图谱/关键词路径: ${errorMessage(error)}`);
          },
        );
      }
    }
    return contexts;
  }

  /** 通用重排助手：cross-encoder 对候选重新打分（失败/未配置保持原序）。 */
  private async tryRerankOrder<T>(query: string, items: T[], toText: (item: T) => string, topN: number): Promise<T[]> {
    const rerank = this.rerank;
    if (!rerank || items.length <= 1) return items;
    // topN<=0 视为"全部候选参与"（与 legal provider 的 rerankTopN 语义一致）。
    const effectiveTopN = topN > 0 ? topN : items.length;
    return guarded(
      this.rerankBreaker,
      items,
      async () => {
        this.stats?.recordRerankCall();
        const docs = items.map(toText);
        const results = await rerank.rerank(query, docs, effectiveTopN);
        return results.map(result => items[result.index]).filter((item): item is T => item !== undefined);
      },
      error => {
        this.stats?.recordRerankFailure();
        this.logger?.warn?.(`[patent-memory] rerank 失败，保持原序: ${errorMessage(error)}`);
      },
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
      this.stats?.setWikiSemanticIndexState("warming");
      void index
        .warmup()
        .then(() => this.stats?.setWikiSemanticIndexState("ready"))
        .catch(error => {
          this.stats?.setWikiSemanticIndexState("failed");
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
