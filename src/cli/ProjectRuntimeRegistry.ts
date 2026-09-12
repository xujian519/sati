/**
 * 项目运行时注册表：按 projectRoot 缓存并装配 ProjectRuntime（rules / tools / mcp / memory / model）。
 * 从 createLocalGateway.ts 逐字迁出（#147 P4a 第二刀），组合根只保留工厂编排。
 */

import { appendFileSync, existsSync, mkdirSync as mkdirSyncFs, renameSync } from "node:fs";
import { join as joinPath, resolve } from "node:path";
import type { EdgeClawMemoryService } from "edgeclaw-memory-core";
import { brandEnv, ENV_KEY } from "../env.js";
import { parsePositiveInt } from "../shared/env/index.js";
import { resolveEmbeddingClient, resolveRerankClient } from "../model/embedding/index.js";
import type { PilotConfigDiagnostic, PilotConfigSnapshot } from "../pilot/config/types.js";
import type { SessionConfigOverrides } from "../always-on/runtime/SessionConfigOverrides.js";
import {
  type AgentRuntimeConfig,
  type AgentSession,
  createAgentEventBuffer,
  type CreateAgentSessionOptions,
  createAgentSessionWithStorage,
} from "../agent/index.js";
import { resolveRoutedModelMaxContextTokens } from "../agent/runtime/modelContextWindow.js";
import type { TeamToolsOptions } from "../tool/builtin/team/index.js";
import { type ScopeToolsOptions } from "../agent/sub/scopeTools.js";
import { parseMemberSessionKey, TeamDb } from "../agent/team/index.js";
import type { MemoryResolver } from "../context/index.js";
import {
  AutoCompactionPolicy,
  CachedMicroCompactionEngine,
  CompactionEngine,
  ContextOverflowRecovery,
  createEdgeClawMemoryProviderFromConfig,
  DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
  DefaultContextRuntime,
  InstructionDiscovery,
  MicroCompactionEngine,
  PluginRuntimeExtensionResolver,
  SnipEngine,
  TokenAccountingRuntime,
  TokenBudgetManager,
  ToolResultBudget,
} from "../context/index.js";
import { FileHistoryStore } from "../session/filesystem/FileHistoryStore.js";
import type { AgentSubagentTranscriptHooks } from "../agent/runtime/AgentRuntimeDependencies.js";
import { createPlanTodoStateManager } from "../agent/runtime/PlanTodoState.js";
import type { KnowledgeDbPaths } from "../knowledge/index.js";
import {
  buildKnowledgeResolvers,
  CompositeMemoryResolver,
  createCaseLawSemanticSource,
  createKnowledgeEmbeddingSearch,
  getOrCreatePersonalNoteIndex,
  KnowledgeRuntimeStats,
  logKnowledgeCapabilities,
  resolveKnowledgeCapabilities,
  resolveKnowledgeDbPaths,
} from "../knowledge/index.js";
import { setCaseLawSemanticSource, setPersonalNoteSemanticSource } from "../tool/builtin/patentCaseSearch.js";
import type { KnowledgeCapabilitiesResult } from "../gateway/protocol/types.js";
import { HookRuntime, PluginRuntime } from "../extension/index.js";
import { LifecycleRuntime } from "../lifecycle/index.js";
import {
  GatewayElicitationChannel,
  type GatewayProjectStorageOptions,
  type GatewaySessionContext,
  type GatewaySubmitTurnInput,
  InProcessGateway,
  KanbanBoardManager,
  type ListSessionsInput,
  type ListSessionsResult,
} from "../gateway/index.js";
import {
  createGatewayPermissionHook,
  GATEWAY_PERMISSION_CALLBACK_NAME,
} from "../gateway/permission/createGatewayPermissionHook.js";
import {
  createMcpToolDefinitionsFromRuntime,
  loadMcpServerConfig,
  McpRuntime,
  parsePluginMcpServers,
} from "../mcp/index.js";
import { createModelRuntime, type ModelRuntime } from "../model/index.js";
import { createPolicyKey, normalizeRetryReason } from "../model/streaming/retryState.js";
import { applyReplayEnvHooks } from "../test-support/llm-replay/index.js";
import { resolveModelInfo } from "../model/resolveModelInfo.js";
import { injectMethodology, MethodologyRegistry } from "../methodology/index.js";
import {
  appendInventivenessFeedback,
  CASE_ROOT_REL,
  caseInventivenessFeedbackPath,
  extractMessageText,
  findCaseIdBySession,
  PatentOutputGate,
  type PendingPatentMessage,
} from "../patent/index.js";
import { isProvenanceEnabled } from "../patent/provenance/index.js";
import {
  loadPatentFullRuleSet,
  mergePolicyDenyRules,
  RuleOutputGate,
  rulesToPolicyDenyRules,
  selectGateRules,
} from "../rule/index.js";
import { createDefaultPermissionContext, type PermissionRule } from "../permission/index.js";
import { loadPilotConfig } from "../pilot/index.js";
import {
  createAgentProjectSessionStorage,
  listProjectSessions,
  RESUME_TURN_MESSAGE,
  resumeAgentSession,
  TaskResumeScanner,
} from "../session/index.js";
import { createSessionTitleGenerator } from "../session/title/SessionTitleGenerator.js";
import { type BackgroundTaskCompletionEvent, BackgroundTaskRuntime } from "../task/runtime/BackgroundTaskRuntime.js";
import type { SatiUnavailableToolDiagnostic } from "../tool/index.js";
import {
  createBuiltinRegistry,
  createPlanFileManager,
  type SatiToolDefinition,
  type ToolRegistry,
} from "../tool/index.js";
import { createRouterRuntime, type RouterRuntime } from "../router/index.js";
import type { RouterEvent, RouterEventBus } from "../router/protocol/events.js";
import { loadBuiltinPlugins } from "../extension/plugins/builtin/loadBuiltinPlugins.js";
import { createLogger, logger, type TelemetryClient } from "../telemetry/index.js";
import { ensureRouterConfig } from "./routerDefaults.js";
import {
  createApprovalStoreSafely,
  createAutoElicitationChannel,
  mergeSessionDependencies,
  syncRoleDefinitions,
} from "./gatewaySupport.js";
import { registerMcpAuxTools, registerToolsIfAbsent } from "./mcpToolRegistration.js";
import { provisionSessionTools } from "./sessionToolSurface.js";

const patentOutputGateLogger = createLogger("PatentOutputGate");
const ruleOutputGateLogger = createLogger("RuleOutputGate");

type ProjectRuntimeRegistryOptions = {
  fallbackProjectRoot: string;
  pilotHome: string;
  builtinSkillsRoot?: string;
  env: Record<string, string | undefined>;
  permissionMode: AgentRuntimeConfig["permissionMode"];
  now: () => Date;
  extraTools?: SatiToolDefinition[];
  sessionOverrides?: SessionConfigOverrides;
  additionalWorkingDirectories?: string[];
  /** @internal Test hook from `CreateLocalGatewayOptions.__testModelFactory`. */
  modelFactory?: (snapshot: PilotConfigSnapshot) => ModelRuntime;
  autoElicitation?: boolean;
  telemetry: TelemetryClient;
  /** 决策溯源旁路开关（见 CreateLocalGatewayOptions.enableProvenance）。 */
  enableProvenance?: boolean;
  onProjectActivated?: (projectRoot: string) => void;
};

type ProjectRuntime = {
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

/** M5：任务续算扫描启动延时——避开启动期 transcript 读盘竞争。 */
const TASK_RESUME_SCAN_DELAY_MS = 3_000;
/** M4：路由事件审计落盘批量 flush 间隔（unref，不持 event loop）。 */
const ROUTER_EVENT_FLUSH_INTERVAL_MS = 250;

export class ProjectRuntimeRegistry {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private gateway?: InProcessGateway;
  /** M4：路由事件审计总线（resolve 时创建，createLocalGateway dispose 经此 flush 缓冲）。 */
  routerEventBus: RouterEventBus | null = null;
  /**
   * Per-session live permission rules used when no `sessionOverrides`
   * entry exists. Same array reference is handed to:
   *   - `createDefaultPermissionContext({ rules })` so `PermissionRuntime.decide`
   *     sees current allow/deny entries.
   *   - `createGatewayPermissionHook({ permissionRules })` so the hook can
   *     push session-scoped allow rules on `remember=true` and have the
   *     very next `decide()` call inside this turn see them.
   * Without this fallback, remote-gateway clients (Web UI talking to
   * `sati server`) wouldn't be able to round-trip permission
   * prompts because they can't reach into the server's `sessionOverrides`
   * map from outside the process.
   */
  private readonly fallbackRuleSets = new Map<
    string,
    { allow: PermissionRule[]; deny: PermissionRule[]; ask: PermissionRule[] }
  >();

  /**
   * Per-project 宪法规则 deny 规则（`SATI_RULE_POLICY_BRIDGE_ENABLED` 开启时由
   * `prepareSessionRuntime` 编译并登记，默认关时为空数组）。
   * `createAgentConfig` 在构造 `PermissionContext` 时**无条件**前置合并它——
   * 会话级 `sessionOverrides.permissionRules` 覆盖不得静默关闭宪法拦截。
   */
  private readonly policyDenyRules = new Map<string, PermissionRule[]>();

  /**
   * Per-session MCP runtimes for `perSession: true` servers (e.g.
   * browser-use).  Each entry owns one or more child processes and a temp
   * directory.  Cleaned up by `evictSessionMcp()` when the SessionRouter
   * evicts the session (idle sweep, explicit close, or dirty-recreate).
   */
  private readonly sessionMcpRuntimes = new Map<string, McpRuntime>();

  /**
   * 推理方法论注册表（共享）：为所有会话的 `methodologyInjection` 回调提供
   * PDCA / SWOT / 5 Whys / MECE / Fishbone / First Principles / Six Hats 匹配。
   */
  private readonly methodologyRegistry = new MethodologyRegistry();

  /**
   * 活跃会话的 transcript 写入器（跨进程重启续算 T-A）：buildRouterEventBus 在
   * `sati_router_retry_progress` 到达时按 sessionId 查表，把 retry_schedule 写入
   * 该会话的 transcript 权威序列。会话 idle evict 后条目保留（writer 按路径
   * append，不依赖会话存活；retry 事件只会在会话活跃时到达）。
   */
  private readonly sessionWriters = new Map<string, import("../session/index.js").AgentTranscriptWriter>();
  private _extraTools: SatiToolDefinition[];
  private _sessionOverrides: SessionConfigOverrides | undefined;
  /** team_* 工具装配（M3）：createLocalGateway 经 setTeamTools 注入，resolve 时透传 createBuiltinRegistry。 */
  private _teamTools?: TeamToolsOptions;
  /** kanban_* 工具装配（Phase 4）：createLocalGateway 经 setKanbanBoardManager 注入，resolve 时透传 createBuiltinRegistry。 */
  private _kanbanBoardManager?: KanbanBoardManager;
  /** 成员工具作用域裁剪（P0-1）：createLocalGateway 经 setMemberToolScopeResolver 注入，成员会话创建时按角色裁剪工具集。 */
  private _memberToolScopeResolver?: (memberId: string) => ScopeToolsOptions | undefined;
  /** 成员挂起审批持久化（P0-3）：createLocalGateway 经 setTeamDb 注入，输出门禁挂起/决时写 teams.db——审批总线为内存态，崩溃即失。 */
  private _teamDb?: TeamDb;

  constructor(private readonly options: ProjectRuntimeRegistryOptions) {
    this._extraTools = options.extraTools ? [...options.extraTools] : [];
    this._sessionOverrides = options.sessionOverrides;
  }

  /**
   * Stop and discard the per-session MCP runtime for `sessionKey`.
   * Called by the `SessionRouter.onSessionEvict` callback.
   */
  evictSessionMcp(sessionKey: string): void {
    const mcp = this.sessionMcpRuntimes.get(sessionKey);
    if (mcp) {
      this.sessionMcpRuntimes.delete(sessionKey);
      mcp.stop().catch(() => {});
    }
  }

  setGateway(gateway: InProcessGateway): void {
    this.gateway = gateway;
  }

  private emitBackgroundTaskCompletion(event: BackgroundTaskCompletionEvent): void {
    if (!event.sessionId || !this.gateway) {
      return;
    }
    const outputPreview = event.outputPreview.trimEnd();
    this.gateway.emitForSession(event.sessionId, {
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

  private buildRouterEventBus(): RouterEventBus {
    const pilotHome = this.options.pilotHome;
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
            this.gateway?.broadcastRetryProgress(event);
          } catch {
            // 重试进度广播失败：事件仅审计展示，丢一条不影响重试链路（best-effort）。
          }
          // 跨进程重启续算 T-A：重试调度写入该会话 transcript 权威序列（log-only）。
          // 事件含 sessionId/turnId；无 turnId（子代理上下文）或会话未登记时跳过。
          try {
            if (typeof event.turnId === "string") {
              const writer = this.sessionWriters.get(event.sessionId);
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
                  scheduledAt: this.options.now().toISOString(),
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

  /**
   * Resolve the live permission-rule set for a session. Prefers any
   * explicit `sessionOverrides` entry (used by `always-on` to inject a
   * pre-populated allow list); otherwise lazily mints a per-session
   * fallback so the gateway permission hook always has a live array to
   * push `remember=true` grants into.
   */
  private getLiveRuleSet(sessionKey: string): {
    allow: PermissionRule[];
    deny: PermissionRule[];
    ask: PermissionRule[];
  } {
    const explicit = this._sessionOverrides?.get(sessionKey)?.permissionRules;
    if (explicit) {
      return {
        allow: explicit.allow ?? [],
        deny: explicit.deny ?? [],
        ask: explicit.ask ?? [],
      };
    }
    let auto = this.fallbackRuleSets.get(sessionKey);
    if (!auto) {
      auto = { allow: [], deny: [], ask: [] };
      this.fallbackRuleSets.set(sessionKey, auto);
    }
    return auto;
  }

  /**
   * Drop cached runtimes so the next `resolve()` call rebuilds from
   * a fresh `loadPilotConfig()` snapshot. Gracefully shuts down any
   * active MCP connections (both shared and per-session) before
   * discarding the entry.
   */
  invalidate(projectRoot?: string): void {
    for (const [, mcp] of this.sessionMcpRuntimes) {
      mcp.stop().catch(() => {});
    }
    this.sessionMcpRuntimes.clear();

    if (projectRoot) {
      const runtime = this.runtimes.get(projectRoot);
      if (runtime?.mcpRuntime) {
        runtime.mcpRuntime.stop().catch(() => {});
      }
      runtime?.memoryService?.close();
      runtime?.router?.shutdown().catch(() => {});
      this.runtimes.delete(projectRoot);
    } else {
      for (const [, runtime] of this.runtimes) {
        if (runtime.mcpRuntime) {
          runtime.mcpRuntime.stop().catch(() => {});
        }
        runtime.memoryService?.close();
        runtime.router?.shutdown().catch(() => {});
      }
      this.runtimes.clear();
    }
  }

  /**
   * Replace subsystem-owned tools and session overrides (Always-On / Cron).
   * Called after the subsystem lifecycle is torn down and rebuilt so that
   * future session creations pick up the new tool definitions and override
   * map. Also invalidates cached runtimes.
   */
  updateSubsystems(config: { extraTools: SatiToolDefinition[]; sessionOverrides?: SessionConfigOverrides }): void {
    this._extraTools = config.extraTools;
    this._sessionOverrides = config.sessionOverrides;
    this.invalidate();
  }

  /**
   * 团队工具装配（M3 Task 9）：teamDb/teamScheduler 在 createLocalGateway 函数体内
   * 构造，晚于本类首次 resolve()，故经 setter 注入并 invalidate 清缓存——后续会话
   * 创建重建 runtime 时 createBuiltinRegistry 收到 options.team，注册 9 个 team_*
   * 工具（管理面 6 工具 domain "team:manage"、作业面 3 工具 domain "team"）。
   * 与配置热重载的 invalidate 语义一致；注入时点无会话消费者（model router /
   * memoryService 随重建恢复）。
   *
   * 覆盖语义：重复调用 = 引用替换 + 再次 invalidate（会 close 已缓存 runtime 的
   * memoryService 并 shutdown 其 model router）。必须在任何会话创建之前调用——
   * invalidate 之后首个会话创建即含 team_* 工具；调用后创建的 runtime 直接含
   * team_* 工具，不再受 invalidate 影响（除非配置热重载等再次重建）。
   */
  setTeamTools(team: TeamToolsOptions): void {
    this._teamTools = team;
    this.invalidate();
  }

  /**
   * 看板管理器注入（Phase 4）。必须在首次 resolve 前设置；设置后清空缓存，
   * 使下一个会话创建时重建的 tool registry 包含 kanban_* 工具。
   */
  setKanbanBoardManager(manager: KanbanBoardManager): void {
    this._kanbanBoardManager = manager;
    this.invalidate();
  }

  /**
   * 成员工具作用域解析器注入（P0-1）：成员会话（`team:` 前缀）创建时按成员角色
   * 裁剪工具集——只暴露角色 allowedTools/visibleDomains 白名单、剔除 omitTools，
   * 免除成员保有队长全工具的越权（对齐 Anthropic「subagent 只暴露极少专业工具」）。
   *
   * resolver(memberId) 返回 ScopeToolsOptions 或 undefined：未命中成员/角色未注册
   * 时降级不裁剪（与 member-waker 的 rolePrompt 降级语义一致）。
   * 裁剪仅在会话创建时烘焙一次（成员角色不可变 + 会话按需创建），无每回合开销；
   * 本 setter 不 invalidate——裁剪不入 runtime 缓存，仅作用于 prepareSessionRuntime。
   */
  setMemberToolScopeResolver(resolver: (memberId: string) => ScopeToolsOptions | undefined): void {
    this._memberToolScopeResolver = resolver;
  }

  /** P0-3：注入团队库（成员挂起审批持久化；输出门禁 onPending/onApproved/onRejected 接线）。 */
  setTeamDb(db: TeamDb): void {
    this._teamDb = db;
  }

  /**
   * Set the working directory override for a specific session.
   * Used by the Web UI execution path to point an agent session at
   * an isolated workspace (git-worktree / snapshot-copy) without
   * going through DiscoveryFire.
   */
  setSessionCwd(sessionKey: string, cwd: string): void {
    if (!this._sessionOverrides) return;
    const existing = this._sessionOverrides.get(sessionKey);
    this._sessionOverrides.set(sessionKey, { ...existing, cwd });
  }

  resolve(projectKey?: string): ProjectRuntime {
    const projectRoot = resolve(projectKey ?? this.options.fallbackProjectRoot);
    this.options.onProjectActivated?.(projectRoot);
    const cached = this.runtimes.get(projectRoot);
    if (cached) {
      return cached;
    }

    const snapshot = loadPilotConfig({ projectRoot, env: this.options.env });
    const baseModel = this.options.modelFactory
      ? this.options.modelFactory(snapshot)
      : createModelRuntime(snapshot.config.model);
    // Phase 4 T1: replay seam hooks. SATI_LLM_REPLAY_RECORD_ROOT records every
    // stream the gateway drives; SATI_LLM_REPLAY_ROOT replays a fixture without
    // an API key. Unset in normal operation (applyReplayEnvHooks is a no-op).
    const model = applyReplayEnvHooks(baseModel, this.options.env);
    const tokenAccounting = new TokenAccountingRuntime({
      modelConfig: snapshot.config.model,
    });
    const pluginRuntime = new PluginRuntime({
      projectRoot,
      pilotHome: this.options.pilotHome,
      builtinSkillsRoot: this.options.builtinSkillsRoot,
      builtinPlugins: loadBuiltinPlugins(),
      builtinPluginsEnabled: snapshot.config.extension.builtinPluginsEnabled,
    });
    const routerConfig = ensureRouterConfig(snapshot.config.router, snapshot.config.agent.model);
    const router = createRouterRuntime(routerConfig, {
      modelRuntime: model,
      now: this.options.now,
      customRouterRegistry: pluginRuntime,
      loadSkillPrompt: extensionId => pluginRuntime.loadSkillPrompt(extensionId),
      events: (this.routerEventBus = this.buildRouterEventBus()),
      telemetry: this.options.telemetry,
    });
    const backgroundTasks = new BackgroundTaskRuntime({
      now: this.options.now,
      onCompletion: event => this.emitBackgroundTaskCompletion(event),
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
      now: this.options.now,
      telemetry: this.options.telemetry,
      embeddingClient,
      embeddingDir,
    });

    const tools = createBuiltinRegistry({
      ...(this._teamTools ? { team: this._teamTools } : {}),
      ...(this._kanbanBoardManager ? { kanban: this._kanbanBoardManager } : {}),
      backgroundTasks: { runtime: backgroundTasks },
      searchPatentFigure: { embeddingClient },
      // 文书排版调参面板工具（opt-in：无参注册会破坏 llm-replay fixture 工具集匹配）
      documentStyle: {},
      // J-Space 工作区工具（opt-in：与工作区账本开关联动，避免破坏 fixture 工具集匹配）
      workspaceLedgerTools: brandEnv(this.options.env, ENV_KEY.WORKSPACE_LEDGER_ENABLED) === "1",
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
    for (const tool of this._extraTools) {
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
        pilotHome: this.options.pilotHome,
      },
    };
    this.runtimes.set(projectRoot, runtime);
    return runtime;
  }

  /**
   * 知识库能力自检报告（knowledge.capabilities 可观测性出口）。
   * 数据源与启动时 logKnowledgeCapabilities 同源（resolveKnowledgeCapabilities），
   * 额外携带运行时统计快照（缓存/语义/重排计数 + 熔断器状态）。
   */
  knowledgeCapabilitiesReport(projectKey?: string): KnowledgeCapabilitiesResult {
    const runtime = this.resolve(projectKey);
    const paths = runtime.knowledgePaths ?? resolveKnowledgeDbPaths();
    const embeddingConfigured = runtime.knowledgeEmbeddingConfigured ?? false;
    const rerankConfigured = runtime.knowledgeRerankConfigured ?? false;
    const stats = runtime.knowledgeStats?.snapshot();
    return {
      dataDir: paths.dataDir,
      capabilities: resolveKnowledgeCapabilities(paths, {
        embeddingConfigured,
        rerankConfigured,
        runtime: stats,
      }),
      embeddingConfigured,
      rerankConfigured,
      stats,
    };
  }

  scheduleMemoryMaintenance(projectKey?: string): void {
    const runtime = this.resolve(projectKey);
    const service = runtime.memoryService;
    if (!service) return;
    runtime.memoryMaintenanceRequested = true;
    if (runtime.memoryMaintenanceInFlight) return;
    runtime.memoryMaintenanceInFlight = (async () => {
      while (runtime.memoryMaintenanceRequested) {
        runtime.memoryMaintenanceRequested = false;
        try {
          await service.runDueScheduledMaintenance("scheduled");
          this.options.telemetry.trackFeatureLoopStage({
            module: "memory",
            ownerModule: "memory",
            executionKind: "memory",
            phase: "maintenance",
            loopStage: "module_event",
            outcome: "success",
            metadata: {
              phase: "maintenance_completed",
            },
          });
        } catch (error) {
          this.options.telemetry.trackError(error, {
            module: "memory",
            ownerModule: "memory",
            executionKind: "memory",
            phase: "maintenance",
            loopStage: "loop_end",
            errorCategory: "loop_error",
            code: error instanceof Error ? error.name : "UnknownError",
          });

          logger.warn(
            `memory maintenance failed for project ${runtime.projectRoot}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    })().finally(() => {
      runtime.memoryMaintenanceInFlight = undefined;
      if (runtime.memoryMaintenanceRequested) {
        this.scheduleMemoryMaintenance(projectKey);
      }
    });
  }

  /**
   * Lazily start the MCP runtime for this project. Idempotent — concurrent
   * callers share a single in-flight promise. Errors are swallowed (logged
   * to stderr) so a misbehaving MCP server can't take the gateway down.
   */
  private ensureMcpReady(runtime: ProjectRuntime): Promise<void> {
    if (runtime.mcpReady) return runtime.mcpReady;
    runtime.mcpReady = (async () => {
      try {
        const configServers = loadMcpServerConfig(runtime.projectRoot, this.options.pilotHome);
        for (const diagnostic of configServers.diagnostics) {
          logger.warn(`Ignoring invalid MCP config ${diagnostic.path}: ${diagnostic.message}`);
        }
        const rawServers = {
          ...runtime.pluginRuntime.mcpServers(),
          ...configServers.servers,
        };
        const { servers } = parsePluginMcpServers(rawServers);
        if (servers.length === 0) return;

        const sharedServers = servers.filter(s => s.transport !== "stdio" || !s.perSession);
        const perSessionServers = servers.filter(s => s.transport === "stdio" && s.perSession);

        runtime.perSessionServerSpecs = perSessionServers.length > 0 ? perSessionServers : undefined;

        if (sharedServers.length > 0) {
          const mcp = new McpRuntime(sharedServers);
          runtime.mcpRuntime = mcp;
          await mcp.start();
          registerToolsIfAbsent(runtime.tools, await createMcpToolDefinitionsFromRuntime(mcp));
        }

        // MCP resources + status tools are registered whenever a project-level
        // (shared) MCP runtime exists. Per-session runtimes are session-scoped
        // and therefore not reflected in these tools.
        if (runtime.mcpRuntime) {
          registerMcpAuxTools(runtime.tools, runtime.mcpRuntime);
        }
      } catch (error) {
        logger.warn(
          `MCP runtime startup partial-failed for project ${runtime.projectRoot}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
    return runtime.mcpReady;
  }

  async createSession(context: GatewaySessionContext) {
    const prepared = await this.prepareSessionRuntime(context);
    const resumed = await resumeAgentSession({
      sessionId: context.sessionKey,
      config: this.createAgentConfig(prepared.runtime, context),
      dependencies: prepared.baseDependencies,
      projectStorage: prepared.runtime.projectStorage,
      extendDependencies: prepared.extendDependencies,
      sessionTitleGenerator: prepared.sessionTitleGenerator,
      collectFileArtifacts: this.shouldCollectFileArtifacts(prepared.runtime),
      outputGate: prepared.patentOutputGate,
    });
    // 跨进程重启续算 T-A：登记会话转录写入器，供 retry_schedule 轨迹落盘。
    this.sessionWriters.set(context.sessionKey, resumed.writer);
    return resumed.session;
  }

  /**
   * 跨进程重启续算（T-C）：gateway 启动时扫描中断任务并提交续算 turn。
   * fire-and-forget（宿主在 build 流程调用，不阻塞启动）。
   *
   * 续算 = 以新 turn 提交（RESUME_TURN_MESSAGE）；gateway 内部 createSession
   * 会 resume 会话（旧开放 turn 由 resumeAgentSession 合成 interrupted 收尾），
   * 新 turn 基于 transcript 重建的上下文继续，任务自动续算到完成。
   *
   * M5：扫描延时 3s 启动——避开启动期 transcript 全量读竞争（会话恢复/列表
   * 首屏），延后到事件循环空闲后再触发。
   */
  runTaskResumeScan(): void {
    const enabled = brandEnv(this.options.env, ENV_KEY.TASK_RESUME_ENABLED) !== "0";
    if (!enabled) return;
    const gateway = this.gateway;
    if (!gateway) return;
    const scanner = new TaskResumeScanner({
      projectRoot: this.options.fallbackProjectRoot,
      pilotHome: this.options.pilotHome,
      submitResumeTurn: async sessionKey => {
        const input: GatewaySubmitTurnInput = {
          sessionKey,
          channelKey: "cron",
          message: RESUME_TURN_MESSAGE,
          canPrompt: false,
        };
        // 消费全部事件使续算 turn 驱动到完成（串行，避免并发写同一会话）。
        for await (const _event of gateway.submitTurn(input)) {
          // drain
        }
      },
      hasPendingApprovals: sessionKey => gateway.getApprovalBus().list(sessionKey).length > 0,
    });
    setTimeout(() => {
      void scanner
        .scan()
        .then(result => {
          if (result.resumed > 0) {
            logger.info(
              `Task resume: scanned=${result.scanned}, resumed=${result.resumed}, ` +
                `skippedPartial=${result.skippedPartial}, skippedApprovals=${result.skippedApprovals}`,
            );
          }
        })
        .catch(() => undefined);
    }, TASK_RESUME_SCAN_DELAY_MS);
  }

  async recreateSession(context: GatewaySessionContext, previousSession: AgentSession) {
    const prepared = await this.prepareSessionRuntime(context);
    const previous = previousSession.snapshotForRuntimeReload();
    const storage = createAgentProjectSessionStorage({
      ...prepared.runtime.projectStorage,
      sessionId: context.sessionKey,
      now: prepared.baseDependencies.now,
    });
    if (previous.transcriptWriterState) {
      storage.transcript.restoreState(
        previous.transcriptWriterState.sequence,
        previous.transcriptWriterState.lastEntryId,
      );
    }
    const extensionDependencies = prepared.extendDependencies(storage);
    const { session } = createAgentSessionWithStorage({
      sessionId: context.sessionKey,
      config: this.createAgentConfig(prepared.runtime, context),
      dependencies: mergeSessionDependencies(prepared.baseDependencies, extensionDependencies),
      storage,
      transcript: storage.transcript,
      initialState: previous.state,
      seedState: previous.fileState,
      sessionTitleGenerator: prepared.sessionTitleGenerator,
      collectFileArtifacts: this.shouldCollectFileArtifacts(prepared.runtime),
      outputGate: prepared.patentOutputGate,
    });
    return session;
  }

  private shouldCollectFileArtifacts(runtime: ProjectRuntime): boolean {
    return resolve(runtime.projectRoot) !== resolve(this.options.pilotHome);
  }

  private async prepareSessionRuntime(context: GatewaySessionContext) {
    const runtime = this.resolve(context.projectKey);
    await runtime.pluginRuntime.refresh();
    syncRoleDefinitions(runtime.pluginRuntime, this.options.builtinSkillsRoot);
    await this.ensureMcpReady(runtime);
    const contributions = runtime.pluginRuntime.snapshotContributions();
    const toolSurface = await provisionSessionTools({
      sessionKey: context.sessionKey,
      projectTools: runtime.tools,
      projectRoot: runtime.projectRoot,
      env: this.options.env,
      proxy: runtime.snapshot.config.proxy,
      perSessionServerSpecs: runtime.perSessionServerSpecs,
      maxPerSessionMcpInstances: runtime.snapshot.config.gateway?.maxPerSessionMcpInstances ?? 5,
      sessionMcpRuntimes: this.sessionMcpRuntimes,
      evictSessionMcp: sessionKey => this.evictSessionMcp(sessionKey),
      sessionOverrides: this._sessionOverrides,
      extraTools: this._extraTools,
      memberToolScopeResolver: this._memberToolScopeResolver,
    });
    const sessionTools = toolSurface.tools;
    runtime.unavailableTools = toolSurface.unavailableTools;

    // Inject the gateway's interactive permission hook so the agent's
    // PermissionRequest lifecycle is round-tripped through whichever
    // client is streaming this session (Web UI, TUI, etc.) instead of
    // returning `permission_required` errors. The hook mutates the
    // session's live `permissionRules.allow` array on `remember=true`,
    // so a subsequent tool call inside the same turn bypasses the ask
    // path without waiting for the next turn.
    //
    // We register unconditionally whenever a gateway is wired up. If no
    // client is actively streaming, `gw.emitForSession()` returns false
    // and the hook auto-denies — better than silently hanging.
    const gw = this.gateway;
    const liveRuleSet = this.getLiveRuleSet(context.sessionKey);
    const hookSettings: typeof contributions.hooks = gw
      ? {
          ...contributions.hooks,
          PermissionRequest: [
            ...(contributions.hooks.PermissionRequest ?? []),
            {
              hooks: [{ type: "callback", name: GATEWAY_PERMISSION_CALLBACK_NAME }],
            },
          ],
        }
      : contributions.hooks;
    const hookRuntime = new HookRuntime(hookSettings);
    if (gw) {
      hookRuntime.getCallbackExecutor().register(
        GATEWAY_PERMISSION_CALLBACK_NAME,
        createGatewayPermissionHook({
          sessionKey: context.sessionKey,
          bus: gw.getPermissionBus(),
          emit: event => gw.emitForSession(context.sessionKey, event),
          permissionRules: liveRuleSet.allow,
        }),
      );
    }
    const lifecycle = new LifecycleRuntime(hookRuntime);
    const extension = new PluginRuntimeExtensionResolver(runtime.pluginRuntime, {
      // B3 upgrade path: surface instructions fetched from live MCP servers
      // (McpRuntime.getInstructions) on top of the static plugin-declared ones.
      runtimeMcpInstructions: () => runtime.mcpRuntime?.getInstructions() ?? [],
    });
    const projectRoot = runtime.projectRoot;
    const memoryResolver = runtime.memory;
    const now = this.options.now;
    const eventBuf = createAgentEventBuffer();

    const baseDependencies: CreateAgentSessionOptions["dependencies"] = {
      router: runtime.router,
      tools: { registry: sessionTools },
      lifecycle,
      now: this.options.now,
      eventEmitter: eventBuf.emitter,
      drainEvents: eventBuf.drain,
      tokenAccounting: runtime.tokenAccounting,
      getModelMaxContextTokens: (provider, model) =>
        resolveRoutedModelMaxContextTokens({
          modelRuntime: runtime.model,
          agentModel: runtime.snapshot.config.agent.model,
          agentMaxContextTokens: runtime.snapshot.config.agent.maxContextTokens,
          provider,
          model,
        }),
      getProviderProtocol: providerId => {
        try {
          return runtime.model.getProviderProtocol(providerId);
        } catch {
          // provider 未知时无协议可查 → 返回 undefined，调用方按默认协议处理。
          return undefined;
        }
      },
      getModelMaxOutputTokens: (provider, model) => {
        try {
          return runtime.model.getCapabilities(provider, model).maxOutputTokens;
        } catch {
          // provider/model 未知 → 输出上限未知，返回 undefined 走环境变量/默认兜底。
          return undefined;
        }
      },
      getModelTokenLimits: (provider, model) => {
        try {
          const caps = runtime.model.getCapabilities(provider, model);
          return { maxContextTokens: caps.maxContextTokens, maxOutputTokens: caps.maxOutputTokens };
        } catch {
          // 同上：能力查询失败即返回 undefined，由调用方兜底，不阻断启动。
          return undefined;
        }
      },
    };
    const sessionTitleGenerator = createSessionTitleGenerator({
      modelRuntime: runtime.model,
      agentModel: runtime.snapshot.config.agent.model,
    });
    const extendDependencies = (storage: ReturnType<typeof createAgentProjectSessionStorage>) => {
      const toolResultBudget = new ToolResultBudget({ toolResultsDir: storage.toolResultsDir });
      const tokenBudget = new TokenBudgetManager();
      const compactionEngine = new CompactionEngine({
        model: {
          stream: (request, signal) =>
            runtime.router.stream(request, {
              sessionId: context.sessionKey,
              turnId: "compact",
              projectPath: context.projectKey,
              abortSignal: signal,
              isMainAgent: false,
            }),
        },
        tokenBudget,
        tokenAccounting: runtime.tokenAccounting,
        lifecycle: {
          async dispatch(input) {
            await lifecycle.dispatch({
              event: input.event,
              baseInput: {
                sessionId: context.sessionKey,
                transcriptPath: "",
                cwd: projectRoot,
                permissionMode: "default",
              },
              payload: input.payload,
              matchQuery: input.event,
            });
          },
        },
        provider: runtime.snapshot.config.agent.model.provider,
        model_: runtime.snapshot.config.agent.model.model,
        protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
        now,
        eventEmitter: eventBuf.emitter,
      });
      const autoCompactionPolicy = new AutoCompactionPolicy();
      const microcompactEngine = new CachedMicroCompactionEngine({ enabled: true });
      const microCompaction = new MicroCompactionEngine({
        protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
      });
      const snipEngine = new SnipEngine({
        protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
      });
      const overflowRecovery = new ContextOverflowRecovery();
      const caps = runtime.model.getCapabilities(
        runtime.snapshot.config.agent.model.provider,
        runtime.snapshot.config.agent.model.model,
      );
      const instructionDiscovery = new InstructionDiscovery(projectRoot, projectRoot, this.options.pilotHome);
      const contextRuntime = new DefaultContextRuntime({
        extension,
        projectRoot,
        memoryResolver,
        memoryRetrievalTimeoutMs: runtime.snapshot.config.memory?.retrievalTimeoutMs,
        // 项目知识偏好透传：knowledge provider 据此强制注入/加权审查标准
        knowledgeProfile: runtime.snapshot.config.memory?.knowledgeProfile,
        instructionDiscovery,
        toolResultBudget,
        tokenBudget,
        compactionEngine,
        autoCompactionPolicy,
        microcompactEngine,
        microCompaction,
        snipEngine,
        overflowRecovery,
        maxContextTokens: runtime.snapshot.config.agent.maxContextTokens ?? caps.maxContextTokens,
        now,
      });
      const fileHistory = new FileHistoryStore({
        backupDir: storage.fileHistoryDir,
        now: this.options.now,
      });
      const gw = this.gateway;
      const elicitation = this.options.autoElicitation
        ? createAutoElicitationChannel()
        : gw
          ? new GatewayElicitationChannel({
              sessionKey: context.sessionKey,
              bus: gw.getElicitationBus(),
              emit: event => gw.emitForSession(context.sessionKey, event),
              dispatchHook: (hookEvent, payload) => {
                lifecycle
                  .dispatch({
                    event: hookEvent as import("../extension/hooks/protocol/events.js").SatiHookEvent,
                    baseInput: { sessionId: context.sessionKey, transcriptPath: "", cwd: projectRoot },
                    payload,
                    matchQuery: hookEvent,
                  })
                  .catch(() => {});
              },
              emitAgentEvent: (_type, payload) => {
                eventBuf.emitter({
                  type: "elicitation_requested",
                  sessionId: context.sessionKey,
                  turnId: "",
                  requestId: payload.requestId,
                  toolName: payload.toolName,
                });
              },
            })
          : undefined;
      const subagentTranscript: AgentSubagentTranscriptHooks = {
        recordSubagentStarted: args =>
          storage.transcript.recordSubagentStarted(args.sessionId, args.turnId, {
            subagentId: args.subagentId,
            subagentType: args.subagentType,
            prompt: args.prompt,
            transcriptRelativePath: args.transcriptRelativePath,
            subagentSessionId: args.subagentSessionId,
          }),
        recordSubagentCompleted: args =>
          storage.transcript.recordSubagentCompleted(args.sessionId, args.turnId, {
            subagentId: args.subagentId,
            subagentType: args.subagentType,
            summary: args.summary,
            usage: args.usage,
            turns: args.turns,
            durationMs: args.durationMs,
            errored: args.errored,
          }),
        subagentTranscriptResolver: subagentId => {
          const handle = storage.transcript.forSubagent(subagentId, this.options.now);
          return {
            recordAcceptedInput: (sessionId, turnId, messages) =>
              handle.writer.recordAcceptedInput(sessionId, turnId, messages),
            recordDurableMessage: (sessionId, turnId, message) =>
              handle.writer.recordDurableMessage(sessionId, turnId, message),
            // 子代理收尾时排空 sidechain 写缓冲：sidechain 无 turn_result 强制
            // flush，仅靠 50ms 兜底定时器（unref）——进程在间隔内退出丢尾条。
            flush: () => handle.writer.flushCheckpoint(),
            transcriptRelativePath: storage.transcript.relativeSubagentPath(subagentId),
          };
        },
      };
      const planFileManager = createPlanFileManager({ projectRoot });
      const planTodoManager = createPlanTodoStateManager();
      return {
        context: contextRuntime,
        fileHistory,
        subagentTranscript,
        elicitation,
        planFileManager,
        planTodoManager,
      };
    };
    /**
     * 专利输出门禁（每会话一个）：命中审批词的消息挂起等待人工审批，审批入口
     * 为 `AgentSession.approvePendingOutput/rejectPendingOutput`，经 gateway
     * `approval_list_pending` / `approval_decide` 命令暴露给审批 UI（Web/TUI）。
     * 挂起时把条目注册进 gateway 审批总线并广播 `approval_pending` 事件；
     * 审批完成（onApproved/onRejected）时从总线移除并广播 `approval_resolved`。
     * 消息本体挂起时已入库（不丢消息），挂起/审批仅为流程控制。
     *
     * 保守默认：仅保留审批词 HITL 拦截（专利结论/侵权判断/有效性结论/最终建议），
     * 关闭绝对化表述改写、风险词免责声明与法条核验——避免专利词表污染普通会话的
     * 用户可见消息（如"一定/百分百"被追加改写提示）。需要完整门禁时显式传入
     * 关键词表与 `enableCitationGate: true`。
     */
    const sessionKey = context.sessionKey;
    // 审批完成收口：从总线移除 + 广播 approval_resolved（onApproved/onRejected 共用）。
    // P0-3：同步删除持久化挂起项（成员会话）——bus/表双态收敛，冷恢复 hasPendingApproval
    // 据此不再判定该成员挂起。
    const resolveApproval = (pending: PendingPatentMessage, verdict: "adopted" | "rejected") => {
      this.gateway?.getApprovalBus().remove(sessionKey, pending.index);
      this._teamDb?.deletePendingApproval(sessionKey, pending.index);
      this.gateway?.emitForSession(sessionKey, {
        type: "approval_resolved",
        sessionKey,
        pendingIndex: pending.index,
        verdict,
      });
    };
    // 规则驱动门禁（B 链）：只接入「出现即违规」的 keyword_blocklist 规则子集
    // （structural_analysis 缺失即违规对任意输出海量误报，仅 rule_check 自检用）。
    // 加载失败（含规则资产缺失/损坏）→ 空规则集降级放行 + 告警。
    const fullRuleSet = loadPatentFullRuleSet();
    if (fullRuleSet.warnings.length > 0) {
      ruleOutputGateLogger.warn(`专利规则集加载告警: ${fullRuleSet.warnings.join("; ")}`);
    }
    const ruleGate = new RuleOutputGate(selectGateRules(fullRuleSet.ruleSet));
    // 宪法规则工具拦截通道（C 链，默认关）：block + keyword_blocklist 且**非输出面 phase**
    // 的规则编译为 policy deny 规则，交 createAgentConfig 前置注入 PermissionContext.rules.deny。
    // phase 语义门见 src/rule/runtime/policy-bridge.ts；当前规则资产的 block 规则均为
    // post_execution（输出面），故开启后编译结果为空——显式告警而非静默"已启用却无规则"。
    const policyDenyRules: PermissionRule[] = [];
    if (brandEnv(this.options.env, ENV_KEY.RULE_POLICY_BRIDGE_ENABLED) === "1") {
      const compiled = rulesToPolicyDenyRules(fullRuleSet.ruleSet);
      policyDenyRules.push(...compiled.rules);
      if (compiled.rules.length === 0) {
        ruleOutputGateLogger.warn(
          `policy-bridge 已启用，但当前规则资产无可拦截规则（跳过 ${compiled.skipped.length} 条：block 规则均为输出面语义）`,
        );
      } else {
        ruleOutputGateLogger.info(
          `policy-bridge 已启用：编译 ${compiled.rules.length} 条 deny 规则（跳过 ${compiled.skipped.length} 条）`,
        );
      }
    }
    this.policyDenyRules.set(runtime.projectRoot, policyDenyRules);
    // 决策溯源旁路（P6 双通道单点）：默认关 → approvalStore 不配置，output-gate 零开销。
    const enableProvenance = isProvenanceEnabled({
      enableProvenance: this.options.enableProvenance,
      env: this.options.env,
    });
    // 评审 I2：gateway 程序化开启时同步进程级 env，使同一进程内工具层
    // （openProvenanceCollector 读 process.env）与 gateway 判定同源，避免半开状态。
    if (enableProvenance && process.env.SATI_PROVENANCE !== "1") {
      process.env.SATI_PROVENANCE = "1";
    }
    // 评审 I3：审批审计库打开失败（目录只读/损坏/魔数不符）只降级为不落盘，
    // 绝不拖垮 gateway（构造期 fail-open；saveRecord 已内建 fail-open）。
    const approvalStore = enableProvenance ? createApprovalStoreSafely() : undefined;
    const patentOutputGate = new PatentOutputGate({
      riskKeywords: [],
      absolutePhrases: [],
      enableCitationGate: false,
      ruleGate,
      // 审批审计落盘（全局库；写入失败不阻断审批）
      ...(approvalStore !== undefined ? { approvalStore } : {}),
      // 时钟与 Agent 层注入对齐（TurnRunner/AgentLoop 共用 this.options.now）
      now: () => this.options.now().getTime(),
      onPending: pending => {
        // 注册进 gateway 审批总线 + 广播 approval_pending（审批 UI 展示入口）。
        const gw = this.gateway;
        const textPreview = extractMessageText(pending.processed).trim().slice(0, 500);
        // 关键词审批词优先；否则回退到规则门禁命中的规则 id（含法律依据语义）
        const triggerKeyword = pending.info.approvalKeywordsHit[0] ?? pending.ruleViolations?.[0]?.ruleId ?? "approval";
        if (gw) {
          gw.getApprovalBus().register({
            sessionKey,
            pendingIndex: pending.index,
            textPreview,
            triggerKeyword,
            sessionId: pending.sessionId,
            turnId: pending.turnId,
            createdAt: pending.createdAt,
          });
          gw.emitForSession(sessionKey, {
            type: "approval_pending",
            sessionKey,
            pendingIndex: pending.index,
            textPreview,
            triggerKeyword,
            sessionId: pending.sessionId,
            turnId: pending.turnId,
            createdAt: pending.createdAt,
          });
        }
        // P0-3：成员会话挂起审批落 teams.db——审批总线是进程内存态，崩溃即失；
        // 落表后冷恢复重建 bus、hasPendingApprovals 判定、decide 收敛有据可依。
        // createdAt 落 ISO 字符串（与 teams/members/tasks 列一致），重建 bus 时转回时间戳。
        const memberKey = parseMemberSessionKey(sessionKey);
        if (memberKey !== null && this._teamDb) {
          this._teamDb.upsertPendingApproval({
            teamId: memberKey.teamId,
            memberId: memberKey.memberId,
            sessionKey,
            pendingIndex: pending.index,
            triggerKeyword,
            textPreview,
            sessionId: pending.sessionId,
            turnId: pending.turnId,
            createdAt: new Date(pending.createdAt).toISOString(),
          });
        }
        // 日志仅记录定位信息，不打消息内容（专利结论可能含敏感信息）
        patentOutputGateLogger.warn(
          `专利结论待人工审批: session=${pending.sessionId ?? "-"} turn=${pending.turnId ?? "-"} index=${pending.index}`,
        );
      },
      onApproved: pending => {
        resolveApproval(pending, "adopted");
        patentOutputGateLogger.info(
          `审批通过: session=${pending.sessionId ?? "-"} turn=${pending.turnId ?? "-"} index=${pending.index}`,
        );
      },
      onRejected: pending => {
        resolveApproval(pending, "rejected");
        patentOutputGateLogger.warn(
          `审批拒绝: session=${pending.sessionId ?? "-"} turn=${pending.turnId ?? "-"} index=${pending.index}`,
        );
      },
      // 决策反馈回流（P2-4 写侧）：modified/rejected 时经 session→case 绑定（
      // patent_workflow_run graph=inventiveness 运行时落盘）反查 caseId，追加进
      // <caseDir>/inventiveness-feedback.jsonl——重跑同 case 时注入 conclude 提示。
      // 绑定缺失/写入失败 fail-open（告警即止），不阻断审批闭环。
      onDecisionFeedback: record => {
        const sessionId = record.sessionId;
        if (sessionId === undefined) return;
        void (async () => {
          // 反查根与工具写侧同源：会话级 cwd 覆盖时工具把绑定写到覆盖目录下，
          // 这里必须走同一解析链（override.cwd ?? projectRoot），否则绑定永远找不到。
          const casesRoot = joinPath(this._sessionOverrides?.get(sessionKey)?.cwd ?? projectRoot, CASE_ROOT_REL);
          const caseId = await findCaseIdBySession(casesRoot, sessionId);
          if (caseId === undefined) return;
          await appendInventivenessFeedback(joinPath(casesRoot, caseInventivenessFeedbackPath(caseId)), {
            caseId,
            originalOutputPreview: record.originalOutputPreview,
            verdict: record.verdict === "modified" ? "modified" : "rejected",
            ...(record.feedback !== undefined ? { feedback: record.feedback } : {}),
            ...(record.modifiedOutput !== undefined ? { modifiedOutput: record.modifiedOutput } : {}),
            // 溯源：绑定按 session 近似归属，同 session 内非创造性链路的审批也会
            // 命中绑定，triggerKeyword 供事后甄别/过滤。
            ...(record.triggerKeyword !== undefined ? { trigger: record.triggerKeyword } : {}),
            decidedAt: record.decidedAt,
          });
          patentOutputGateLogger.info(`创造性人工反馈已回流: case=${caseId} verdict=${record.verdict}`);
        })().catch(err => {
          patentOutputGateLogger.warn(`创造性人工反馈回流失败（fail-open）: ${(err as Error).message}`);
        });
      },
    });
    return {
      runtime,
      baseDependencies,
      sessionTitleGenerator,
      extendDependencies,
      patentOutputGate,
    };
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    const runtime = this.resolve(input.projectKey);
    const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
    const safeOffset = Number.isFinite(offset) ? offset : 0;
    const sessions = await listProjectSessions({
      ...runtime.projectStorage,
      limit: input.limit,
      offset: safeOffset,
    });
    const nextOffset = safeOffset + sessions.length;
    return {
      sessions,
      nextCursor: input.limit && sessions.length === input.limit ? String(nextOffset) : undefined,
    };
  }

  private createAgentConfig(
    runtime: ProjectRuntime,
    context: GatewaySessionContext,
  ): CreateAgentSessionOptions["config"] {
    const agent = runtime.snapshot.config.agent;
    const override = this._sessionOverrides?.get(context.sessionKey);
    const permissionMode = override?.permissionMode ?? this.options.permissionMode;
    const cwd = override?.cwd ?? runtime.projectRoot;
    // M4：会话级模型路由覆盖（团队成员唤醒传快照 modelRoute）——仅覆盖本次会话的
    // provider/model，不改全局配置、不动 PilotConfigStore。整体应用（质量评审 M3）：
    // provider/model 双字段非空才覆盖——WS 线协议可直传部分字段（编译期约束管不到
    // 线协议），任一缺失整体回落项目默认，避免 provider 与 model 拼错对。
    let provider = agent.model.provider;
    let model = agent.model.model;
    const modelRoute = context.modelRoute;
    if (
      modelRoute !== undefined &&
      typeof modelRoute.provider === "string" &&
      modelRoute.provider.length > 0 &&
      typeof modelRoute.model === "string" &&
      modelRoute.model.length > 0
    ) {
      provider = modelRoute.provider;
      model = modelRoute.model;
    }
    // Hand `PermissionContext` the same live rule-set reference the
    // gateway permission hook owns (see `getLiveRuleSet`). With this
    // shared reference, an "allow + remember" decision pushed by the
    // hook is visible to `PermissionRuntime.decide` on the very next
    // tool call inside the same turn — no roundtrip back to the client
    // needed, even when the client lives in a different process.
    const liveRuleSet = this.getLiveRuleSet(context.sessionKey);
    // 阶段四 T3：统一能力解析（config → catalog → 协议默认），未知模型按
    // catalog/默认回退，而非盲目 text-only。
    const modelMultimodal: import("../model/index.js").MultimodalConstraints | undefined = resolveModelInfo(
      runtime.model,
      provider,
      model,
    ).multimodal;
    let maxContextTokens: number | undefined;
    let maxOutputTokens: number | undefined;
    try {
      const caps = runtime.model.getCapabilities(provider, model);
      maxContextTokens = agent.maxContextTokens ?? caps.maxContextTokens;
      maxOutputTokens = caps.maxOutputTokens;
    } catch {
      // 能力查询失败 → 上下文上限退回显式配置，输出上限留 undefined 由后续链路兜底。
      maxContextTokens = agent.maxContextTokens;
    }
    maxOutputTokens =
      parsePositiveInt(brandEnv(this.options.env, ENV_KEY.MAX_OUTPUT_TOKENS)) ??
      agent.maxOutputTokens ??
      maxOutputTokens;
    const subagentModel = agent.subagents?.default;
    let subagentRuntimeModel: CreateAgentSessionOptions["config"]["subagentModel"];
    if (subagentModel) {
      let subagentModelMultimodal: import("../model/index.js").MultimodalConstraints | undefined;
      try {
        subagentModelMultimodal = resolveModelInfo(
          runtime.model,
          subagentModel.provider,
          subagentModel.model,
        ).multimodal;
      } catch {
        // Model or provider not found — keep the override but fall back to inherited caps.
      }
      let subagentMaxContextTokens: number | undefined;
      let subagentMaxOutputTokens: number | undefined;
      try {
        const caps = runtime.model.getCapabilities(subagentModel.provider, subagentModel.model);
        subagentMaxContextTokens = caps.maxContextTokens;
        subagentMaxOutputTokens = caps.maxOutputTokens;
      } catch {
        // Keep the override even if capability lookup fails.
      }
      subagentRuntimeModel = {
        provider: subagentModel.provider,
        model: subagentModel.model,
        ...(subagentModelMultimodal ? { modelMultimodal: subagentModelMultimodal } : {}),
        ...(subagentMaxContextTokens !== undefined ? { maxContextTokens: subagentMaxContextTokens } : {}),
        ...(subagentMaxOutputTokens !== undefined
          ? {
              maxOutputTokens:
                parsePositiveInt(brandEnv(this.options.env, ENV_KEY.MAX_OUTPUT_TOKENS)) ?? subagentMaxOutputTokens,
            }
          : {}),
      };
    }
    return {
      provider,
      model,
      modelMultimodal,
      cwd,
      permissionMode,
      jsonSelfCorrect: true,
      workspaceLedger: brandEnv(this.options.env, ENV_KEY.WORKSPACE_LEDGER_ENABLED) === "1",
      metacognitiveControl: brandEnv(this.options.env, ENV_KEY.METACOGNITIVE_CONTROL_ENABLED) === "1",
      claimGuard: brandEnv(this.options.env, ENV_KEY.CLAIM_GUARD_ENABLED) === "1",
      ...(subagentRuntimeModel ? { subagentModel: subagentRuntimeModel } : {}),
      subagentTimeoutMs: agent.subagents?.timeoutMs,
      maxContextTokens,
      maxOutputTokens,
      thinking: agent.thinking,
      methodologyInjection: lastUserMessage => {
        // minScore 0.2：要求至少命中约 2 个触发词（1/8≈0.12 的单词偶然命中
        // 会被过滤，如"问题/优化/流程"单独出现时），避免日常对话被强制注入格式。
        const result = injectMethodology(this.methodologyRegistry, lastUserMessage, { minScore: 0.2 });
        return result.applied && result.prompt ? result.prompt : null;
      },
      permissionContext: createDefaultPermissionContext({
        cwd,
        mode: permissionMode,
        canPrompt: override?.canPrompt ?? true,
        bypassAvailable: override?.bypassAvailable ?? true,
        additionalWorkingDirectories: this.options.additionalWorkingDirectories,
        rules: {
          allow: liveRuleSet.allow,
          // policy deny 前置是不变式：PermissionRuntime 取 deny 首个匹配，仅在来源为
          // "user" 时才允许被 session allow 覆盖——policy 若排后会被该短路路径绕过。
          deny: mergePolicyDenyRules(liveRuleSet.deny, this.policyDenyRules.get(runtime.projectRoot) ?? []),
          ask: liveRuleSet.ask,
        },
      }),
    };
  }
}
