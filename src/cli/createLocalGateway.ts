import { appendFileSync, existsSync, mkdirSync as mkdirSyncFs, renameSync } from "node:fs";
import { dirname, resolve, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import type { EdgeClawMemoryService } from "edgeclaw-memory-core";
import { brandEnv, ENV_KEY } from "../env.js";
import { resolveEmbeddingClient, resolveRerankClient } from "../model/embedding/index.js";
import type { PilotConfigDiagnostic } from "../pilot/config/types.js";
import type { SessionConfigOverrides } from "../always-on/runtime/SessionConfigOverrides.js";
import {
  createAgentEventBuffer,
  createAgentSessionWithStorage,
  type AgentRuntimeConfig,
  type AgentRuntimeDependencies,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "../agent/index.js";
import { resolveRoutedModelMaxContextTokens } from "../agent/runtime/modelContextWindow.js";
import type { TeamToolsOptions } from "../tool/builtin/team/index.js";
import {
  TeamApprovalForwarder,
  TeamDb,
  TeamScheduler,
  defaultTeamDbPath,
  attemptsExhausted,
  invalidateTaskAttempt,
  ownedOpenTask,
  scanStrandedTasks,
  scanTeamMembers,
  toGatewayEvent,
  validateAttemptUpdate,
  wakeMember,
  withTeamLock,
  type ScanStrandedTasksResult,
  type ScanTeamMembersResult,
} from "../agent/team/index.js";
import {
  AutoCompactionPolicy,
  CachedMicroCompactionEngine,
  CompactionEngine,
  ContextOverflowRecovery,
  DefaultContextRuntime,
  DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
  InstructionDiscovery,
  MicroCompactionEngine,
  PluginRuntimeExtensionResolver,
  SnipEngine,
  TokenAccountingRuntime,
  TokenBudgetManager,
  ToolResultBudget,
  createEdgeClawMemoryProviderFromConfig,
} from "../context/index.js";
import { FileHistoryStore } from "../session/filesystem/FileHistoryStore.js";
import type { AgentSubagentTranscriptHooks } from "../agent/runtime/AgentRuntimeDependencies.js";
import { createPlanTodoStateManager } from "../agent/runtime/PlanTodoState.js";
import {
  CompositeMemoryResolver,
  KnowledgeRuntimeStats,
  createCaseLawSemanticSource,
  createKnowledgeEmbeddingSearch,
  getOrCreatePersonalNoteIndex,
  buildKnowledgeResolvers,
  logKnowledgeCapabilities,
  resolveKnowledgeCapabilities,
  resolveKnowledgeDbPaths,
} from "../knowledge/index.js";
import { setCaseLawSemanticSource, setPersonalNoteSemanticSource } from "../tool/builtin/patentCaseSearch.js";
import type { KnowledgeDbPaths } from "../knowledge/index.js";
import type { KnowledgeCapabilitiesResult } from "../gateway/protocol/types.js";
import type { MemoryResolver } from "../context/index.js";
import {
  listRegisteredRoleIds,
  registerRoleDefinition,
  unregisterRoleDefinition,
} from "../agent/sub/builtinSubagentTypes.js";
import { roleFromContribution } from "../agent/sub/roleFromSkill.js";
import { HookRuntime, PluginRuntime } from "../extension/index.js";
import { LifecycleRuntime } from "../lifecycle/index.js";
import {
  GatewayElicitationChannel,
  InProcessGateway,
  type InProcessGatewayOptions,
  SessionRouter,
  isGatewayMemoryDiagnosticsEnabled,
  logGatewayMemoryDiagnostic,
  summarizeCanonicalMessages,
  type Gateway,
  type GatewayCronController,
  type GatewayProjectStorageOptions,
  type GatewaySessionContext,
  type GatewaySubmitTurnInput,
  type ListSessionsInput,
  type ListSessionsResult,
} from "../gateway/index.js";
import {
  GATEWAY_PERMISSION_CALLBACK_NAME,
  createGatewayPermissionHook,
} from "../gateway/permission/createGatewayPermissionHook.js";
import { SessionPresence } from "../gateway/server/sessionPresence.js";
import {
  McpRuntime,
  createMcpToolDefinitionsFromRuntime,
  loadMcpServerConfig,
  parsePluginMcpServers,
} from "../mcp/index.js";
import { createModelRuntime, type ModelRuntime } from "../model/index.js";
import { createPolicyKey, normalizeRetryReason } from "../model/streaming/retryState.js";
import { applyReplayEnvHooks } from "../test-support/llm-replay/index.js";
import { resolveModelInfo } from "../model/resolveModelInfo.js";
import { MethodologyRegistry, injectMethodology } from "../methodology/index.js";
import { extractMessageText, PatentOutputGate, type PendingPatentMessage } from "../patent/index.js";
import { loadPatentFullRuleSet, RuleOutputGate, selectGateRules } from "../rule/index.js";
import { createDefaultPermissionContext, type PermissionRule } from "../permission/index.js";
import { loadPilotConfig, resolvePilotHome, type PilotProxyConfig } from "../pilot/index.js";
import { createPilotConfigStoreSync, type PilotConfigStore } from "../pilot/config/PilotConfigStore.js";
import type { PilotAgentModelSelection, PilotConfigSnapshot } from "../pilot/config/types.js";
import {
  DEFAULT_JUDGE_TIMEOUT_MS,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_TRIGGER_TIERS,
  type RouterConfig,
} from "../router/config/schema.js";
import {
  RESUME_TURN_MESSAGE,
  TaskResumeScanner,
  cleanupOrphanToolResults,
  createAgentProjectSessionStorage,
  listProjectSessions,
  resumeAgentSession,
} from "../session/index.js";
import { sanitizeSessionIdForPath } from "../session/storage/ProjectSessionStorage.js";
import { createSessionTitleGenerator } from "../session/title/SessionTitleGenerator.js";
import { readWebSessionMessages, readSubagentWebMessages } from "../web/server/readSessionMessages.js";
import { forkWebSession } from "../web/server/forkSession.js";
import { describeWebProject, listWebProjects } from "../web/server/listProjects.js";
import { BackgroundTaskRuntime, type BackgroundTaskCompletionEvent } from "../task/runtime/BackgroundTaskRuntime.js";
import {
  createBuiltinRegistry,
  createPlanFileManager,
  filterAvailableTools,
  type SatiToolDefinition,
  type ToolRegistry,
} from "../tool/index.js";
import type { SatiElicitationChannel, SatiUnavailableToolDiagnostic } from "../tool/index.js";
import { createRouterRuntime, type RouterRuntime } from "../router/index.js";
import { SessionRouterStore } from "../router/session/SessionRouterStore.js";
import type { RouterEventBus, RouterEvent } from "../router/protocol/events.js";
import { loadBuiltinPlugins } from "../extension/plugins/builtin/loadBuiltinPlugins.js";
import { SkillManager, migrateLegacyBundledSkillCopies } from "../extension/skills/index.js";
import { createTelemetryCollector, type TelemetryClient } from "../telemetry/index.js";
import { registerMcpAuxTools, registerToolsIfAbsent } from "./mcpToolRegistration.js";
import { ExtensionWatchManager, type ExtensionWatchEvent } from "./ExtensionWatchManager.js";
import { registerNestedTeamRoleDefinitions } from "./teamRoleAssembly.js";

export type CreateLocalGatewayOptions = {
  projectRoot?: string;
  pilotHome?: string;
  /** Read-only skills shipped with this Sati build. Auto-discovered when omitted. */
  builtinSkillsRoot?: string;
  env?: Record<string, string | undefined>;
  permissionMode?: AgentRuntimeConfig["permissionMode"];
  /** Tools merged into every per-project ToolRegistry. */
  extraTools?: SatiToolDefinition[];
  /** Per-sessionKey config overrides (cwd / permissionMode). */
  sessionOverrides?: SessionConfigOverrides;
  /** Optional Cron runtime controller exposed through Gateway management methods. */
  cron?: GatewayCronController;
  /**
   * Additional directories the agent is allowed to read/write outside of `projectRoot`.
   * Passed to PermissionContext so `pathSafety` accepts paths within these roots.
   */
  additionalWorkingDirectories?: string[];
  /**
   * @internal Testing hook — replaces the production `createModelRuntime`
   * call when present. Tests can return a fake `ModelRuntime` (e.g. a scripted
   * stream) so the rest of the wiring (Router, Tools, Context, AgentLoop) runs
   * end-to-end against a deterministic transport. NOT part of the public API.
   */
  __testModelFactory?: (snapshot: PilotConfigSnapshot) => ModelRuntime;
  /**
   * Fallback project root used as the agent cwd when no explicit
   * `projectKey` is provided (e.g. IM channels without a bound project).
   * Defaults to `projectRoot` when omitted; server mode should set this
   * to `pilotHome` so IM sessions land in the general workspace instead
   * of the gateway process's cwd.
   */
  fallbackProjectRoot?: string;
  /**
   * When true, `ask_user_question` tool calls are answered automatically
   * (first option selected) instead of waiting for a human. Intended for
   * benchmark / headless runs where no interactive user is present.
   */
  autoElicitation?: boolean;
  telemetry?: TelemetryClient;
};

export type SubsystemUpdate = {
  extraTools: SatiToolDefinition[];
  sessionOverrides?: SessionConfigOverrides;
  cron?: GatewayCronController;
  alwaysOnApply?: InProcessGatewayOptions["alwaysOnApply"];
  alwaysOnRerunPlan?: InProcessGatewayOptions["alwaysOnRerunPlan"];
  discoveryPlanService?: InProcessGatewayOptions["discoveryPlanService"];
};

export type CreateLocalGatewayResult = {
  gateway: Gateway;
  configStore: PilotConfigStore;
  registry: ProjectRuntimeRegistry;
  dispose: () => void;
  bindServer: (server: { broadcastNotification(name: string, payload?: unknown): void }) => void;
  /**
   * Returns true when at least one interactive (non-background) turn is
   * in flight for `projectKey`.  Used by AlwaysOnManager to feed the
   * `agent_busy` gate with real session data.
   */
  isProjectBusy: (projectKey: string) => boolean;
  /**
   * Replace subsystem-owned tools, session overrides, and cron controller.
   * Called by the server command after tearing down and rebuilding
   * AlwaysOnManager / CronManager in response to a config change.
   */
  updateSubsystems: (update: SubsystemUpdate) => void;
  /** 团队子系统句柄（M1）：teams.db + 冷恢复扫描。M2 起扩展调度器/任务池入口。 */
  teamSubsystem: TeamSubsystemHandle;
  /** M3：captain 在线判定句柄（sati.ts 透传给 startGatewayServer 的 ws 连接层）。 */
  sessionPresence: SessionPresence;
};

export type TeamSubsystemHandle = {
  db: TeamDb;
  /** 冷恢复扫描。启动时 fire-and-forget 调用；返回 Promise 供测试 await 接线面。 */
  runMemberScan: () => Promise<ScanTeamMembersResult>;
  /** M2：任务池调度器（事件驱动；M3 起由 team_* 工具驱动）。 */
  scheduler: TeamScheduler;
  /** M2：冷恢复 stranded 任务扫描（启动时与 runMemberScan 串行执行）。 */
  runStrandedScan: () => Promise<ScanStrandedTasksResult>;
  /**
   * 启动期串行扫描（resetMemberStatuses → runMemberScan → runStrandedScan）完成信号。
   * 启动时 fire-and-forget 调用不阻塞 gateway 就绪；测试/宿主可 await 此信号确保
   * 扫描已空跑完再写入数据（T12 复审 M4：取代 setTimeout 排干，与实现细节解耦）。
   */
  startupScanDone: Promise<unknown>;
};

/**
 * M3（复审观察项 3 闭环 + C2 共享化）：成员回合结束的统一收口——
 * C2 检查（attempt 达 maxAttempts 仍无进展 → 置 failed 终止 re-claim 循环）+ onMemberIdle 续派。
 * wake 包装层与 scanner 冷恢复路径共用（两路径行为对齐）。
 * 参数传递 teamScheduler 消除顺序依赖（本函数定义于 runMemberScan/teamScheduler 之前，无闭包捕获）；
 * onMemberIdle 的 rejection 静默吞掉（onEvent 契约：回调不得抛出）。
 * 调用时机：两路径均在 turn 完全 unwinding 之后调用（wake 包装层收集 completed 于 wake 返回后、
 * scanner 收集于 scan 的 .then/.catch）——回合期间不持团队锁（M3 锁范围收窄，避免回合内
 * team_update_task 重入死锁），此刻续派不会命中 session_busy。
 * 锁语义与 fail-closed 安全论证：两条路径均无团队锁（wake 包装层锁外、scanner 直调 wakeMember）——
 * 锁外执行存在 TOCTOU 窗口，置 failed 前靠 validateAttemptUpdate 三拒兜底（终态拒绝 / attemptId
 * 已清拒绝 / attemptId 不匹配拒绝，fail-closed）；漏判场景下个 turn_completed 再检查，最终收敛。
 */
function handleMemberTurnCompleted(
  db: TeamDb,
  teamSchedulerRef: TeamScheduler,
  teamId: string,
  memberId: string,
): void {
  const open = ownedOpenTask(db.listTasks(teamId), memberId);
  if (open !== undefined) {
    const fresh = db.getTask(teamId, open.id);
    if (fresh !== undefined && attemptsExhausted(fresh)) {
      const guard = validateAttemptUpdate(fresh, fresh.attemptId);
      if (guard === undefined) {
        db.updateTask({ ...fresh, status: "failed", updatedAt: new Date().toISOString() });
      }
    }
  }
  void teamSchedulerRef.onMemberIdle(teamId, memberId).catch(() => undefined);
}

export function createLocalGateway(options: CreateLocalGatewayOptions = {}): CreateLocalGatewayResult {
  const baseEnv = options.env ?? process.env;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const pilotHome = options.pilotHome ?? resolvePilotHome(baseEnv);
  const env = options.pilotHome ? { ...baseEnv, SATI_HOME: pilotHome } : baseEnv;
  const builtinSkillsRoot = resolveBuiltinSkillsRoot(options.builtinSkillsRoot, env);
  const legacySkillMigration = migrateLegacyBundledSkillCopies({ pilotHome, builtinSkillsRoot });
  if (legacySkillMigration.migrated.length > 0) {
    console.log(
      `[sati] Activated bundled skills directly; moved ${legacySkillMigration.migrated.length} ` +
        `unchanged legacy ${legacySkillMigration.migrated.length === 1 ? "copy" : "copies"} to ` +
        `${joinPath(pilotHome, "skill-backups", "legacy-bundled-v1")}.`,
    );
  }
  for (const failure of legacySkillMigration.failures) {
    console.warn(`[sati] Could not migrate legacy skill '${failure.slug}': ${failure.message}`);
  }
  const now = () => new Date();
  const telemetry = options.telemetry ?? createTelemetryCollector({ env, pilotHome });
  const ownsTelemetry = !options.telemetry;
  // eslint-disable-next-line prefer-const -- assigned once later; closures above reference the binding before assignment
  let registry!: ProjectRuntimeRegistry;
  // eslint-disable-next-line prefer-const -- assigned once later; closures above reference the binding before assignment
  let router: SessionRouter | undefined;
  const extensionWatchManager = new ExtensionWatchManager({
    pilotHome,
    builtinSkillsRoot,
    onChange: event => {
      handleExtensionWatchEvent(event, registry, router);
    },
    onError: (scope, error) => {
      console.warn(`[sati] Extension watcher failed for ${describeExtensionScope(scope)}:`, error.message);
    },
  });
  const fallbackProjectRoot = options.fallbackProjectRoot ?? projectRoot;
  registry = new ProjectRuntimeRegistry({
    fallbackProjectRoot,
    pilotHome,
    builtinSkillsRoot,
    env,
    permissionMode: options.permissionMode ?? "default",
    now,
    extraTools: options.extraTools,
    sessionOverrides: options.sessionOverrides,
    additionalWorkingDirectories: options.additionalWorkingDirectories,
    modelFactory: options.__testModelFactory,
    autoElicitation: options.autoElicitation,
    telemetry,
    onProjectActivated: activeProjectRoot => extensionWatchManager.watchProject(activeProjectRoot),
  });
  const defaultRuntime = registry.resolve();
  const memoryDiagnosticsEnabled = isGatewayMemoryDiagnosticsEnabled(
    env,
    defaultRuntime.snapshot.config.gateway?.memoryDiagnostics,
  );

  const configStore = createPilotConfigStoreSync({ projectRoot, env });
  const stopConfigWatching = configStore.startWatching();
  const stopExtensionWatching = extensionWatchManager.start();

  let boundServer: { broadcastNotification(name: string, payload?: unknown): void } | undefined;
  const configChangeLifecycle = new LifecycleRuntime(new HookRuntime({}));

  configStore.subscribe(event => {
    const { changeClasses, changedPaths } = event;
    if (changeClasses.length === 0) {
      return;
    }
    if (changeClasses.every(c => c === "restart-required")) {
      console.warn("[sati] Config change requires process restart:", changedPaths.join(", "));
      return;
    }

    console.log("[sati] Config reloaded, invalidating runtimes:", changedPaths.join(", "));
    registry.invalidate();
    if (memoryDiagnosticsEnabled) {
      logGatewayMemoryDiagnostic({
        event: "runtime_invalidated",
        sessionCount: router?.cachedSessionCount(),
        projectKey: projectRoot,
        reason: "config_changed",
      });
    }
    router?.markAllDirty("config_changed");
    configChangeLifecycle
      .dispatch({
        event: "ConfigChange",
        baseInput: { sessionId: "", transcriptPath: "", cwd: projectRoot },
        payload: { changedPaths, changeClasses },
        matchQuery: "ConfigChange",
      })
      .catch(() => {});
    boundServer?.broadcastNotification("config_changed", { changedPaths, changeClasses });
  });

  router = new SessionRouter({
    createSession: ctx => registry.createSession(ctx),
    recreateSession: (ctx, session) => registry.recreateSession(ctx, session),
    listSessions: input => registry.listSessions(input),
    idleSessionTimeoutMs: (defaultRuntime.snapshot.config.gateway?.idleSessionTimeoutMinutes ?? 30) * 60_000,
    idleSweepIntervalMs: Math.max(0, defaultRuntime.snapshot.config.gateway?.idleSweepIntervalSeconds ?? 60) * 1_000,
    now,
    onSessionEvict: sessionKey => registry.evictSessionMcp(sessionKey),
    onSessionIdleEvict: memoryDiagnosticsEnabled
      ? (_sessionKey, snapshot) => {
          logGatewayMemoryDiagnostic({
            event: "session_idle_evicted",
            sessionCount: router?.cachedSessionCount(),
            session: {
              sessionKey: snapshot.sessionKey,
              projectKey: snapshot.context.projectKey,
              messageCount: snapshot.messageCount,
            },
          });
        }
      : undefined,
  });
  const skillManager = new SkillManager({ pilotHome, builtinSkillsRoot });
  const gateway = new InProcessGateway(router, {
    now,
    serverInfo: { mode: "in_process", projectKey: projectRoot },
    telemetry,
    cron: options.cron,
    skillManager,
    setSessionCwd: (sessionKey, cwd) => registry.setSessionCwd(sessionKey, cwd),
    readSessionMessages: input =>
      readWebSessionMessages(input, {
        projectRoot: input.projectKey ? input.projectKey : fallbackProjectRoot,
        pilotHome,
        maxContextTokens: defaultRuntime.snapshot.config.agent.maxContextTokens,
        maxOutputTokens: defaultRuntime.snapshot.config.agent.maxOutputTokens,
        now,
      }),
    readSubagentMessages: input =>
      readSubagentWebMessages(input, {
        projectRoot: input.projectKey ? input.projectKey : fallbackProjectRoot,
        pilotHome,
        now,
      }),
    forkSession: input =>
      forkWebSession(input, {
        projectRoot: input.projectKey ? input.projectKey : fallbackProjectRoot,
        pilotHome,
        now,
      }),
    async recordAgentStatusMessage(input) {
      const storage = createAgentProjectSessionStorage({
        projectRoot: input.projectKey ? input.projectKey : fallbackProjectRoot,
        pilotHome,
        sessionId: input.sessionKey,
        now,
      });
      await storage.transcript.recordAgentStatusMessage(input.sessionKey, input.turnId, input.status);
      return { recorded: true };
    },
    listProjects: () => listWebProjects({ pilotHome }),
    describeProject: input => describeWebProject(input.projectKey, { pilotHome }),
    knowledgeCapabilities: input => Promise.resolve(registry.knowledgeCapabilitiesReport(input?.projectKey)),
    async reloadConfig() {
      let changedPaths: string[] = [];
      const unsubscribe = configStore.subscribe(event => {
        changedPaths = event.changedPaths;
      });
      try {
        await configStore.reload("rpc");
      } finally {
        unsubscribe();
      }
      return { reloaded: true, changedPaths };
    },
    async reloadExtensions(input) {
      const changedPaths = input?.changedPaths ?? [];
      if (input?.projectKey) {
        console.log(
          `[sati] Extensions reload requested for project ${input.projectKey}:`,
          changedPaths.join(", ") || "(manual)",
        );
        registry.invalidate(input.projectKey);
        router?.markProjectDirty(input.projectKey, "extension_changed");
      } else {
        console.log("[sati] Extensions reload requested for all runtimes:", changedPaths.join(", ") || "(manual)");
        registry.invalidate();
        router?.markAllDirty("extension_changed");
      }
      boundServer?.broadcastNotification("config_changed", {
        changedPaths,
        changeClasses: ["extension-changed"],
      });
      return { reloaded: true, changedPaths };
    },
    // Defensive: re-check the on-disk config at the start of every
    // turn so an apiKey/url edit applied between two messages takes
    // effect on the next one, even if the fs watcher missed it.
    // Singleton-deduped inside PilotConfigStore.reload — concurrent
    // turns share a single in-flight read, and unchanged config is a
    // no-op (no invalidation, no session recreation).
    async refreshConfigBeforeTurn() {
      await configStore.reload("turn-start");
    },
    afterTurnCompleted: ({ sessionKey, projectKey, runId }) => {
      if (memoryDiagnosticsEnabled) {
        const snapshot = router?.snapshotSession(sessionKey);
        logGatewayMemoryDiagnostic({
          event: "turn_completed",
          sessionCount: router?.cachedSessionCount(),
          session: {
            sessionKey,
            projectKey,
            runId,
            ...(snapshot ? summarizeCanonicalMessages(snapshot.messages) : {}),
          },
        });
      }
      registry.scheduleMemoryMaintenance(projectKey ?? fallbackProjectRoot);
    },
  });
  // Hand the gateway back to the registry so per-session creation can
  // build a `GatewayElicitationChannel` against this gateway's bus +
  // emit-sink (B1).
  registry.setGateway(gateway);
  // ── 团队子系统（M1）：durable 成员底座 ──
  // teams.db 打开/迁移失败选择 fail-fast：团队数据是写真源（成员注册即落库），
  // 静默降级会掩盖成员缺失；与 knowledge 只读降级（消费侧容错）不同。
  const teamDb = new TeamDb(defaultTeamDbPath(pilotHome, env));
  // M3（I3 闭环）：captain 在线判定——gateway ws 连接活跃追踪（unknown 容错在线，
  // 协议不升版）。sati.ts 透传本实例给 startGatewayServer 后即真实生效。
  const sessionPresence = new SessionPresence();
  // gateway 注入接线（emitForSession/approvalDecide 类型兼容性编译期验证）。
  // handleMemberEvent 由 M2 调度器 wake 包装层 + 冷恢复扫描（下方 runMemberScan 的 onEvent）
  // 双路径消费——调度器路径与 scanner 路径的 approval_pending 均冒泡到队长 watcher。
  const teamForwarder = new TeamApprovalForwarder({
    db: teamDb,
    emitForSession: (sessionKey, event) => gateway.emitForSession(sessionKey, event),
    approvalDecide: input => gateway.approvalDecide(input),
  });
  const runMemberScan = (): Promise<ScanTeamMembersResult> => {
    // 冷恢复回合结束（turn_completed）的成员收口集合（每成员至多一次）。
    const completed: Array<{ teamId: string; memberId: string }> = [];
    const reclaimCompleted = (): void => {
      // 恢复回合已完全收尾（wakeMember 仅在 submitTurn 生成器完全 unwinding——
      // 消费者 finally 内 router.endTurn 已执行、会话槽已释放——之后才返回），
      // 此刻续派与 warm 路径锁内串行等效，不会命中 session_busy。
      for (const { teamId, memberId } of completed) {
        handleMemberTurnCompleted(teamDb, teamScheduler, teamId, memberId);
      }
    };
    return scanTeamMembers({
      db: teamDb,
      gateway,
      projectRoot: fallbackProjectRoot,
      pilotHome,
      hasPendingApprovals: sessionKey => gateway.getApprovalBus().list(sessionKey).length > 0,
      // I1（code review）：冷恢复 turn 的 approval_pending 冒泡到队长 watcher——
      // scanner 直调 wakeMember 现传 onEvent（M1 已知限制在此闭环，计划 1349 行承诺兑现）。
      onEvent: (member, event) => {
        teamForwarder.handleMemberEvent(member, event);
        // M3（复审观察项 3）：冷恢复回合结束 → 与 wake 包装层同款收口（C2 + onMemberIdle 续派）。
        // 只在事件回调内登记、不立即续派：冷恢复路径无团队锁（scanTeamMembers 直调
        // wakeMember，不经 scheduler 的 withTeamLock），回合结束事件在 submitTurn
        // 生成器迭代内同步送达——立即续派会在生成器 unwinding（消费者 finally 内
        // router.endTurn）之前发起下一次 wake，beginTurn 判 busy（session_busy
        // 事件流空转、wake 包装层照常返回 true）→ 任务卡 claimed 永不续派；
        // 延后宏任务同样不可靠（pump 收尾可跨宏任务）。warm 路径同款延后
        //（wake 包装层收集 completed、wake 返回后收口，见下方 teamScheduler 接线）。
        if (event.type === "turn_completed" && member.teamId !== undefined) {
          completed.push({ teamId: member.teamId, memberId: member.id });
        }
      },
    })
      .then(result => {
        if (result.resumed > 0) {
          console.log(`[sati] Team member resume: scanned=${result.scanned}, resumed=${result.resumed}`);
        }
        reclaimCompleted();
        return result;
      })
      .catch(() => {
        reclaimCompleted();
        return { scanned: 0, resumed: 0 };
      });
  };
  // ── 团队调度器接线（M2）：事件驱动调度器 + M1 已知限制闭环 ──
  // wake 包装层：调 wakeMember 并在 onEvent 内捕获 turn_completed → onMemberIdle，
  // 成员回合结束自动触发下一任务派发 + member_idle 广播（M1 冷恢复 turn 审批冒泡
  // 限制已由 runMemberScan 的 onEvent 接线闭环——下方 I1 注释）。
  // onMemberIdle 的异步 rejection 静默吞掉（onEvent 契约：回调不得抛出，也不得以
  // 异步 rejection 影响回合；dispose 后锁队列里残留的踢腿自然失败被吞）。
  // M3 锁范围收窄（原"wake 全程持有团队锁"已废弃）：认领在调度器锁内完成，成员
  // 回合全程不持团队锁——回合内 team_update_task 等团队工具取同一把锁，持锁唤醒
  // 会重入死锁（M3 集成测试暴露）；回合结束收口（C2 + onMemberIdle 续派）延后至
  // wake 返回后，与 scanner 冷恢复路径同款（下方 onEvent 内 completed 收集）。
  // I3（code review）闭环：captain 离线（连接断开超宽限窗）→ 暂停新认领；
  // unknown（纯 in-process/CLI 场景）容错视为在线，不阻塞成员工作。
  // ⚠️ 最终复审 I1（已知边界）：Web 主路径经 ui/server relay 单条共享 ws 连接（sati-bridge 单例），
  // 浏览器关闭不触发 gateway onClose → Web 用户下线判定不生效（fail-open 回到 M2 行为：成员成果
  // 持久化不丢失、C2 有界重试）；CLI/TUI 直连 ws 路径正常。M4 面板接线时以浏览器连接级信号为准。
  const teamScheduler = new TeamScheduler({
    db: teamDb,
    emit: (captainSessionKey, event) => gateway.emitForSession(captainSessionKey, toGatewayEvent(event)),
    isCaptainOnline: captainSessionKey => sessionPresence.isActive(captainSessionKey),
    wake: async (memberId, message) => {
      try {
        // 成员快照一次读取（onEvent 内每事件复用；handleMemberEvent 需要 teamId/sessionKey）。
        // 读在 try 内：wake 永不抛错（db 已关等竞态统一走 catch → false 回滚路径）
        const member = teamDb.getMember(memberId);
        // 回合结束收口延后到 wake 返回后（M3 锁范围收窄：kickMember 已锁外唤醒，团队锁
        // 不再跨回合持有——turn_completed 在 submitTurn 生成器迭代内同步送达，若在事件
        // 回调内立即续派会先于消费者 finally 的 endTurn 命中 session_busy；wake 返回时
        // 生成器已完全 unwinding、endTurn 已执行、会话槽已释放，与 scanner 冷恢复路径同款）。
        const completed: Array<{ teamId: string; memberId: string }> = [];
        const reclaimCompleted = (): void => {
          for (const { teamId, memberId: m } of completed) {
            handleMemberTurnCompleted(teamDb, teamScheduler, teamId, m);
          }
        };
        let ok = false;
        try {
          await wakeMember(teamDb, gateway, memberId, message, {
            onEvent: event => {
              // 审批冒泡（M1 Task 6 接线点）：成员回合的 approval_pending → 队长会话 watcher
              if (member !== undefined) {
                teamForwarder.handleMemberEvent(member, event);
              }
              // M1 已知限制闭环 + M3（复审观察项 3）：回合结束 → C2 检查 + onMemberIdle
              //（下一任务派发 + member_idle 广播）；与 scanner 冷恢复路径共用共享函数收口。
              if (event.type === "turn_completed" && member?.teamId !== undefined) {
                completed.push({ teamId: member.teamId, memberId });
              }
            },
          });
          ok = true;
        } finally {
          // M1（T12 复审）：仅正常路径收口——抛错路径交给外层 kickMember 回滚统一处理
          //（回滚里成员回 idle；此处再续派 onMemberIdle 会踩掉并发重认领写下的 working 状态）
          if (ok) reclaimCompleted();
        }
        return true;
      } catch {
        return false;
      }
    },
  });
  // M2：stranded 任务冷恢复——invalidate 旧 attempt（生成 handoffId 拒绝迟到写）
  // 后交调度器 kickMember：锁内重读成员状态 + ownedOpenTask 优先 → 自动 re-claim。
  const runStrandedScan = (): Promise<ScanStrandedTasksResult> =>
    scanStrandedTasks({
      db: teamDb,
      invalidateAndKick: async (teamId, taskId, memberId) => {
        // C1（code review）：invalidate 进团队锁 + 锁内复查——stranded 判定基于扫描
        // 起点快照，与调度器锁内 claim 存在 TOCTOU（启动扫描 fire-and-forget 与就绪后
        // 调度并发）；成员 working（活跃回合）或任务已被并发转派的不得 invalidate
        // （防同一任务双执行）。kickMember 留在锁外（kickMember 内部自己拿锁，避免重入死锁）。
        await withTeamLock(teamId, async () => {
          const task = teamDb.getTask(teamId, taskId);
          const member = teamDb.getMember(memberId);
          if (task === undefined || member === undefined) return;
          if (task.status !== "claimed" && task.status !== "in_progress") return;
          if (member.status === "working" || teamDb.isRetired(member.sessionKey)) return;
          teamDb.updateTask(invalidateTaskAttempt(task, {}));
        });
        await teamScheduler.kickMember(teamId, memberId);
      },
    });
  // Startup sweep: reclaim .sati/tool-results/ directories whose transcript
  // no longer exists (crash leftovers, deleted sessions). Fire-and-forget —
  // must not block gateway startup.
  void cleanupOrphanToolResults({ projectRoot, pilotHome })
    .then(({ removed, removedIds }) => {
      if (removed > 0) {
        console.log(
          `[sati] Reclaimed ${removed} orphaned tool-results director${removed === 1 ? "y" : "ies"}: ${removedIds.join(", ")}`,
        );
      }
    })
    .catch(() => undefined);
  // 跨进程重启续算（T-C）：启动扫描中断任务并提交续算 turn。fire-and-forget，
  // 不阻塞 gateway 启动；续算 turn 在后台串行驱动。
  registry.runTaskResumeScan();
  // 团队成员冷恢复（M1）+ stranded 任务回收（M2）：串行编排（Task 6 code review 修复）。
  // resetMemberStatuses 先行：进程重启后不存在存活 turn，崩溃残留的 working 必为死状态，
  // 不重置则 working-skip/stranded 判定会让崩溃成员永久失去冷恢复；
  // 先成员扫描（唤醒断点成员续算原 attempt）后 stranded 扫描（invalidate + re-claim），
  // 避免双扫描交错对同一成员双重唤醒（scanTeamMembers 内另有唤醒前状态复查兜底）。
  // fire-and-forget，不阻塞 gateway 启动；无成员时扫描立即空转结束。
  // M3 Task 9：team_* 工具装配——setter 注入（teamDb/teamScheduler 构造晚于首次
  // resolve，注入后 invalidate 清缓存，会话创建重建 runtime 时经 createBuiltinRegistry
  // options.team 注册 9 工具）。emit 与 TeamScheduler 构造（上方）同构：TeamEvent → gateway 广播。
  registry.setTeamTools({
    db: teamDb,
    scheduler: teamScheduler,
    emit: (captainSessionKey, event) => gateway.emitForSession(captainSessionKey, toGatewayEvent(event)),
  });
  // T12 复审 M4：启动扫描完成信号（显式可 await——测试不再用 setTimeout 排干猜测时序）
  // Minor-1 兜底：存储层异常经 catch 记录（console.error 含扫描标识）且不 reject——
  // 信号语义 = 扫描已尝试完成，无论成败；与修复前 void IIFE 的吞错行为等价。
  const startupScanDone = (async () => {
    teamDb.resetMemberStatuses();
    await runMemberScan();
    await runStrandedScan();
  })().catch(error => console.error("[sati] Team startup scan failed:", error));
  return {
    gateway,
    configStore,
    registry,
    dispose: () => {
      // 先关 db 后 registry.invalidate 存在窗口：invalidate 回调可能再触 db 读。
      // dispose 后调度器闭包仍可能被在途回合的事件触发（turn_completed → onMemberIdle
      // → kickMember），但每次迭代以 db 读开头：db.close() 后首读即抛，rejection 由
      // onMemberIdle 的 .catch 与 wake 包装层 catch 收敛，循环在下一迭代自然终止，
      // 至多 drain 一个在途回合。db.close() 幂等守卫已防双关。
      // teamScheduler 无资源需释放（内存锁 + 闭包，锁队列随进程退出自然回收）；
      // 调度器闭包持有 sessionPresence（isCaptainOnline 数据源），已随下方 clear() 释放。
      teamDb.close();
      // M3：闭包持有 sessionPresence（isCaptainOnline 数据源）——dispose 时清空活跃记录
      sessionPresence.clear();
      registry.invalidate();
      router?.shutdown();
      stopConfigWatching();
      stopExtensionWatching();
      if (ownsTelemetry) {
        void telemetry.shutdown();
      }
    },
    bindServer: server => {
      boundServer = server;
    },
    isProjectBusy: (projectKey: string) => router!.hasActiveUserTurn(projectKey),
    updateSubsystems: (update: SubsystemUpdate) => {
      registry.updateSubsystems({
        extraTools: update.extraTools,
        sessionOverrides: update.sessionOverrides,
      });
      gateway.setCronController(update.cron);
      gateway.setAlwaysOnApply(update.alwaysOnApply);
      gateway.setAlwaysOnRerunPlan(update.alwaysOnRerunPlan);
      gateway.setDiscoveryPlanService(update.discoveryPlanService);
    },
    teamSubsystem: { db: teamDb, runMemberScan, scheduler: teamScheduler, runStrandedScan, startupScanDone },
    sessionPresence,
  };
}

function resolveBuiltinSkillsRoot(configuredRoot: string | undefined, env: Record<string, string | undefined>): string {
  const explicit = configuredRoot ?? brandEnv(env, ENV_KEY.BUNDLED_SKILLS_DIR);
  if (explicit) return resolve(explicit);

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    joinPath(moduleDir, "..", "..", "skills"),
    joinPath(moduleDir, "..", "..", "..", "skills"),
    joinPath(process.cwd(), "skills"),
  ];
  return resolve(candidates.find(candidate => existsSync(candidate)) ?? candidates[2]);
}

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

const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 30_000;
const DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS = 90_000;

class ProjectRuntimeRegistry {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private gateway?: InProcessGateway;
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
  private readonly sharedSessionStore = new SessionRouterStore({
    now: () => this.options.now().getTime(),
  });

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
      /* exists */
    }
    const eventsPath = joinPath(routerDir, "events.jsonl");
    try {
      const oldPath = joinPath(pilotHome, "router-events.jsonl");
      if (!existsSync(eventsPath) && existsSync(oldPath)) {
        renameSync(oldPath, eventsPath);
      }
    } catch {
      /* best-effort migration */
    }
    return {
      emit: (event: RouterEvent) => {
        try {
          appendFileSync(eventsPath, JSON.stringify(event) + "\n");
        } catch {
          /* best-effort, never crash the agent loop */
        }
        if (event.type === "sati_router_retry_progress") {
          try {
            this.gateway?.broadcastRetryProgress(event);
          } catch {
            /* best-effort */
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
            /* best-effort, never crash the agent loop */
          }
        }
      },
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
      events: this.buildRouterEventBus(),
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
      console.warn(`[sati] ${diagnostic.path}: ${diagnostic.message}`);
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
      backgroundTasks: { runtime: backgroundTasks },
      searchPatentFigure: { embeddingClient },
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
        logger: { warn: (...args: unknown[]) => console.warn("[sati] knowledge:", ...args) },
      }),
    );

    // 判例语义召回源注入（patent_case_search 工具）：knowledge.db embeddings(case/judgment)
    // + 当前 embedding client。embedding 未配置或 knowledge.db 不可用时保持语义路关闭。
    if (embeddingClient && knowledgePaths.caseDb) {
      try {
        const caseEmbeddings = createKnowledgeEmbeddingSearch({
          dbPath: knowledgePaths.caseDb,
          docTypes: ["case", "judgment"],
          logger: { warn: (...args: unknown[]) => console.warn("[sati] knowledge:", ...args) },
        });
        setCaseLawSemanticSource(createCaseLawSemanticSource(texts => embeddingClient!.embed(texts), caseEmbeddings));
      } catch (error) {
        console.warn("[sati] knowledge: 判例语义召回源注入失败，patent_case_search 语义路关闭:", error);
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
          logger: { warn: (...args: unknown[]) => console.warn("[sati] knowledge:", ...args) },
        });
        if (knowledgePaths.caseDb && knowledgePaths.caseDb !== knowledgePaths.knowledgeDb) {
          console.warn(
            "[sati] knowledge: personal_note 库与判例库分离（SATI_CASE_DB），笔记命中无法回源，工具侧笔记语义路关闭。",
          );
        } else {
          setPersonalNoteSemanticSource(noteIndex);
        }
      } catch (error) {
        console.warn("[sati] knowledge: personal_note 语义召回源注入失败，笔记语义路关闭:", error);
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

          console.warn(
            `[sati] memory maintenance failed for project ${runtime.projectRoot}:`,
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
          console.warn(`[sati] Ignoring invalid MCP config ${diagnostic.path}: ${diagnostic.message}`);
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
        console.warn(
          `[sati] MCP runtime startup partial-failed for project ${runtime.projectRoot}:`,
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
      config: this.createAgentConfig(prepared.runtime, context.sessionKey),
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
    void scanner
      .scan()
      .then(result => {
        if (result.resumed > 0) {
          console.log(
            `[sati] Task resume: scanned=${result.scanned}, resumed=${result.resumed}, ` +
              `skippedPartial=${result.skippedPartial}, skippedApprovals=${result.skippedApprovals}`,
          );
        }
      })
      .catch(() => undefined);
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
      config: this.createAgentConfig(prepared.runtime, context.sessionKey),
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

    // -- per-session MCP runtime (e.g. browser-use) --------------------
    let sessionTools: ToolRegistry = runtime.tools;
    const perSpecs = runtime.perSessionServerSpecs;
    const maxInstances = runtime.snapshot.config.gateway?.maxPerSessionMcpInstances ?? 5;
    if (perSpecs && perSpecs.length > 0 && this.sessionMcpRuntimes.size < maxInstances) {
      this.evictSessionMcp(context.sessionKey);
      const patchedPerSpecs = perSpecs.map(spec => {
        if (spec.transport === "stdio" && spec.id === "browser-use") {
          const outDir = joinPath(
            runtime.projectRoot,
            ".sati",
            "browser_screenshots",
            sanitizeSessionIdForPath(context.sessionKey),
          );
          mkdirSyncFs(outDir, { recursive: true });
          return {
            ...spec,
            cwd: outDir,
            args: buildBrowserUseArgs(spec.args ?? [], outDir, this.options.env, runtime.snapshot.config.proxy),
          };
        }
        return spec;
      });
      const sessionMcp = new McpRuntime(patchedPerSpecs);
      this.sessionMcpRuntimes.set(context.sessionKey, sessionMcp);
      try {
        await sessionMcp.start();
        const defs = await createMcpToolDefinitionsFromRuntime(sessionMcp);
        if (defs.length > 0) {
          sessionTools = runtime.tools.clone();
          for (const def of defs) {
            if (sessionTools.has(def.name)) {
              sessionTools.replace(def);
            } else {
              sessionTools.register(def);
            }
          }
        }
      } catch (error) {
        console.warn(
          `[sati] Per-session MCP startup failed for ${context.sessionKey}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    } else if (perSpecs && perSpecs.length > 0) {
      console.warn(
        `[sati] Per-session MCP limit reached (${maxInstances}). ` +
          `Session ${context.sessionKey} will share the project-level browser instance.`,
      );
    }

    // -- excludeTools filtering (unattended sessions) -------------------
    const override = this._sessionOverrides?.get(context.sessionKey);
    if (override?.excludeTools && override.excludeTools.length > 0) {
      if (sessionTools === runtime.tools) {
        sessionTools = runtime.tools.clone();
      }
      for (const name of override.excludeTools) {
        sessionTools.unregister(name);
      }
    }

    // -- Strip always_on_* tools from non-Always-On sessions -------------
    // These tools require an AlwaysOnRunContext to execute; surfacing them
    // in regular user sessions just pollutes the model's tool list.
    const isAlwaysOnSession = context.sessionKey.startsWith("always-on/");
    if (!isAlwaysOnSession) {
      const alwaysOnNames = this._extraTools.filter(t => t.name.startsWith("always_on_")).map(t => t.name);
      if (alwaysOnNames.length > 0) {
        if (sessionTools === runtime.tools) {
          sessionTools = runtime.tools.clone();
        }
        for (const name of alwaysOnNames) {
          sessionTools.unregister(name);
        }
      }
    }

    const availability = await filterAvailableTools(sessionTools, {
      cwd: runtime.projectRoot,
      env: this.options.env,
    });
    sessionTools = availability.registry;
    runtime.unavailableTools = availability.unavailable;

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
      getModelMaxOutputTokens: (provider, model) => {
        try {
          return runtime.model.getCapabilities(provider, model).maxOutputTokens;
        } catch {
          return undefined;
        }
      },
      getModelTokenLimits: (provider, model) => {
        try {
          const caps = runtime.model.getCapabilities(provider, model);
          return { maxContextTokens: caps.maxContextTokens, maxOutputTokens: caps.maxOutputTokens };
        } catch {
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
      const autoCompactionPolicy = new AutoCompactionPolicy({ tokenBudget });
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
    const resolveApproval = (pending: PendingPatentMessage, verdict: "adopted" | "rejected") => {
      this.gateway?.getApprovalBus().remove(sessionKey, pending.index);
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
      console.warn(`[RuleOutputGate] 专利规则集加载告警: ${fullRuleSet.warnings.join("; ")}`);
    }
    const ruleGate = new RuleOutputGate(selectGateRules(fullRuleSet.ruleSet));
    const patentOutputGate = new PatentOutputGate({
      riskKeywords: [],
      absolutePhrases: [],
      enableCitationGate: false,
      ruleGate,
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
        // 日志仅记录定位信息，不打消息内容（专利结论可能含敏感信息）
        console.warn(
          `[PatentOutputGate] 专利结论待人工审批: session=${pending.sessionId ?? "-"} turn=${pending.turnId ?? "-"} index=${pending.index}`,
        );
      },
      onApproved: pending => {
        resolveApproval(pending, "adopted");
        console.info(
          `[PatentOutputGate] 审批通过: session=${pending.sessionId ?? "-"} turn=${pending.turnId ?? "-"} index=${pending.index}`,
        );
      },
      onRejected: pending => {
        resolveApproval(pending, "rejected");
        console.warn(
          `[PatentOutputGate] 审批拒绝: session=${pending.sessionId ?? "-"} turn=${pending.turnId ?? "-"} index=${pending.index}`,
        );
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

  private createAgentConfig(runtime: ProjectRuntime, sessionKey: string): CreateAgentSessionOptions["config"] {
    const agent = runtime.snapshot.config.agent;
    const override = this._sessionOverrides?.get(sessionKey);
    const permissionMode = override?.permissionMode ?? this.options.permissionMode;
    const cwd = override?.cwd ?? runtime.projectRoot;
    // Hand `PermissionContext` the same live rule-set reference the
    // gateway permission hook owns (see `getLiveRuleSet`). With this
    // shared reference, an "allow + remember" decision pushed by the
    // hook is visible to `PermissionRuntime.decide` on the very next
    // tool call inside the same turn — no roundtrip back to the client
    // needed, even when the client lives in a different process.
    const liveRuleSet = this.getLiveRuleSet(sessionKey);
    // 阶段四 T3：统一能力解析（config → catalog → 协议默认），未知模型按
    // catalog/默认回退，而非盲目 text-only。
    const modelMultimodal: import("../model/index.js").MultimodalConstraints | undefined = resolveModelInfo(
      runtime.model,
      agent.model.provider,
      agent.model.model,
    ).multimodal;
    let maxContextTokens: number | undefined;
    let maxOutputTokens: number | undefined;
    try {
      const caps = runtime.model.getCapabilities(agent.model.provider, agent.model.model);
      maxContextTokens = agent.maxContextTokens ?? caps.maxContextTokens;
      maxOutputTokens = caps.maxOutputTokens;
    } catch {
      maxContextTokens = agent.maxContextTokens;
    }
    maxOutputTokens =
      readPositiveIntegerEnv(brandEnv(this.options.env, ENV_KEY.MAX_OUTPUT_TOKENS)) ??
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
                readPositiveIntegerEnv(brandEnv(this.options.env, ENV_KEY.MAX_OUTPUT_TOKENS)) ??
                subagentMaxOutputTokens,
            }
          : {}),
      };
    }
    return {
      provider: agent.model.provider,
      model: agent.model.model,
      modelMultimodal,
      cwd,
      permissionMode,
      jsonSelfCorrect: true,
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
          deny: liveRuleSet.deny,
          ask: liveRuleSet.ask,
        },
      }),
    };
  }
}

function mergeSessionDependencies(
  base: CreateAgentSessionOptions["dependencies"],
  extension: Partial<
    Pick<
      AgentRuntimeDependencies,
      | "context"
      | "fileHistory"
      | "subagentTranscript"
      | "elicitation"
      | "eventEmitter"
      | "drainEvents"
      | "planFileManager"
      | "planTodoManager"
    >
  >,
): CreateAgentSessionOptions["dependencies"] {
  return {
    ...base,
    ...(extension.context ? { context: extension.context } : {}),
    ...(extension.fileHistory ? { fileHistory: extension.fileHistory } : {}),
    ...(extension.subagentTranscript ? { subagentTranscript: extension.subagentTranscript } : {}),
    ...(extension.elicitation ? { elicitation: extension.elicitation } : {}),
    ...(extension.eventEmitter ? { eventEmitter: extension.eventEmitter } : {}),
    ...(extension.drainEvents ? { drainEvents: extension.drainEvents } : {}),
    ...(extension.planFileManager ? { planFileManager: extension.planFileManager } : {}),
    ...(extension.planTodoManager ? { planTodoManager: extension.planTodoManager } : {}),
  };
}

function handleExtensionWatchEvent(
  event: ExtensionWatchEvent,
  registry: ProjectRuntimeRegistry,
  router: SessionRouter | undefined,
): void {
  const changed = event.changedPaths.join(", ");
  if (event.scope.kind === "global") {
    console.log("[sati] Extensions changed, invalidating all runtimes:", changed);
    registry.invalidate();
    router?.markAllDirty("extension_changed");
    return;
  }

  console.log(`[sati] Extensions changed for project ${event.scope.projectRoot}, invalidating runtime:`, changed);
  registry.invalidate(event.scope.projectRoot);
  router?.markProjectDirty(event.scope.projectRoot, "extension_changed");
}

function describeExtensionScope(scope: ExtensionWatchEvent["scope"]): string {
  return scope.kind === "global" ? "global extensions" : `project extensions (${scope.projectRoot})`;
}

function createAutoElicitationChannel(): SatiElicitationChannel {
  return {
    async askUser(request) {
      const answers: Record<string, string | string[]> = {};
      for (const q of request.questions) {
        if (q.options.length > 0) {
          answers[q.question] = q.multiSelect ? [q.options[0].label] : q.options[0].label;
        } else {
          answers[q.question] = "yes";
        }
      }
      return { type: "answered", answers };
    },
  };
}

function ensureRouterConfig(
  router: RouterConfig | undefined,
  defaultSelection: PilotAgentModelSelection,
): RouterConfig {
  const defaultRef = { id: defaultSelection.id, provider: defaultSelection.provider, model: defaultSelection.model };
  if (router?.enabled === false) {
    return { enabled: false };
  }
  if (router) {
    // Scenarios is optional at the parse boundary (see schema.ts) — the UI
    // can persist a partial `router:` block, e.g. user toggled `enabled`
    // and seeded `tokenSaver.*` without ever opening the Scenarios editor.
    // Fill `scenarios.default` from `agent.model` so RouterRuntime always
    // sees a valid map.
    return {
      enabled: true,
      ...router,
      scenarios: router.scenarios ?? { default: defaultRef },
      fallback: router.fallback ?? { default: [defaultRef] },
      tokenSaver: router.tokenSaver ?? buildDefaultTokenSaver(defaultRef),
      autoOrchestrate: router.autoOrchestrate ?? buildDefaultAutoOrchestrate(),
      stats: { enabled: true, baselineModel: defaultRef, ...(router.stats ?? {}) },
    };
  }
  return {
    enabled: true,
    scenarios: { default: defaultRef },
    fallback: { default: [defaultRef] },
    zeroUsageRetry: { enabled: true, maxAttempts: 2 },
    tokenSaver: buildDefaultTokenSaver(defaultRef),
    autoOrchestrate: buildDefaultAutoOrchestrate(),
    stats: { enabled: true, baselineModel: defaultRef },
  };
}

function buildDefaultTokenSaver(defaultRef: { id: string; provider: string; model: string }) {
  return {
    enabled: true,
    judge: defaultRef,
    defaultTier: "medium",
    judgeTimeoutMs: DEFAULT_JUDGE_TIMEOUT_MS,
    tiers: {
      simple: { model: defaultRef },
      medium: { model: defaultRef },
      complex: { model: defaultRef },
      reasoning: { model: defaultRef },
    },
  };
}

function buildDefaultAutoOrchestrate() {
  return {
    enabled: true,
    triggerTiers: [...DEFAULT_TRIGGER_TIERS],
    slimSystemPrompt: true,
    allowedTools: [...DEFAULT_ALLOWED_TOOLS],
  };
}

function readPositiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

export function buildBrowserUseArgs(
  baseArgs: string[],
  outputDir: string,
  env: Record<string, string | undefined>,
  configProxy?: PilotProxyConfig,
): string[] {
  let args = [...baseArgs];
  args = appendCliArg(args, "--output-dir", outputDir);
  args = appendCliArg(
    args,
    "--timeout-action",
    String(
      readPositiveIntegerEnv(brandEnv(env, ENV_KEY.BROWSER_TIMEOUT_ACTION_MS)) ??
        readPositiveIntegerEnv(brandEnv(env, ENV_KEY.BROWSER_ACTION_TIMEOUT_MS)) ??
        DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
    ),
  );
  args = appendCliArg(
    args,
    "--timeout-navigation",
    String(
      readPositiveIntegerEnv(brandEnv(env, ENV_KEY.BROWSER_TIMEOUT_NAVIGATION_MS)) ??
        readPositiveIntegerEnv(brandEnv(env, ENV_KEY.BROWSER_NAVIGATION_TIMEOUT_MS)) ??
        DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS,
    ),
  );

  const proxy = resolveBrowserProxyServer(env, configProxy);
  if (proxy) {
    args = appendCliArg(args, "--proxy-server", proxy.server);
    const proxyBypass = resolveBrowserProxyBypass(env, configProxy, proxy.source);
    if (proxyBypass) {
      args = appendCliArg(args, "--proxy-bypass", proxyBypass);
    }
  }
  return args;
}

function appendCliArg(args: string[], flag: string, value: string): string[] {
  if (args.includes(flag) || args.some(arg => arg.startsWith(`${flag}=`))) {
    return args;
  }
  return [...args, flag, value];
}

type BrowserProxySource = "browser-env" | "env" | "config";

function resolveBrowserProxyServer(
  env: Record<string, string | undefined>,
  configProxy?: PilotProxyConfig,
): { server: string; source: BrowserProxySource } | undefined {
  const explicit = cleanEnvValue(brandEnv(env, ENV_KEY.BROWSER_PROXY_SERVER));
  if (explicit) {
    if (/^(0|false|off|none|direct)$/i.test(explicit)) return undefined;
    return { server: explicit, source: "browser-env" };
  }
  if (/^(1|true|on|yes)$/i.test(cleanEnvValue(brandEnv(env, ENV_KEY.BROWSER_PROXY_FROM_ENV)) ?? "")) {
    const envProxy =
      cleanEnvValue(brandEnv(env, ENV_KEY.PROXY)) ??
      cleanEnvValue(env.https_proxy) ??
      cleanEnvValue(env.HTTPS_PROXY) ??
      cleanEnvValue(env.http_proxy) ??
      cleanEnvValue(env.HTTP_PROXY);
    if (envProxy) return { server: envProxy, source: "env" };
  }
  const configUrl = cleanEnvValue(configProxy?.url);
  return configUrl ? { server: configUrl, source: "config" } : undefined;
}

function resolveBrowserProxyBypass(
  env: Record<string, string | undefined>,
  configProxy: PilotProxyConfig | undefined,
  proxySource: BrowserProxySource,
): string {
  const explicit = cleanEnvValue(brandEnv(env, ENV_KEY.BROWSER_PROXY_BYPASS));
  if (explicit) return explicit;
  const noProxy = cleanEnvValue(env.no_proxy) ?? cleanEnvValue(env.NO_PROXY);
  const configNoProxy = proxySource === "config" ? cleanEnvValue(configProxy?.noProxy) : undefined;
  return [noProxy, configNoProxy, "localhost", "127.0.0.1"].filter(Boolean).join(",");
}

function cleanEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 把插件贡献中的角色 skill（type: "role"）同步进子代理注册表。
 * 先清除此前注册的角色（防残留，直接遍历注册表键，避免同名角色被
 * 内置预设过滤而漏清理），再注册当前全部角色。
 * 内置 4 个预设（SUBAGENT_DEFINITIONS）不受影响。
 */
function syncRoleDefinitions(pluginRuntime: PluginRuntime, builtinSkillsRoot?: string): void {
  for (const id of listRegisteredRoleIds()) {
    unregisterRoleDefinition(id);
  }
  for (const skill of pluginRuntime.getAllSkills()) {
    const definition = roleFromContribution(skill);
    if (definition !== null) {
      registerRoleDefinition(definition);
    }
  }
  // M3 T15：skills/patent-teams/ 嵌套目录（自身无 SKILL.md，一级扫描跳过），
  // 经同一 roleFromContribution → registerRoleDefinition 路径补注册。
  registerNestedTeamRoleDefinitions(builtinSkillsRoot);
}
