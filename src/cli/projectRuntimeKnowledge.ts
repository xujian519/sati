/**
 * 项目运行时的「记忆 + 知识库」装配（P2.7 从 `projectRuntimeFactory.ts` 的
 * `createProjectRuntimeResolver` 内嵌闭包搬出，逐 token 未改）。
 *
 * 两段：`createProjectMemoryLayer` 解析 embedding/rerank 客户端并建 EdgeClaw 记忆 provider
 * （须在 `createBuiltinRegistry` 之前——`memory_*` 工具随注册表闭包注入）；
 * `createKnowledgeResolverLayer` 把记忆 provider 与专利/法律/知识库 resolver 合成一个
 * `MemoryResolver`，并注入判例与笔记的语义召回源。库文件缺失/打开失败一律自动降级。
 */

import { join as joinPath } from "node:path";
import type { EdgeClawMemoryService } from "edgeclaw-memory-core";
import { createEdgeClawMemoryProviderFromConfig, type MemoryResolver } from "../context/index.js";
import {
  buildKnowledgeResolvers,
  CompositeMemoryResolver,
  createCaseLawSemanticSource,
  createKnowledgeEmbeddingSearch,
  getOrCreatePersonalNoteIndex,
  type KnowledgeDbPaths,
  KnowledgeRuntimeStats,
  logKnowledgeCapabilities,
  resolveKnowledgeDbPaths,
} from "../knowledge/index.js";
import { resolveEmbeddingClient, resolveRerankClient } from "../model/embedding/index.js";
import type { PilotConfigDiagnostic, PilotConfigSnapshot } from "../pilot/config/types.js";
import { NEXT_TASK_MS } from "../shared/timeouts.js";
import { setCaseLawSemanticSource, setPersonalNoteSemanticSource } from "../tool/builtin/patentCaseSearch.js";
import { logger, type TelemetryClient } from "../telemetry/index.js";

export type ProjectMemoryLayer = {
  knowledgePaths: KnowledgeDbPaths;
  embeddingClient: ReturnType<typeof resolveEmbeddingClient>;
  rerankClient: ReturnType<typeof resolveRerankClient>;
  /** 知识库向量库目录（记忆/知识库/附图检索共用）。 */
  embeddingDir: string;
  memory: ReturnType<typeof createEdgeClawMemoryProviderFromConfig>;
};

export function createProjectMemoryLayer(deps: {
  snapshot: PilotConfigSnapshot;
  projectRoot: string;
  env: Record<string, string | undefined>;
  now: () => Date;
  telemetry: TelemetryClient;
}): ProjectMemoryLayer {
  const { snapshot } = deps;
  // 语义检索（可选）：embedding 端点配置解析一次，分发给记忆、知识库与附图检索。
  // 必须用调用方传入的 env：否则 `createLocalGateway({env})` 对
  // `SATI_KNOWLEDGE_DIR` / `SATI_LAW_DB` 等覆盖会被静默忽略，回落到宿主 process.env
  // （测量脚本因此无法隔离本机知识库，测出的数字跨机不可比）。
  const knowledgePaths = resolveKnowledgeDbPaths(deps.env);
  const embeddingDiagnostics: PilotConfigDiagnostic[] = [];
  const embeddingClient = resolveEmbeddingClient(
    snapshot.config.memory?.embedding,
    snapshot.config.model,
    embeddingDiagnostics,
  );
  // 重排（可选，阶段 C）：cross-encoder 对召回候选重新打分
  const rerankClient = resolveRerankClient(
    snapshot.config.memory?.embedding?.rerank,
    snapshot.config.model,
    embeddingDiagnostics,
  );
  for (const diagnostic of embeddingDiagnostics) {
    logger.warn(`${diagnostic.path}: ${diagnostic.message}`);
  }

  // 知识库向量库目录（embedding 客户端解析见上，记忆/知识库/附图检索共用）。
  // 记忆服务需在 createBuiltinRegistry 之前创建：memory_* 工具随注册表闭包注入。
  const embeddingDir = joinPath(knowledgePaths.dataDir, "embeddings");

  const memory = createEdgeClawMemoryProviderFromConfig({
    config: snapshot.config.memory,
    modelConfig: snapshot.config.model,
    agentModel: snapshot.config.agent.model.id,
    projectRoot: deps.projectRoot,
    now: deps.now,
    telemetry: deps.telemetry,
    embeddingClient,
    embeddingDir,
  });

  return { knowledgePaths, embeddingClient, rerankClient, embeddingDir, memory };
}

export type KnowledgeResolverLayer = {
  memoryResolver: MemoryResolver;
  memoryService?: EdgeClawMemoryService;
  knowledgeStats: KnowledgeRuntimeStats;
  knowledgeEmbeddingConfigured: boolean;
  knowledgeRerankConfigured: boolean;
};

export function createKnowledgeResolverLayer(deps: {
  snapshot: PilotConfigSnapshot;
  knowledgePaths: KnowledgeDbPaths;
  embeddingClient: ProjectMemoryLayer["embeddingClient"];
  rerankClient: ProjectMemoryLayer["rerankClient"];
  embeddingDir: string;
  memory: ProjectMemoryLayer["memory"];
}): KnowledgeResolverLayer {
  const { knowledgePaths, embeddingClient, rerankClient, embeddingDir } = deps;
  // 知识库 MemoryResolver 组装：EdgeClaw 会话记忆 + 专利知识库 + 法律知识库。
  // 数据库文件缺失/打开失败时自动降级（见 src/knowledge/assemble.ts）。
  const knowledgeStats = new KnowledgeRuntimeStats();
  const knowledgeResolvers: Array<MemoryResolver> = [];
  if (deps.memory?.provider) knowledgeResolvers.push(deps.memory.provider);
  knowledgeResolvers.push(
    ...buildKnowledgeResolvers({
      patentKgDb: knowledgePaths.patentKgDb,
      lawDb: knowledgePaths.lawDb,
      knowledgeDb: knowledgePaths.knowledgeDb,
      notesDb: knowledgePaths.notesDb,
      wikiDir: knowledgePaths.wikiDir,
      vectorsDb: knowledgePaths.vectorsDb,
      embeddingDir,
      embedding: embeddingClient,
      rerank: rerankClient,
      rerankTopN: deps.snapshot.config.memory?.embedding?.rerank?.topN,
      indexWiki: deps.snapshot.config.memory?.embedding?.indexWiki !== false,
      stats: knowledgeStats,
      logger: {
        warn: (...args) => logger.warn("knowledge:", ...args),
        // debug 透传供自检去重命中留痕（SATI_DEBUG=1 可见）。
        debug: (...args) => logger.debug("knowledge:", ...args),
      },
    }),
  );

  // 判例语义召回源注入（patent_case_search 工具）：knowledge.db embeddings(case/judgment)
  // + 当前 embedding client。embedding 未配置或 knowledge.db 不可用时保持语义路关闭。
  if (embeddingClient && knowledgePaths.caseDb) {
    try {
      const caseEmbeddings = createKnowledgeEmbeddingSearch({
        dbPath: knowledgePaths.caseDb,
        docTypes: ["case", "judgment"],
        logger: { warn: (...args) => logger.warn("knowledge:", ...args) },
      });
      setCaseLawSemanticSource(createCaseLawSemanticSource(texts => embeddingClient!.embed(texts), caseEmbeddings));
      // P4 向量预热：异步分页加载（每页 setImmediate 让出）不阻塞 gateway 启动，
      // 因此 setTimeout 0 即安全——首个语义检索前矩阵大概率已就绪（ready），
      // 未就绪时 search 也会返回 [] 并兜底触发预热，不产生 embed 浪费
      // （case-law searchSemantic 未 ready 跳过语义路）。
      setTimeout(() => {
        void caseEmbeddings.loadAsync();
      }, NEXT_TASK_MS);
    } catch (error) {
      logger.warn("knowledge: 判例语义召回源注入失败，patent_case_search 语义路关闭:", error);
    }
  }

  // personal_note 语义召回源注入（patent_case_search 工具）：项目沉淀笔记（OA 答复要点等）
  // 可被语义召回。数据源为 Sati 自有 sati-notes.db（WS2.1 真源），knowledge.db 仅承载
  // 可重建投影；与组装层单例键一致；进程级单例与组装层共享。引擎侧回源走 caseDb——
  // 两者分离（SATI_CASE_DB）时笔记命中无法经 caseDb 引擎回源，显式告警关闭该路。
  if (embeddingClient && knowledgePaths.knowledgeDb) {
    try {
      const noteIndex = getOrCreatePersonalNoteIndex({
        notesDb: knowledgePaths.notesDb,
        knowledgeDb: knowledgePaths.knowledgeDb,
        client: embeddingClient,
        storePath: joinPath(embeddingDir, "personal-note.jsonl"),
        logger: { warn: (...args) => logger.warn("knowledge:", ...args) },
      });
      if (knowledgePaths.caseDb && knowledgePaths.caseDb !== knowledgePaths.knowledgeDb) {
        logger.warn(
          "knowledge: personal_note 库与判例库分离（SATI_CASE_DB），笔记命中无法回源，工具侧笔记语义路关闭。",
        );
      } else {
        setPersonalNoteSemanticSource(noteIndex);
      }
    } catch (error) {
      logger.warn("knowledge: personal_note 语义召回源注入失败，笔记语义路关闭:", error);
    }
  }

  // 知识能力自检：数据/配置缺失时输出可读清单，避免静默降级。
  // 传 runtime 快照让 KG FTS tokenizer 等运行时能力项（如 FTS5 缺失回退 LIKE）
  // 也出现在启动输出里——provider 构造时已同步完成探测。
  logKnowledgeCapabilities(
    knowledgePaths,
    {
      embeddingConfigured: Boolean(embeddingClient),
      rerankConfigured: Boolean(rerankClient),
      runtime: knowledgeStats.snapshot(),
    },
    console,
  );

  const memoryResolver =
    knowledgeResolvers.length === 1 ? knowledgeResolvers[0] : new CompositeMemoryResolver(knowledgeResolvers);

  return {
    memoryResolver,
    memoryService: deps.memory?.service,
    knowledgeStats,
    knowledgeEmbeddingConfigured: Boolean(embeddingClient),
    knowledgeRerankConfigured: Boolean(rerankClient),
  };
}
