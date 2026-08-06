/**
 * 知识库 MemoryResolver 组装（唯一入口）。
 *
 * 从知识库路径探测结果 + 可选语义增强（embedding/rerank）构建
 * PatentMemoryProvider（专利 KG + wiki + IPC）与 LegalMemoryProvider
 * （法条 FTS + 语义）resolver 列表。数据库文件缺失/打开失败时自动降级
 * （单个失败不影响其他）。
 */

import type { MemoryResolver } from "../context/memory/MemoryResolver.js";
import type { EmbeddingClient } from "../model/embedding/types.js";
import type { RerankClient } from "../model/embedding/rerank.js";
import { KgStore } from "./shared/kg-store.js";
import { VectorDbSearch } from "./shared/vector-db.js";
import { KnowledgeEmbeddingSearch } from "./shared/knowledge-embeddings.js";
import { checkEmbeddingConsistency } from "./shared/embedding-consistency.js";
import type { KnowledgeRuntimeStats } from "./shared/knowledge-stats.js";
import { PatentKgAdapter } from "./patent/patent-kg-adapter.js";
import { PatentMemoryProvider } from "./patent/patent-memory-provider.js";
import { WikiCardLoader } from "./patent/wiki-card-loader.js";
import { LegalMemoryProvider } from "./legal/legal-memory-provider.js";
import { LegalSearchEngine } from "./legal/legal-search.js";
import { KnowledgeLawSearch } from "./legal/knowledge-law-search.js";
import type { LegalSearchSource } from "./legal/types.js";

export type BuildKnowledgeResolversOptions = {
  /** patent_kg.db 路径（resolveKnowledgeDbPaths 探测结果）。 */
  patentKgDb?: string;
  /** laws 数据库路径（legacy 法规源）。 */
  lawDb?: string;
  /** knowledge.db 路径（XiaoNuo 统一知识库：kg_nodes + 法规 + embeddings，优先）。 */
  knowledgeDb?: string;
  /** wiki 卡片目录。 */
  wikiDir?: string;
  /** vectors.db 路径（legacy 语义索引，存在才启用 KG/法条语义召回）。 */
  vectorsDb?: string;
  /** 向量持久化目录（memory/wiki JSONL 索引）。 */
  embeddingDir: string;
  /** 语义检索客户端（可选）。 */
  embedding?: EmbeddingClient;
  /** 是否给专利知识库注入 embedding（indexWiki=false 时关闭；默认 true）。 */
  indexWiki?: boolean;
  /** 重排客户端（可选，阶段 C）。 */
  rerank?: RerankClient;
  /** 参与重排的候选上限（透传 memory.embedding.rerank.topN；缺省 16）。 */
  rerankTopN?: number;
  /** 运行时状态聚合（可选，可观测性出口）；注入后由各 provider 打点。 */
  stats?: KnowledgeRuntimeStats;
  logger?: { warn?: (...args: unknown[]) => void };
};

export function buildKnowledgeResolvers(options: BuildKnowledgeResolversOptions): MemoryResolver[] {
  const resolvers: MemoryResolver[] = [];

  const wikiLoader = options.wikiDir ? new WikiCardLoader(options.wikiDir) : undefined;
  const patentEmbedding = options.indexWiki === false ? undefined : options.embedding;

  let vectorDb: VectorDbSearch | undefined;
  if (options.vectorsDb) {
    try {
      vectorDb = new VectorDbSearch({ dbPath: options.vectorsDb, logger: options.logger });
    } catch (error) {
      options.logger?.warn?.(`vectors.db 打开失败，跳过 KG/法条语义召回: ${errorMessage(error)}`);
    }
  }

  // knowledge.db 语义召回（复用 XiaoNuo embeddings）：法规语料（law_article）。
  let legalEmbeddings: KnowledgeEmbeddingSearch | undefined;
  if (options.knowledgeDb && options.embedding) {
    try {
      legalEmbeddings = new KnowledgeEmbeddingSearch({
        dbPath: options.knowledgeDb,
        docTypes: ["law_article"],
        logger: options.logger,
      });
    } catch (error) {
      options.logger?.warn?.(`knowledge.db embeddings 打开失败，法条语义降级: ${errorMessage(error)}`);
    }
  }

  const patentProviderOptions = {
    wikiLoader,
    embedding: patentEmbedding,
    embeddingDir: options.embeddingDir,
    rerank: options.rerank,
    rerankTopN: options.rerankTopN,
    stats: options.stats,
    logger: options.logger,
  };
  if (options.patentKgDb) {
    try {
      const kgStore = new KgStore(options.patentKgDb);
      resolvers.push(new PatentMemoryProvider({ kgAdapter: new PatentKgAdapter(kgStore), ...patentProviderOptions }));
    } catch (error) {
      // 与既有行为一致：KG 打开失败跳过专利 provider（wiki/IPC 随 KG 缺失路径兜底）
      options.logger?.warn?.(`patent_kg.db 打开失败，跳过专利知识图谱: ${errorMessage(error)}`);
    }
  } else {
    resolvers.push(new PatentMemoryProvider(patentProviderOptions));
  }

  // 法规引擎：knowledge.db 优先（law_article 文档），否则 legacy laws-full。
  let legalEngine: LegalSearchSource | undefined;
  /** 法规引擎是否来自 knowledge.db（决定 knowledgeEmbeddings 是否同源可用）。 */
  let legalEngineFromKnowledge = false;
  if (options.knowledgeDb) {
    try {
      const lawSearch = new KnowledgeLawSearch(options.knowledgeDb);
      if (lawSearch.count() > 0) {
        legalEngine = lawSearch;
        legalEngineFromKnowledge = true;
      } else {
        lawSearch.close();
      }
    } catch (error) {
      options.logger?.warn?.(`knowledge.db 法规后端打开失败: ${errorMessage(error)}`);
    }
  }
  if (!legalEngine && options.lawDb) {
    try {
      legalEngine = new LegalSearchEngine(options.lawDb);
    } catch (error) {
      options.logger?.warn?.(`laws 数据库打开失败，跳过法律知识库: ${errorMessage(error)}`);
    }
  }
  if (legalEngine) {
    resolvers.push(
      new LegalMemoryProvider(legalEngine, {
        embedding: options.embedding,
        // 语义索引与检索引擎必须同源：knowledgeEmbeddings 的 id 空间是 knowledge.db
        // documents.id，仅当检索引擎也是 knowledge.db 后端时才可复用；否则语义路空转。
        knowledgeEmbeddings: legalEngineFromKnowledge ? legalEmbeddings : undefined,
        vectorDb,
        rerank: options.rerank,
        rerankTopN: options.rerankTopN,
        stats: options.stats,
        logger: options.logger,
      }),
    );
  }

  // embedding 查询端与 knowledge.db 库向量一致性自检（fire-and-forget，不阻塞启动）。
  if (options.knowledgeDb && options.embedding) {
    checkEmbeddingConsistency(options.knowledgeDb, options.embedding, { logger: options.logger })
      .then(result => {
        if (result) options.stats?.setEmbeddingConsistency({ ok: result.ok, meanCosine: result.meanCosine });
      })
      .catch(() => {
        // 自检失败不阻断（consistency 内部已 warn）。
      });
  }

  return resolvers;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export {
  resolveKnowledgeCapabilities,
  formatKnowledgeCapabilities,
  logKnowledgeCapabilities,
  type KnowledgeCapability,
  type KnowledgeCapabilityStatus,
  type KnowledgeCapabilitiesOptions,
  type KnowledgeCapabilityLogger,
} from "./diagnostics.js";
