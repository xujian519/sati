import { resolve, join as joinPath } from "node:path";
import type { SessionConfigOverrides } from "../always-on/runtime/SessionConfigOverrides.js";
import { type AgentRuntimeConfig } from "../agent/index.js";
import { getSubagentDefinition } from "../agent/sub/builtinSubagentTypes.js";
import {
  TeamApprovalForwarder,
  TeamDb,
  TeamScheduler,
  TeamShare,
  defaultTeamDbPath,
  invalidateTaskAttempt,
  scanStrandedTasks,
  scanTeamMembers,
  toGatewayEvent,
  wakeMember,
  withTeamLock,
  type ScanStrandedTasksResult,
  type ScanTeamMembersResult,
  type TeamEvent,
} from "../agent/team/index.js";
import { HookRuntime } from "../extension/index.js";
import { LifecycleRuntime } from "../lifecycle/index.js";
import {
  InProcessGateway,
  type InProcessGatewayOptions,
  SessionRouter,
  isGatewayMemoryDiagnosticsEnabled,
  logGatewayMemoryDiagnostic,
  type Gateway,
  type GatewayCronController,
  KanbanBoardManager,
} from "../gateway/index.js";
import { SessionPresence } from "../gateway/server/sessionPresence.js";
import { type ModelRuntime } from "../model/index.js";
import { WorkerRegistry, defaultPatentWorkers } from "../patent/index.js";
import { resolvePilotHome } from "../pilot/index.js";
import { createPilotConfigStoreSync, type PilotConfigStore } from "../pilot/config/PilotConfigStore.js";
import type { PilotConfigSnapshot } from "../pilot/config/types.js";
import { cleanupOrphanToolResults } from "../session/index.js";
import { type SatiToolDefinition } from "../tool/index.js";
import { SkillManager, migrateLegacyBundledSkillCopies } from "../extension/skills/index.js";
import { logger, createTelemetryCollector, type TelemetryClient } from "../telemetry/index.js";
import { describeExtensionScope, handleMemberTurnCompleted, resolveBuiltinSkillsRoot } from "./gatewaySupport.js";
import { ExtensionWatchManager, type ExtensionWatchEvent } from "./ExtensionWatchManager.js";
import { ProjectRuntimeRegistry } from "./ProjectRuntimeRegistry.js";
import { buildGatewayRuntimeOptions } from "./gatewayRuntimeOptions.js";

// 兼容再导出：既有测试从本文件导入 buildBrowserUseArgs（tests/gateway/browser-use-args.spec.ts）。
export { buildBrowserUseArgs } from "./browserLaunchArgs.js";

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
  /**
   * 决策溯源旁路（审批审计落盘全局库）：默认关（零开销）；
   * 可经环境变量 `SATI_PROVENANCE=1` 开启（双通道，方案 P6）。
   */
  enableProvenance?: boolean;
  /**
   * P1-5：成员邮箱投递租约宽限（ms）。调度器邮箱未读判定/租约过期复用此值；
   * 默认 MAILBOX_LEASE_MS 60s。生产/测试可调小以加速租约重投。
   */
  mailboxLeaseMs?: number;
  /**
   * P1-5：护航队长在线判定宽限窗（ms）。SessionPresence 直连关闭/面板心跳停更
   * 超过此值判离线（暂停团队认领）；默认 SESSION_PRESENCE_GRACE_MS 60s。
   */
  captainGraceMs?: number;
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
  /** 项目看板管理器（Phase 3）：sati.ts 透传给 startSatiServer / startGatewayServer。 */
  kanbanBoardManager: KanbanBoardManager;
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

export function createLocalGateway(options: CreateLocalGatewayOptions = {}): CreateLocalGatewayResult {
  const baseEnv = options.env ?? process.env;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const pilotHome = options.pilotHome ?? resolvePilotHome(baseEnv);
  const env = options.pilotHome ? { ...baseEnv, SATI_HOME: pilotHome } : baseEnv;
  const builtinSkillsRoot = resolveBuiltinSkillsRoot(options.builtinSkillsRoot, env);
  const legacySkillMigration = migrateLegacyBundledSkillCopies({ pilotHome, builtinSkillsRoot });
  if (legacySkillMigration.migrated.length > 0) {
    logger.info(
      `Activated bundled skills directly; moved ${legacySkillMigration.migrated.length} ` +
        `unchanged legacy ${legacySkillMigration.migrated.length === 1 ? "copy" : "copies"} to ` +
        `${joinPath(pilotHome, "skill-backups", "legacy-bundled-v1")}.`,
    );
  }
  for (const failure of legacySkillMigration.failures) {
    logger.warn(`Could not migrate legacy skill '${failure.slug}': ${failure.message}`);
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
      logger.warn(`Extension watcher failed for ${describeExtensionScope(scope)}:`, error.message);
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
    enableProvenance: options.enableProvenance,
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
      logger.warn("Config change requires process restart:", changedPaths.join(", "));
      return;
    }

    logger.info("Config reloaded, invalidating runtimes:", changedPaths.join(", "));
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
  // M3（I3 闭环）：captain 在线判定——gateway ws 连接活跃追踪（unknown 容错在线，
  // 协议不升版）。sati.ts 透传本实例给 startGatewayServer 后即真实生效。
  // 声明置于 gateway 创建前：panelHeartbeat delegate（M4）闭包引用本实例，
  // 避免块级作用域"先使用后声明"编译错误。
  const sessionPresence = new SessionPresence(options.captainGraceMs);
  // Phase 3：项目看板管理器。单实例缓存所有项目 BoardRuntime 并维护订阅表。
  const kanbanBoardManager = new KanbanBoardManager();
  // 显式标注类型：deps.getGateway 闭包引用 gateway 自身，无标注时 TS 无法推断（TS7022/TS7023）。
  const gateway: InProcessGateway = new InProcessGateway(
    router,
    buildGatewayRuntimeOptions({
      router,
      projectRoot,
      fallbackProjectRoot,
      pilotHome,
      now,
      telemetry,
      kanbanBoardManager,
      skillManager,
      cron: options.cron,
      sessionPresence,
      registry,
      configStore,
      agentMaxContextTokens: defaultRuntime.snapshot.config.agent.maxContextTokens,
      agentMaxOutputTokens: defaultRuntime.snapshot.config.agent.maxOutputTokens,
      memoryDiagnosticsEnabled,
      getGateway: () => gateway,
      getTeamDb: () => teamDb,
      getBoundServer: () => boundServer,
    }),
  );
  // Hand the gateway back to the registry so per-session creation can
  // build a `GatewayElicitationChannel` against this gateway's bus +
  // emit-sink (B1).
  registry.setGateway(gateway);
  // ── 团队子系统（M1）：durable 成员底座 ──
  // teams.db 打开/迁移失败选择 fail-fast：团队数据是写真源（成员注册即落库），
  // 静默降级会掩盖成员缺失；与 knowledge 只读降级（消费侧容错）不同。
  const teamDb = new TeamDb(defaultTeamDbPath(pilotHome, env));
  // TeamEvent 广播收口（质量审阅 I2）：三处 emit 语义同构（scheduler / 工具集 / 本地函数），
  // 收敛为单一闭包——handleMemberTurnCompleted 补发 task_failed 事件（C2 判失败不再静默）。
  const emitTeamEvent = (captainSessionKey: string, event: TeamEvent): boolean => {
    return gateway.emitForSession(captainSessionKey, toGatewayEvent(event));
  };
  // sessionPresence 声明已上移至 gateway 创建前（panelHeartbeat delegate 闭包引用，
  // 见上方 M3 注释）；此处仅沿用实例。
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
        handleMemberTurnCompleted(teamDb, teamScheduler, teamId, memberId, emitTeamEvent);
      }
    };
    return scanTeamMembers({
      db: teamDb,
      gateway,
      projectRoot: fallbackProjectRoot,
      pilotHome,
      // P0-3：挂起审批判定 = 内存 bus 或持久化表（bus 为内存态崩溃即失，冷恢复后该成员
      // 依据持久化表被判"挂起"并冒泡/跳过）。
      hasPendingApprovals: sessionKey =>
        gateway.getApprovalBus().list(sessionKey).length > 0 || teamDb.hasPendingApproval(sessionKey),
      // P0-3：挂起审批成员冒泡 member_stalled_approval 给队长（emitTeamEvent 闭包 597 行）。
      emitTeamEvent,
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
          logger.info(`Team member resume: scanned=${result.scanned}, resumed=${result.resumed}`);
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
  // 阶段 3：专利 worker 注册表——team_create_task 的 workerName 存在性校验 + 调度器分派
  // 时的角色 tier 校验共用同一实例（缺省仅内置 6 个 worker，provision-* 条款 worker 未注册
  // 时不阻塞：workerName 校验与分派校验均 fail-open）。
  const workerRegistry = new WorkerRegistry();
  for (const worker of defaultPatentWorkers()) {
    workerRegistry.register(worker);
  }
  const teamScheduler = new TeamScheduler({
    db: teamDb,
    emit: emitTeamEvent,
    isCaptainOnline: captainSessionKey => sessionPresence.isActive(captainSessionKey),
    workerRegistry,
    // P1-5：邮箱投递租约宽限参数化（默认 60s，调度器邮箱未读判定/租约过期复用）。
    mailboxLeaseMs: options.mailboxLeaseMs,
    // P1-4：成员任务唤醒 turn 0 注入共享黑板摘要（订阅方读 {projectRoot}/.sati/team-workspace/{teamId}/share.jsonl；
    // 空黑板返回 undefined 不注入注记——与 assignmentPrompt 的 sharedContext 空串跳过一致）。
    readSharedBoardSummary: teamId => {
      try {
        const summary = new TeamShare(
          joinPath(fallbackProjectRoot, ".sati", "team-workspace", teamId, "share.jsonl"),
        ).summary();
        return summary.length > 0 ? summary : undefined;
      } catch {
        // 黑板不存在/读失败：容错视作无共享上下文，不阻塞成员唤醒。
        return undefined;
      }
    },
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
            handleMemberTurnCompleted(teamDb, teamScheduler, teamId, m, emitTeamEvent);
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
        // 唤醒成员回合失败 → 返回 false 交由调用方决定重试，不在此吞掉。
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
        logger.info(
          `Reclaimed ${removed} orphaned tool-results director${removed === 1 ? "y" : "ies"}: ${removedIds.join(", ")}`,
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
    emit: emitTeamEvent,
    workerRegistry,
  });
  // P0-1：成员工具作用域解析器注入——成员会话创建时按角色裁剪工具集。resolver 延迟
  // 求值（每次会话创建时经 getSubagentDefinition 取角色定义，角色由 syncRoleDefinitions
  // 在 createSession 前注册），故注入时点无需保证角色已注册；parseMemberSessionKey
  // 命中的 memberId 即 teams.db 成员主键 id，getMember(id) 可反查 roleSlug。
  registry.setMemberToolScopeResolver(memberId => {
    const member = teamDb.getMember(memberId);
    if (!member) return undefined;
    const definition = getSubagentDefinition(member.roleSlug);
    if (!definition) return undefined;
    return {
      allowedTools: definition.allowedTools,
      visibleDomains: definition.visibleDomains,
      hiddenDomains: definition.hiddenDomains,
      omitTools: definition.omitTools,
    };
  });
  // P0-3：注入团队库供输出门禁持久化成员挂起审批（onPending upsert / resolveApproval delete）。
  registry.setTeamDb(teamDb);
  registry.setKanbanBoardManager(kanbanBoardManager);
  // T12 复审 M4：启动扫描完成信号（显式可 await——测试不再用 setTimeout 排干猜测时序）
  // Minor-1 兜底：存储层异常经 catch 记录（console.error 含扫描标识）且不 reject——
  // 信号语义 = 扫描已尝试完成，无论成败；与修复前 void IIFE 的吞错行为等价。
  const startupScanDone = (async () => {
    teamDb.resetMemberStatuses();
    // P0-3：从 teams.db 挂起审批表重建内存审批总线——bus 为进程内存态，崩溃即失；
    // 冷启动恢复后成员挂起审批仍对队长可见（approval_list_pending/UI 卡片），
    // 且 decide 有 pendingIndex 依据（会话未被重建时 delivered:false → 收敛删除）。
    for (const row of teamDb.listPendingApprovals()) {
      gateway.getApprovalBus().register({
        sessionKey: row.sessionKey,
        pendingIndex: row.pendingIndex,
        textPreview: row.textPreview,
        triggerKeyword: row.triggerKeyword,
        sessionId: row.sessionId,
        turnId: row.turnId,
        createdAt: Date.parse(row.createdAt),
      });
    }
    await runMemberScan();
    await runStrandedScan();
  })().catch(error => logger.error("Team startup scan failed:", error));
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
      // M4：路由事件缓冲同步收尾（250ms 定时器已 unref，退出前 flush 防尾部丢失）
      registry.routerEventBus?.flush?.();
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
    kanbanBoardManager,
  };
}

function handleExtensionWatchEvent(
  event: ExtensionWatchEvent,
  registry: ProjectRuntimeRegistry,
  router: SessionRouter | undefined,
): void {
  const changed = event.changedPaths.join(", ");
  if (event.scope.kind === "global") {
    logger.info("Extensions changed, invalidating all runtimes:", changed);
    registry.invalidate();
    router?.markAllDirty("extension_changed");
    return;
  }

  logger.info(`Extensions changed for project ${event.scope.projectRoot}, invalidating runtime:`, changed);
  registry.invalidate(event.scope.projectRoot);
  router?.markProjectDirty(event.scope.projectRoot, "extension_changed");
}
