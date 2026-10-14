/**
 * 项目运行时构造（P4a 第九刀，类内拆分）：从 ProjectRuntimeRegistry 搬出 `resolve`、
 * `buildRouterEventBus`、`emitBackgroundTaskCompletion` 与 `ProjectRuntime` 类型。
 *
 * P2.7 再拆：`resolve` 的三段装配（记忆/知识库、工具表、路由事件落盘）外移到同目录的
 * `projectRuntimeKnowledge.ts` / `projectRuntimeTools.ts` / `projectRuntimeRouterEvents.ts`，
 * 本文件只留解析入口与运行时对象装配。
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

import { resolve as resolvePath } from "node:path";
import type { EdgeClawMemoryService } from "edgeclaw-memory-core";
import { type MemoryResolver, TokenAccountingRuntime } from "../context/index.js";
import { PluginRuntime } from "../extension/index.js";
import { loadBuiltinPlugins } from "../extension/plugins/builtin/loadBuiltinPlugins.js";
import { type KanbanBoardManager, type InProcessGateway, type GatewayProjectStorageOptions } from "../gateway/index.js";
import type { KnowledgeDbPaths, KnowledgeRuntimeStats } from "../knowledge/index.js";
import { createModelRuntime, type ModelRuntime } from "../model/index.js";
import type { PilotConfigSnapshot } from "../pilot/config/types.js";
import { loadPilotConfig } from "../pilot/index.js";
import { createRouterRuntime, type RouterRuntime } from "../router/index.js";
import type { RouterEventBus } from "../router/protocol/events.js";
import type { AgentTranscriptWriter } from "../session/index.js";
import { BackgroundTaskRuntime } from "../task/runtime/BackgroundTaskRuntime.js";
import { logger, type TelemetryClient } from "../telemetry/index.js";
import { applyReplayEnvHooks } from "../test-support/llm-replay/index.js";
import type { SatiToolDefinition, SatiUnavailableToolDiagnostic, ToolRegistry } from "../tool/index.js";
import type { TeamToolsOptions } from "../tool/builtin/team/index.js";
import type { McpRuntime } from "../mcp/index.js";
import { createKnowledgeResolverLayer, createProjectMemoryLayer } from "./projectRuntimeKnowledge.js";
import { createRouterEventBus, emitBackgroundTaskCompletion } from "./projectRuntimeRouterEvents.js";
import { createProjectTools } from "./projectRuntimeTools.js";
import { ensureRouterConfig } from "./routerDefaults.js";

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
  /**
   * 工作区专利判据结果（#450）：控制 patent 域工具与技能/角色清单是否对模型可见。
   * 装配期算一次并随运行时缓存；工作区变成专利项目后需重启或显式配 `tools.patentDomain`。
   */
  patentDomainEnabled: boolean;
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

/** 模型 / token 记账 / 插件运行时 / 路由：装配顺序上互不依赖，但都先于工具与知识层。 */
function createModelAndRouterLayer(
  projectRoot: string,
  deps: ProjectRuntimeFactoryDeps,
  snapshot: PilotConfigSnapshot,
) {
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
    events: deps.setRouterEventBus(createRouterEventBus(deps)),
    telemetry: deps.telemetry,
  });
  return { model, tokenAccounting, pluginRuntime, router };
}

export function createProjectRuntimeResolver(deps: ProjectRuntimeFactoryDeps): ProjectRuntimeResolver {
  function resolve(projectKey?: string): ProjectRuntime {
    const projectRoot = resolvePath(projectKey ?? deps.fallbackProjectRoot);
    deps.onProjectActivated?.(projectRoot);
    const cached = deps.runtimes.get(projectRoot);
    if (cached) {
      return cached;
    }

    const buildStartedAt = Date.now();
    const snapshot = loadPilotConfig({ projectRoot, env: deps.env });
    const { model, tokenAccounting, pluginRuntime, router } = createModelAndRouterLayer(projectRoot, deps, snapshot);
    const backgroundTasks = new BackgroundTaskRuntime({
      now: deps.now,
      onCompletion: event => emitBackgroundTaskCompletion(deps.getGateway(), event),
    });

    const memoryLayer = createProjectMemoryLayer({
      snapshot,
      projectRoot,
      env: deps.env,
      now: deps.now,
      telemetry: deps.telemetry,
    });
    const { tools, patentVerdict } = createProjectTools({
      snapshot,
      projectRoot,
      pilotHome: deps.pilotHome,
      env: deps.env,
      backgroundTasks,
      embeddingClient: memoryLayer.embeddingClient,
      memory: memoryLayer.memory,
      pluginRuntime,
      getExtraTools: deps.getExtraTools,
      getTeamTools: deps.getTeamTools,
      getKanbanBoardManager: deps.getKanbanBoardManager,
    });
    const knowledge = createKnowledgeResolverLayer({
      snapshot,
      knowledgePaths: memoryLayer.knowledgePaths,
      embeddingClient: memoryLayer.embeddingClient,
      rerankClient: memoryLayer.rerankClient,
      embeddingDir: memoryLayer.embeddingDir,
      memory: memoryLayer.memory,
    });

    const runtime: ProjectRuntime = {
      projectRoot,
      snapshot,
      model,
      tokenAccounting,
      router,
      pluginRuntime,
      tools,
      backgroundTasks,
      memory: knowledge.memoryResolver,
      memoryService: knowledge.memoryService,
      knowledgePaths: memoryLayer.knowledgePaths,
      knowledgeStats: knowledge.knowledgeStats,
      knowledgeEmbeddingConfigured: knowledge.knowledgeEmbeddingConfigured,
      knowledgeRerankConfigured: knowledge.knowledgeRerankConfigured,
      patentDomainEnabled: patentVerdict.enabled,
      projectStorage: {
        projectRoot,
        pilotHome: deps.pilotHome,
      },
    };
    deps.runtimes.set(projectRoot, runtime);
    // 首屏风暴观测（SATI_DEBUG=1 可见，保留为常态可观测性）：/api/projects 的串行
    // 列表会为每个工作区各触发一次这里（缓存未命中时全量装配），逐项耗时之和即
    // 风暴墙钟。排查首屏慢时按本行定位 top 项目（`project runtime built`）。
    logger.debug(`project runtime built for ${projectRoot} in ${Date.now() - buildStartedAt}ms`);
    return runtime;
  }

  return { resolve };
}
