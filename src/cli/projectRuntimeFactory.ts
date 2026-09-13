/**
 * 项目运行时构造（P4a 第九刀，类内拆分）：从 ProjectRuntimeRegistry 搬出 `resolve`、
 * `buildRouterEventBus`、`emitBackgroundTaskCompletion` 与 `ProjectRuntime` 类型。
 *
 * 一个 ProjectRuntime = 项目配置快照 + 模型/路由 + 工具表 + 记忆与知识库解析器 + 后台任务 +
 * per-project 存储；本模块负责**首次 resolve 时的整套装配**，之后注册表缓存命中直接返回。
 *
 * 取数函数与写回口是有意的（不是在传值上偷懒）：
 * - `getExtraTools` / `getTeamTools` / `getKanbanBoardManager`：分别由 `updateSubsystems` /
 *   `setTeamTools` / `setKanbanBoardManager` 在首次 resolve 之后注入或整体替换。
 * - `getGateway`：`setGateway` 晚绑定；重试进度广播与后台任务完成事件都在**事件发生时**才读它。
 * - `setRouterEventBus`：`routerEventBus` 是注册表的公开字段（`createLocalGateway` dispose 时经它
 *   同步 flush 缓冲），构造期必须写回注册表，故以回调交出；回调返回同一个 bus，保证
 *   `createRouterRuntime({ events })` 原表达式的值不变。
 * - `runtimes` / `sessionWriters`：注册表的活 Map（原地增删、引用不变），按值传入。
 */

import { appendFileSync, existsSync, mkdirSync as mkdirSyncFs, renameSync } from "node:fs";
import { join as joinPath, resolve as resolvePath } from "node:path";
import type { EdgeClawMemoryService } from "edgeclaw-memory-core";
import { brandEnv, ENV_KEY } from "../env.js";
import { PluginRuntime } from "../extension/index.js";
import { loadBuiltinPlugins } from "../extension/plugins/builtin/loadBuiltinPlugins.js";
import { type GatewayProjectStorageOptions, type InProcessGateway, type KanbanBoardManager } from "../gateway/index.js";
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
import {
  createEdgeClawMemoryProviderFromConfig,
  type MemoryResolver,
  TokenAccountingRuntime,
} from "../context/index.js";
import { createModelRuntime, type ModelRuntime } from "../model/index.js";
import { resolveEmbeddingClient, resolveRerankClient } from "../model/embedding/index.js";
import { createPolicyKey, normalizeRetryReason } from "../model/streaming/retryState.js";
import { loadPilotConfig } from "../pilot/index.js";
import type { PilotConfigDiagnostic, PilotConfigSnapshot } from "../pilot/config/types.js";
import { createRouterRuntime, type RouterRuntime } from "../router/index.js";
import type { RouterEvent, RouterEventBus } from "../router/protocol/events.js";
import type { AgentTranscriptWriter } from "../session/index.js";
import { BackgroundTaskRuntime, type BackgroundTaskCompletionEvent } from "../task/runtime/BackgroundTaskRuntime.js";
import { logger, type TelemetryClient } from "../telemetry/index.js";
import { applyReplayEnvHooks } from "../test-support/llm-replay/index.js";
import {
  createBuiltinRegistry,
  type SatiToolDefinition,
  type SatiUnavailableToolDiagnostic,
  type ToolRegistry,
} from "../tool/index.js";
import type { TeamToolsOptions } from "../tool/builtin/team/index.js";
import { setCaseLawSemanticSource, setPersonalNoteSemanticSource } from "../tool/builtin/patentCaseSearch.js";
import type { McpRuntime } from "../mcp/index.js";
import { ensureRouterConfig } from "./routerDefaults.js";

/** M4：路由事件审计落盘批量 flush 间隔（unref，不持 event loop）。 */
const ROUTER_EVENT_FLUSH_INTERVAL_MS = 250;

export type ProjectRuntime = {
  projectRoot: string;
  snapshot: ReturnType<typeof loadPilotConfig>;
  model: ModelRuntime;
  tokenAccounting: TokenAccountingRuntime;
  router: RouterRuntime;
  pluginRuntime: PluginRuntime;
  tools: ToolRegistry;
  unavailableTools?: SatiUnavailableToolDiagnostic[];
  projectStorage: GatewayProjectStorageOptions;
  /** Per-project background task runtime (shared across sessions). C5. */
  backgroundTasks: BackgroundTaskRuntime;
  /** Memory provider, undefined when memory is disabled in PilotConfig. */
  memory?: MemoryResolver;
  /** Backing memory service for maintenance / introspection. */
  memoryService?: EdgeClawMemoryService;
  /** 知识库路径探测结果（knowledge.capabilities 可观测性出口数据源）。 */
  knowledgePaths?: KnowledgeDbPaths;
  /** 知识库运行时状态聚合（各 resolver 打点；gateway 出口读快照）。 */
  knowledgeStats?: KnowledgeRuntimeStats;
  /** 是否已配置 embedding 客户端（memory.embedding）。 */
  knowledgeEmbeddingConfigured?: boolean;
  /** 是否已配置 rerank 客户端（memory.embedding.rerank）。 */
  knowledgeRerankConfigured?: boolean;
  /** Coalesced project-level memory maintenance loop. */
  memoryMaintenanceInFlight?: Promise<void>;
  memoryMaintenanceRequested?: boolean;
  /**
   * Lazily-started MCP runtime (C1). Built on first session creation by
   * `ensureMcpReady()` because plugin refresh + connect is async.
   * Only contains non-`perSession` servers (shared across sessions).
   */
  mcpRuntime?: McpRuntime;
  /** Tracks the in-flight `ensureMcpReady` promise so concurrent sessions share it. */
  mcpReady?: Promise<void>;
  /**
   * Server specs marked `perSession: true`. These are NOT started at the
   * project level — each agent session creates its own `McpRuntime` from
   * these specs so that e.g. browser-use gets an isolated process per
   * session.  Populated during `ensureMcpReady()`.
   */
  perSessionServerSpecs?: import("../mcp/protocol/types.js").SatiMcpServerSpec[];
};

export type ProjectRuntimeFactoryDeps = {
  fallbackProjectRoot: string;
  pilotHome: string;
  builtinSkillsRoot?: string;
  env: Record<string, string | undefined>;
  now: () => Date;
  telemetry: TelemetryClient;
  /** @internal 测试注入（见 CreateLocalGatewayOptions.__testModelFactory）。 */
  modelFactory?: (snapshot: PilotConfigSnapshot) => ModelRuntime;
  onProjectActivated?: (projectRoot: string) => void;
  /** 项目运行时缓存：命中直接返回，未命中时写入（引用不变，原地增删）。 */
  runtimes: Map<string, ProjectRuntime>;
  /** 活跃会话 transcript 写入器：retry_schedule 落盘按 sessionId 查表。 */
  sessionWriters: Map<string, AgentTranscriptWriter>;
  /** 取数：extraTools 可被 updateSubsystems 整体替换。 */
  getExtraTools: () => SatiToolDefinition[];
  /** 取数：team_* 工具装配由 setTeamTools 晚绑定。 */
  getTeamTools: () => TeamToolsOptions | undefined;
  /** 取数：kanban 装配由 setKanbanBoardManager 晚绑定。 */
  getKanbanBoardManager: () => KanbanBoardManager | undefined;
  /** 取数：gateway 由 setGateway 晚绑定。 */
  getGateway: () => InProcessGateway | undefined;
  /** 写回注册表公开字段 routerEventBus（dispose 经此 flush）；返回同一 bus。 */
  setRouterEventBus: (bus: RouterEventBus) => RouterEventBus;
};

export type ProjectRuntimeResolver = {
  /** 解析（必要时构造并缓存）项目运行时。 */
  resolve(projectKey?: string): ProjectRuntime;
};

export function createProjectRuntimeResolver(deps: ProjectRuntimeFactoryDeps): ProjectRuntimeResolver {
  function emitBackgroundTaskCompletion(event: BackgroundTaskCompletionEvent): void {
    // 整形（等价）：原代码读的是属性 `this.gateway`，TS 收窄跨属性读有效；改取数函数后
    // 每次调用都可能返回 undefined，故守卫前提到局部量，同一同步块内只读一次。
    const gateway = deps.getGateway();
    if (!event.sessionId || !gateway) {
      return;
    }
    const outputPreview = event.outputPreview.trimEnd();
    gateway.emitForSession(event.sessionId, {
      type: "agent_status",
      event: "background_task_completed",
      detail: {
        taskId: event.taskId,
        status: event.status,
        exitCode: event.exitCode ?? null,
        totalBytes: event.totalBytes,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        ...(outputPreview ? { outputPreview } : {}),
      },
    });
  }

  function buildRouterEventBus(): RouterEventBus {
    const pilotHome = deps.pilotHome;
    const routerDir = joinPath(pilotHome, "router");
    try {
      mkdirSyncFs(routerDir, { recursive: true });
    } catch {
      // 目录已存在或创建失败：后续事件写盘会再试，此处失败不阻断（best-effort）。
    }
    const eventsPath = joinPath(routerDir, "events.jsonl");
    try {
      const oldPath = joinPath(pilotHome, "router-events.jsonl");
      if (!existsSync(eventsPath) && existsSync(oldPath)) {
        renameSync(oldPath, eventsPath);
      }
    } catch {
      // 迁移失败：沿用旧文件，events.jsonl 仅审计用，失败不影响主流程（best-effort）。
    }
    // M4：逐事件 appendFileSync 改缓冲 + 250ms 批量 flush。events.jsonl 仅供
    // 人工审计（bootstrap-sati-config 注释），无程序化消费/重建路径——尾部
    // 丢失可接受；flush timer unref 不持 event loop，dispose 时同步 flush 收尾。
    const pendingEvents: RouterEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPendingEvents = () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pendingEvents.length === 0) return;
      const batch = pendingEvents.splice(0, pendingEvents.length);
      try {
        appendFileSync(eventsPath, batch.map(event => JSON.stringify(event)).join("\n") + "\n");
      } catch {
        // 事件批量落盘失败：丢弃该批，不中断 agent turn，下批 flush 再试（best-effort）。
      }
    };
    const scheduleFlush = () => {
      if (flushTimer !== null) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushPendingEvents();
      }, ROUTER_EVENT_FLUSH_INTERVAL_MS);
      flushTimer.unref?.();
    };
    return {
      emit: (event: RouterEvent) => {
        pendingEvents.push(event);
        scheduleFlush();
        if (event.type === "sati_router_retry_progress") {
          try {
            deps.getGateway()?.broadcastRetryProgress(event);
          } catch {
            // 重试进度广播失败：事件仅审计展示，丢一条不影响重试链路（best-effort）。
          }
          // 跨进程重启续算 T-A：重试调度写入该会话 transcript 权威序列（log-only）。
          // 事件含 sessionId/turnId；无 turnId（子代理上下文）或会话未登记时跳过。
          try {
            if (typeof event.turnId === "string") {
              const writer = deps.sessionWriters.get(event.sessionId);
              if (writer?.recordRetrySchedule) {
                void writer.recordRetrySchedule(event.sessionId, event.turnId, {
                  retryId: event.retryId ?? "",
                  provider: event.provider,
                  model: event.model,
                  policyKey: createPolicyKey(),
                  attempt: event.attempt,
                  maxAttempts: event.maxAttempts,
                  delayMs: event.delayMs,
                  reason: normalizeRetryReason(event.reason),
                  scheduledAt: deps.now().toISOString(),
                });
              }
            }
          } catch {
            // 重试调度落盘失败：不中断 agent turn，下轮或续算路径再补（best-effort）。
          }
        }
      },
      flush: flushPendingEvents,
    };
  }

  function resolve(projectKey?: string): ProjectRuntime {
    const projectRoot = resolvePath(projectKey ?? deps.fallbackProjectRoot);
    deps.onProjectActivated?.(projectRoot);
    const cached = deps.runtimes.get(projectRoot);
    if (cached) {
      return cached;
    }

    const snapshot = loadPilotConfig({ projectRoot, env: deps.env });
    const baseModel = deps.modelFactory ? deps.modelFactory(snapshot) : createModelRuntime(snapshot.config.model);
    // Phase 4 T1: replay seam hooks. SATI_LLM_REPLAY_RECORD_ROOT records every
    // stream the gateway drives; SATI_LLM_REPLAY_ROOT replays a fixture without
    // an API key. Unset in normal operation (applyReplayEnvHooks is a no-op).
    const model = applyReplayEnvHooks(baseModel, deps.env);
    const tokenAccounting = new TokenAccountingRuntime({
      modelConfig: snapshot.config.model,
    });
    const pluginRuntime = new PluginRuntime({
      projectRoot,
      pilotHome: deps.pilotHome,
      builtinSkillsRoot: deps.builtinSkillsRoot,
      builtinPlugins: loadBuiltinPlugins(),
      builtinPluginsEnabled: snapshot.config.extension.builtinPluginsEnabled,
    });
    const routerConfig = ensureRouterConfig(snapshot.config.router, snapshot.config.agent.model);
    const router = createRouterRuntime(routerConfig, {
      modelRuntime: model,
      now: deps.now,
      customRouterRegistry: pluginRuntime,
      loadSkillPrompt: extensionId => pluginRuntime.loadSkillPrompt(extensionId),
      events: deps.setRouterEventBus(buildRouterEventBus()),
      telemetry: deps.telemetry,
    });
    const backgroundTasks = new BackgroundTaskRuntime({
      now: deps.now,
      onCompletion: event => emitBackgroundTaskCompletion(event),
    });
    const webSearchConfig = snapshot.config.tools?.webSearch;
    const paperSearchConfig = snapshot.config.tools?.paperSearch;

    // 语义检索（可选）：embedding 端点配置解析一次，分发给记忆、知识库与附图检索。
    const knowledgePaths = resolveKnowledgeDbPaths();
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
      projectRoot,
      now: deps.now,
      telemetry: deps.telemetry,
      embeddingClient,
      embeddingDir,
    });

    const tools = createBuiltinRegistry({
      ...(deps.getTeamTools() ? { team: deps.getTeamTools() } : {}),
      ...(deps.getKanbanBoardManager() ? { kanban: deps.getKanbanBoardManager() } : {}),
      backgroundTasks: { runtime: backgroundTasks },
      searchPatentFigure: { embeddingClient },
      // 文书排版调参面板工具（opt-in：无参注册会破坏 llm-replay fixture 工具集匹配）
      documentStyle: {},
      // J-Space 工作区工具（opt-in：与工作区账本开关联动，避免破坏 fixture 工具集匹配）
      workspaceLedgerTools: brandEnv(deps.env, ENV_KEY.WORKSPACE_LEDGER_ENABLED) === "1",
      ...(memory?.service ? { memory: { service: memory.service } } : {}),
      readSkill: {
        loader: name => pluginRuntime.loadSkillPrompt(name),
        lister: () => pluginRuntime.getAllSkills(),
      },
      // Pass the YAML-configured web-search provider through to the built-in
      // `web_search` tool. When absent, the tool may infer GLM/Tavily from
      // provider-specific environment variables.
      ...(webSearchConfig?.enabled === false
        ? { webSearch: false as const }
        : webSearchConfig
          ? {
              webSearch: {
                ...(webSearchConfig.provider ? { provider: webSearchConfig.provider } : {}),
                ...(webSearchConfig.apiKey ? { apiKey: webSearchConfig.apiKey } : {}),
                ...(webSearchConfig.endpoint ? { endpoint: webSearchConfig.endpoint } : {}),
                ...(webSearchConfig.customProvider ? { customProvider: webSearchConfig.customProvider } : {}),
              },
            }
          : {}),
      // Pass the YAML-configured literature sources through to the built-in
      // `paper_search` / `paper_list_sources` tools. Config shape matches
      // CreateLiteratureRegistryOptions; undefined fields fall back to defaults
      // (all sources enabled, free no-key).
      ...(paperSearchConfig?.enabled === false
        ? { paperSearch: false as const }
        : paperSearchConfig
          ? {
              paperSearch: {
                arxiv: paperSearchConfig.arxiv,
                openalex: paperSearchConfig.openalex,
                semanticScholar: paperSearchConfig.semanticScholar,
                crossref: paperSearchConfig.crossref,
                openalexMailto: paperSearchConfig.openalexMailto,
                semanticScholarApiKey: paperSearchConfig.semanticScholarApiKey,
              },
            }
          : {}),
      // Pass the YAML-configured patents.downloadDir through to the built-in
      // `patent_pdf_download` tool (runtime-live: read at every execution).
      ...(snapshot.config.patents?.downloadDir
        ? { patentPdfDownload: { patentsConfigProvider: () => snapshot.config.patents } }
        : {}),
      // Pass the YAML-configured patents.modelHints through to
      // `patent_workflow_run` (judgeModels multi-judge consensus + per-node
      // model tiering). Absent → hints ignored, everything uses the session model.
      ...(snapshot.config.patents?.modelHints ? { patentModelHints: snapshot.config.patents.modelHints } : {}),
    });
    for (const tool of deps.getExtraTools()) {
      tools.register(tool);
    }

    // 知识库 MemoryResolver 组装：EdgeClaw 会话记忆 + 专利知识库 + 法律知识库。
    // 数据库文件缺失/打开失败时自动降级（见 src/knowledge/assemble.ts）。
    const knowledgeStats = new KnowledgeRuntimeStats();
    const knowledgeResolvers: Array<MemoryResolver> = [];
    if (memory?.provider) knowledgeResolvers.push(memory.provider);
    knowledgeResolvers.push(
      ...buildKnowledgeResolvers({
        patentKgDb: knowledgePaths.patentKgDb,
        lawDb: knowledgePaths.lawDb,
        knowledgeDb: knowledgePaths.knowledgeDb,
        wikiDir: knowledgePaths.wikiDir,
        vectorsDb: knowledgePaths.vectorsDb,
        embeddingDir,
        embedding: embeddingClient,
        rerank: rerankClient,
        rerankTopN: snapshot.config.memory?.embedding?.rerank?.topN,
        indexWiki: snapshot.config.memory?.embedding?.indexWiki !== false,
        stats: knowledgeStats,
        logger: { warn: (...args) => logger.warn("knowledge:", ...args) },
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
        }, 0);
      } catch (error) {
        logger.warn("knowledge: 判例语义召回源注入失败，patent_case_search 语义路关闭:", error);
      }
    }

    // personal_note 语义召回源注入（patent_case_search 工具）：项目沉淀笔记（OA 答复要点等）
    // 可被语义召回。数据源固定为 knowledgeDb（knowledge_note_save 写入地），与组装层
    // 单例键一致；进程级单例与组装层共享。引擎侧回源走 caseDb——两者分离
    // （SATI_CASE_DB）时笔记命中无法经 caseDb 引擎回源，显式告警关闭该路。
    if (embeddingClient && knowledgePaths.knowledgeDb) {
      try {
        const noteIndex = getOrCreatePersonalNoteIndex({
          dbPath: knowledgePaths.knowledgeDb,
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

    const runtime: ProjectRuntime = {
      projectRoot,
      snapshot,
      model,
      tokenAccounting,
      router,
      pluginRuntime,
      tools,
      backgroundTasks,
      memory: memoryResolver,
      memoryService: memory?.service,
      knowledgePaths,
      knowledgeStats,
      knowledgeEmbeddingConfigured: Boolean(embeddingClient),
      knowledgeRerankConfigured: Boolean(rerankClient),
      projectStorage: {
        projectRoot,
        pilotHome: deps.pilotHome,
      },
    };
    deps.runtimes.set(projectRoot, runtime);
    return runtime;
  }

  return { resolve };
}
