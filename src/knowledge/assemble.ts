/**
 * 知识库 MemoryResolver 组装（唯一入口）。
 *
 * 从知识库路径探测结果 + 可选语义增强（embedding/rerank）构建
 * PatentMemoryProvider（专利 KG + wiki + IPC）与 LegalMemoryProvider
 * （法条 FTS + 语义）resolver 列表。数据库文件缺失/打开失败时自动降级
 * （单个失败不影响其他）。
 */

import { join } from "node:path";
import type { MemoryResolver } from "../context/memory/MemoryResolver.js";
import { NEXT_TASK_MS } from "../shared/timeouts.js";
import type { EmbeddingClient } from "../model/embedding/types.js";
import type { RerankClient } from "../model/embedding/rerank.js";
import { resolveKnowledgeDbPaths } from "./config.js";
import { KgStore } from "./shared/kg-store.js";
import { VectorDbSearch } from "./shared/vector-db.js";
import { KnowledgeEmbeddingSearch, createKnowledgeEmbeddingSearch } from "./shared/knowledge-embeddings.js";
import { checkEmbeddingConsistencyOnce } from "./shared/embedding-consistency.js";
import type { KnowledgeRuntimeStats } from "./shared/knowledge-stats.js";
import { PatentKgAdapter } from "./patent/patent-kg-adapter.js";
import { PatentMemoryProvider } from "./patent/patent-memory-provider.js";
import { WikiCardLoader } from "./patent/wiki-card-loader.js";
import { LegalMemoryProvider } from "./legal/legal-memory-provider.js";
import { LegalSearchEngine } from "./legal/legal-search.js";
import { KnowledgeLawSearch } from "./legal/knowledge-law-search.js";
import type { LegalSearchSource } from "./legal/types.js";
import {
  CaseLawSearchEngine,
  createCaseLawSemanticSource,
  type CaseLawSemanticSource,
} from "./case-law/case-law-search.js";
import { CaseLawMemoryProvider } from "./case-law/case-law-memory-provider.js";
import { getOrCreatePersonalNoteIndex, type PersonalNoteVectorIndex } from "./personal-note/index.js";

export type BuildKnowledgeResolversOptions = {
  /** patent_kg.db 路径（resolveKnowledgeDbPaths 探测结果）。 */
  patentKgDb?: string;
  /** laws 数据库路径（legacy 法规源）。 */
  lawDb?: string;
  /** knowledge.db 路径（XiaoNuo 统一知识库：kg_nodes + 法规 + embeddings，优先）。 */
  knowledgeDb?: string;
  /** sati-notes.db 路径（WS2.1：Sati 自有笔记/草稿真源；缺省取配置解析值）。 */
  notesDb?: string;
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
  logger?: { warn?: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
};

/**
 * P2-2：专利 provider 子函数——KG adapter 构建 + wiki 预热调度。
 *
 * 启动时后台预热 wiki 卡语义索引：首次全量 embed（本地 Ollama 下约百秒级）
 * 移出用户检索路径。预热失败仅告警（warmup() 内部无捕获，须在此兜底，
 * 否则 unhandled rejection 会经进程级 handler 关停 server）。
 * 延迟 SATI_WARMUP_DELAY（默认 30s）启动预热，避免与 server 就绪竞争 CPU。
 */
function buildPatentProvider(options: BuildKnowledgeResolversOptions): PatentMemoryProvider | undefined {
  const wikiLoader = options.wikiDir ? new WikiCardLoader(options.wikiDir) : undefined;
  const patentEmbedding = options.indexWiki === false ? undefined : options.embedding;
  const patentProviderOptions = {
    wikiLoader,
    embedding: patentEmbedding,
    embeddingDir: options.embeddingDir,
    rerank: options.rerank,
    rerankTopN: options.rerankTopN,
    stats: options.stats,
    logger: options.logger,
  };
  const warmupDelayMs = Number.parseInt(process.env.SATI_WARMUP_DELAY ?? "30000", 10);
  function scheduleWarmup(provider: PatentMemoryProvider): void {
    setTimeout(() => {
      provider.warmupSemanticIndex().catch(error => {
        options.logger?.warn?.(
          `wiki 语义索引预热失败（不影响启动与关键词检索）: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, warmupDelayMs);
  }
  if (options.patentKgDb) {
    try {
      const kgStore = new KgStore(options.patentKgDb);
      const provider = new PatentMemoryProvider({
        kgAdapter: new PatentKgAdapter(kgStore),
        ...patentProviderOptions,
      });
      scheduleWarmup(provider);
      return provider;
    } catch (error) {
      // A2 修复：KG 打开失败时降级为"无图谱"专利 provider（wiki/IPC 语义检索仍
      // 可用），与 patentKgDb 未配置的 else 分支一致——不再整体丢失专利 provider
      // （诊断 patent-ipc/patent-wiki 恒 ready，须与装配行为对齐）。
      options.logger?.warn?.(`patent_kg.db 打开失败，降级为无图谱专利 provider: ${errorMessage(error)}`);
      const provider = new PatentMemoryProvider(patentProviderOptions);
      scheduleWarmup(provider);
      return provider;
    }
  }
  const provider = new PatentMemoryProvider(patentProviderOptions);
  scheduleWarmup(provider);
  return provider;
}

/**
 * P2-2：法规 provider 子函数——knowledge.db 优先，legacy laws-full 回退。
 *
 * 语义索引与检索引擎必须同源：knowledgeEmbeddings 的 id 空间是 knowledge.db
 * documents.id，仅当检索引擎也是 knowledge.db 后端时才可复用；否则语义路空转。
 */
function buildLegalProvider(
  options: BuildKnowledgeResolversOptions,
  vectorDb: VectorDbSearch | undefined,
  legalEmbeddings: KnowledgeEmbeddingSearch | undefined,
): LegalMemoryProvider | undefined {
  let legalEngine: LegalSearchSource | undefined;
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
  if (!legalEngine) return undefined;
  return new LegalMemoryProvider(legalEngine, {
    embedding: options.embedding,
    knowledgeEmbeddings: legalEngineFromKnowledge ? legalEmbeddings : undefined,
    vectorDb,
    rerank: options.rerank,
    rerankTopN: options.rerankTopN,
    stats: options.stats,
    logger: options.logger,
  });
}

/**
 * P2-2：判例 provider 子函数——knowledge.db 判例全文 + 可选语义 + personal_note。
 *
 * 判例全文（CaseLawMemoryProvider）：knowledge.db（documents/chunks/docs_fts）打开成功
 * 且存在判例数据时启用自动注入；失败降级跳过（显式工具 patent_case_search 仍可用）。
 */
function buildCaseLawProvider(options: BuildKnowledgeResolversOptions): CaseLawMemoryProvider | undefined {
  if (!options.knowledgeDb) return undefined;
  try {
    const caseEngine = new CaseLawSearchEngine(options.knowledgeDb);
    if (caseEngine.count() === 0) {
      caseEngine.close();
      return undefined;
    }
    let caseSemantic: CaseLawSemanticSource | undefined;
    if (options.embedding) {
      try {
        const caseEmbeddings = createKnowledgeEmbeddingSearch({
          dbPath: options.knowledgeDb,
          docTypes: ["case", "judgment"],
          logger: options.logger,
        });
        caseSemantic = createCaseLawSemanticSource(texts => options.embedding!.embed(texts), caseEmbeddings);
      } catch (error) {
        options.logger?.warn?.(`knowledge.db 判例 embeddings 打开失败，判例语义路关闭: ${errorMessage(error)}`);
      }
    }
    // personal_note 语义索引（项目沉淀笔记可被语义召回；进程级单例与工具侧共享）。
    let noteSemantic: PersonalNoteVectorIndex | undefined;
    if (options.embedding) {
      try {
        noteSemantic = getOrCreatePersonalNoteIndex({
          notesDb: options.notesDb ?? resolveKnowledgeDbPaths().notesDb,
          knowledgeDb: options.knowledgeDb,
          client: options.embedding,
          storePath: join(options.embeddingDir, "personal-note.jsonl"),
          logger: options.logger,
        });
        // 后台预热：personal_note 量小（首次 embed 秒级）；失败仅告警不阻断。
        void noteSemantic.warmup().catch(error => {
          options.logger?.warn?.(`personal_note 语义索引预热失败（不影响关键词检索）: ${errorMessage(error)}`);
        });
      } catch (error) {
        options.logger?.warn?.(`personal_note 语义索引构建失败，笔记语义路关闭: ${errorMessage(error)}`);
        noteSemantic = undefined;
      }
    }
    caseEngine.setNoteSemantic(noteSemantic);
    return new CaseLawMemoryProvider({
      engine: caseEngine,
      semantic: caseSemantic,
      stats: options.stats,
      logger: options.logger,
    });
  } catch (error) {
    options.logger?.warn?.(`knowledge.db 判例库打开失败，跳过判例自动注入: ${errorMessage(error)}`);
    return undefined;
  }
}

export function buildKnowledgeResolvers(options: BuildKnowledgeResolversOptions): MemoryResolver[] {
  const resolvers: MemoryResolver[] = [];

  // 1. Vector DB（legacy 语义索引）：打开并上报施效点事实（#376 A6）。
  let vectorDb: VectorDbSearch | undefined;
  if (options.vectorsDb) {
    try {
      vectorDb = new VectorDbSearch({ dbPath: options.vectorsDb, logger: options.logger });
      options.stats?.setVectorDbProbe({ opened: true, corpora: vectorDb.indexedCorpora() });
    } catch (error) {
      options.stats?.setVectorDbProbe({ opened: false, reason: errorMessage(error) });
      options.logger?.warn?.(`vectors.db 打开失败，跳过 KG/法条语义召回: ${errorMessage(error)}`);
    }
  }

  // 2. knowledge.db 法规语义召回（复用 XiaoNuo embeddings）。
  let legalEmbeddings: KnowledgeEmbeddingSearch | undefined;
  if (options.knowledgeDb && options.embedding) {
    try {
      legalEmbeddings = createKnowledgeEmbeddingSearch({
        dbPath: options.knowledgeDb,
        docTypes: ["law_article"],
        logger: options.logger,
      });
    } catch (error) {
      options.logger?.warn?.(`knowledge.db embeddings 打开失败，法条语义降级: ${errorMessage(error)}`);
    }
  }

  // 3. 专利 provider（KG + wiki + IPC）。
  const patentProvider = buildPatentProvider(options);
  if (patentProvider) resolvers.push(patentProvider);

  // 4. 法规 provider（knowledge.db 优先，legacy laws-full 回退）。
  const legalProvider = buildLegalProvider(options, vectorDb, legalEmbeddings);
  if (legalProvider) resolvers.push(legalProvider);

  // 5. 判例 provider（knowledge.db 判例全文 + 可选语义 + personal_note）。
  const caseLawProvider = buildCaseLawProvider(options);
  if (caseLawProvider) resolvers.push(caseLawProvider);

  // 6. embedding 查询端与 knowledge.db 库向量一致性自检（fire-and-forget，不阻塞启动）。
  // checkEmbeddingConsistency 在首个 await 之前会同步执行一段采样 SQL，直接调用会
  // 阻塞 gateway 启动（修复前实测约 7s）；setTimeout(0) 推迟到 server listen 之后执行。
  // Once 语义：同一 (knowledgeDb, embedding 端点) 进程内只检一次——修复前每个项目
  // 运行时构建各发一次（23 个项目 = 启动瞬间 23 并发），打满端点串行队列后大面积
  // 30s 超时（生产日志 9-13 次/启动）；去重后仅 1 次，超时也从 30s 降至 5s。
  if (options.knowledgeDb && options.embedding) {
    const knowledgeDb = options.knowledgeDb;
    const embedding = options.embedding;
    const logger = options.logger;
    const stats = options.stats;
    setTimeout(() => {
      checkEmbeddingConsistencyOnce(knowledgeDb, embedding, { logger })
        .then(result => {
          if (result) stats?.setEmbeddingConsistency({ ok: result.ok, meanCosine: result.meanCosine });
        })
        .catch(() => {
          // 自检失败不阻断（consistency 内部已 warn）。
        });
    }, NEXT_TASK_MS);
  }

  return resolvers;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
