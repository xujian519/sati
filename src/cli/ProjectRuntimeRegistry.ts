import { resolve } from "node:path";
import { brandEnv, ENV_KEY } from "../env.js";
import { PilotConfigSnapshot } from "../pilot/config/types.js";
import type { SessionConfigOverrides } from "../always-on/runtime/SessionConfigOverrides.js";
import {
  type AgentRuntimeConfig,
  type AgentSession,
  type CreateAgentSessionOptions,
  createAgentSessionWithStorage,
} from "../agent/index.js";
import type { TeamToolsOptions } from "../tool/builtin/team/index.js";
import { type ScopeToolsOptions } from "../agent/sub/scopeTools.js";
import { TeamDb } from "../agent/team/index.js";
import { PluginRuntimeExtensionResolver } from "../context/index.js";
import { resolveKnowledgeCapabilities, resolveKnowledgeDbPaths } from "../knowledge/index.js";
import type { KnowledgeCapabilitiesResult } from "../gateway/protocol/types.js";
import {
  type GatewaySessionContext,
  type GatewaySubmitTurnInput,
  InProcessGateway,
  KanbanBoardManager,
  type ListSessionsInput,
  type ListSessionsResult,
} from "../gateway/index.js";
import {
  createMcpToolDefinitionsFromRuntime,
  loadMcpServerConfig,
  McpRuntime,
  parsePluginMcpServers,
} from "../mcp/index.js";
import { type ModelRuntime } from "../model/index.js";
import { MethodologyRegistry } from "../methodology/index.js";
import { type PermissionRule } from "../permission/index.js";
import {
  createAgentProjectSessionStorage,
  listProjectSessions,
  RESUME_TURN_MESSAGE,
  resumeAgentSession,
  TaskResumeScanner,
} from "../session/index.js";
import { createSessionTitleGenerator } from "../session/title/SessionTitleGenerator.js";
import { type SatiToolDefinition } from "../tool/index.js";
import { RouterEventBus } from "../router/protocol/events.js";
import { logger, type TelemetryClient } from "../telemetry/index.js";
import {
  createProjectRuntimeResolver,
  type ProjectRuntime,
  type ProjectRuntimeResolver,
} from "./projectRuntimeFactory.js";
import { mergeSessionDependencies, syncRoleDefinitions } from "./gatewaySupport.js";
import { registerMcpAuxTools, registerToolsIfAbsent } from "./mcpToolRegistration.js";
import { provisionSessionTools } from "./sessionToolSurface.js";
import { buildAgentSessionConfig } from "./agentSessionConfig.js";
import { buildPatentOutputGate } from "./patentOutputGateFactory.js";
import { buildSessionLifecycle } from "./sessionLifecycle.js";
import { buildSessionDependencies } from "./sessionDependencyAssembly.js";

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

/** M5：任务续算扫描启动延时——避开启动期 transcript 读盘竞争。 */
const TASK_RESUME_SCAN_DELAY_MS = 3_000;

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

  /** 项目运行时装配器（P4a 第九刀，见 ./projectRuntimeFactory.ts）。 */
  private readonly runtimeResolver: ProjectRuntimeResolver;

  constructor(private readonly options: ProjectRuntimeRegistryOptions) {
    this._extraTools = options.extraTools ? [...options.extraTools] : [];
    this._sessionOverrides = options.sessionOverrides;
    this.runtimeResolver = createProjectRuntimeResolver({
      fallbackProjectRoot: options.fallbackProjectRoot,
      pilotHome: options.pilotHome,
      builtinSkillsRoot: options.builtinSkillsRoot,
      env: options.env,
      now: options.now,
      telemetry: options.telemetry,
      modelFactory: options.modelFactory,
      onProjectActivated: options.onProjectActivated,
      runtimes: this.runtimes,
      sessionWriters: this.sessionWriters,
      getExtraTools: () => this._extraTools,
      getTeamTools: () => this._teamTools,
      getKanbanBoardManager: () => this._kanbanBoardManager,
      getGateway: () => this.gateway,
      setRouterEventBus: bus => (this.routerEventBus = bus),
    });
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
    return this.runtimeResolver.resolve(projectKey);
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

    const lifecycle = buildSessionLifecycle({
      sessionKey: context.sessionKey,
      hooks: contributions.hooks,
      // 装配期读一次（原 const gw = this.gateway）：无 gateway 时只装插件 hooks。
      gateway: this.gateway,
      getLiveRuleSet: () => this.getLiveRuleSet(context.sessionKey),
    });
    const extension = new PluginRuntimeExtensionResolver(runtime.pluginRuntime, {
      // B3 upgrade path: surface instructions fetched from live MCP servers
      // (McpRuntime.getInstructions) on top of the static plugin-declared ones.
      runtimeMcpInstructions: () => runtime.mcpRuntime?.getInstructions() ?? [],
    });
    const projectRoot = runtime.projectRoot;

    const { baseDependencies, extendDependencies } = buildSessionDependencies({
      sessionKey: context.sessionKey,
      projectKey: context.projectKey,
      runtime,
      sessionTools,
      lifecycle,
      extension,
      now: this.options.now,
      pilotHome: this.options.pilotHome,
      autoElicitation: this.options.autoElicitation,
      getGateway: () => this.gateway,
    });
    const sessionTitleGenerator = createSessionTitleGenerator({
      modelRuntime: runtime.model,
      agentModel: runtime.snapshot.config.agent.model,
    });
    const outputGate = buildPatentOutputGate({
      sessionKey: context.sessionKey,
      projectRoot,
      env: this.options.env,
      enableProvenance: this.options.enableProvenance,
      now: this.options.now,
      getGateway: () => this.gateway,
      getTeamDb: () => this._teamDb,
      getSessionOverrides: () => this._sessionOverrides,
    });
    this.policyDenyRules.set(runtime.projectRoot, outputGate.policyDenyRules);
    return {
      runtime,
      baseDependencies,
      sessionTitleGenerator,
      extendDependencies,
      patentOutputGate: outputGate.gate,
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
    return buildAgentSessionConfig({
      sessionKey: context.sessionKey,
      modelRoute: context.modelRoute,
      runtime,
      getSessionOverride: () => this._sessionOverrides?.get(context.sessionKey),
      permissionMode: this.options.permissionMode,
      env: this.options.env,
      additionalWorkingDirectories: this.options.additionalWorkingDirectories,
      getLiveRuleSet: () => this.getLiveRuleSet(context.sessionKey),
      getPolicyDenyRules: () => this.policyDenyRules.get(runtime.projectRoot) ?? [],
      methodologyRegistry: this.methodologyRegistry,
    });
  }
}
