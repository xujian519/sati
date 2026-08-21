import { randomUUID } from "node:crypto";
import type { DiscoveryPlanService } from "../../always-on/web/DiscoveryPlanService.js";
import { type CanonicalMessage } from "../../model/index.js";
import { sanitizeSessionIdForPath } from "../../session/index.js";
import type { SessionRouter } from "../SessionRouter.js";
import { GatewayElicitationBus } from "../elicitation/GatewayElicitationBus.js";
import { GatewayPermissionBus } from "../permission/GatewayPermissionBus.js";
import { GatewayApprovalBus } from "../approval/GatewayApprovalBus.js";
import { AsyncQueue } from "../util/AsyncQueue.js";
import type {
  GatewayCronController,
  Gateway,
  GatewayActiveTurnSnapshot,
  GatewayActiveTurnSnapshotInput,
  GatewayApprovalDecideInput,
  GatewayApprovalDecideResult,
  GatewayApprovalListPendingInput,
  GatewayApprovalListPendingResult,
  GatewayElicitationResponseInput,
  GatewayEvent,
  GatewayPermissionDecisionInput,
  GatewayRecordAgentStatusMessageInput,
  GatewaySessionPermissionGrantInput,
  GatewayServerInfo,
  GatewaySubmitTurnInput,
  ListSessionsInput,
  ListSessionsResult,
  NewSessionInput,
  PrepareWeixinLoginResult,
  AlwaysOnApplyInput,
  AlwaysOnApplyResult,
  AlwaysOnRerunPlanInput,
  AlwaysOnRerunPlanResult,
  AlwaysOnListPlansInput,
  AlwaysOnListPlansResult,
  AlwaysOnReadReportInput,
  AlwaysOnReadReportResult,
  AlwaysOnListCyclesInput,
  AlwaysOnListCyclesResult,
  AlwaysOnArchiveCycleInput,
  AlwaysOnArchiveCycleResult,
  AlwaysOnApplyCycleInput,
  AlwaysOnApplyCycleResult,
  ReloadConfigResult,
  WebDescribeProjectInput,
  WebListProjectsResult,
  WebProjectSummary,
  WebReadSessionMessagesInput,
  WebReadSessionMessagesResult,
  WebReadSubagentMessagesInput,
  WebReadSubagentMessagesResult,
  WebForkSessionInput,
  WebForkSessionResult,
  KnowledgeCapabilitiesInput,
  KnowledgeCapabilitiesResult,
} from "../protocol/types.js";
import { notConfigured } from "../protocol/notConfigured.js";
import type {
  CronCreateInput,
  CronCreateResult,
  CronDeleteInput,
  CronDeleteResult,
  CronListInput,
  CronListResult,
  CronRunNowInput,
  CronRunNowResult,
  CronStopInput,
  CronStopResult,
  CronUpdateInput,
  CronUpdateResult,
} from "../../cron/protocol/types.js";
import { permissionEntryToRule, permissionSettingsToRuleSet, readPermissionSettings } from "../../permission/index.js";
import type { PermissionRule } from "../../permission/index.js";
import { SkillManagerError, type SkillManager } from "../../extension/skills/index.js";
import type {
  SkillAddressInput,
  SkillCreateInput,
  SkillCreateResult,
  SkillDeleteInput,
  SkillDeleteResult,
  SkillImportInput,
  SkillImportResult,
  SkillReadResult,
  SkillScanInput,
  SkillScanResult,
  SkillValidateInput,
  SkillValidationResult,
  SkillWriteInput,
  SkillWriteResult,
  SkillsListInput,
  SkillsListResult,
} from "../../extension/skills/types.js";
import { createVisibleErrorStatusDetail } from "../../status/agentStatus.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import {
  PLAN_COMMAND_USAGE,
  normalizeGatewayModeForLegacyInput,
  normalizeGatewayRunMode,
  normalizePlanCommandInput,
} from "./normalizers.js";
import { cloneGatewayEvent, getGatewayEventRunId, mapAgentEvent } from "./eventMapping.js";
import { buildAgentInputWithAttachments, collectRegisteredAttachmentReadFiles } from "./attachments.js";
import { createGatewayFailureStatus, emitSessionTelemetry, resolveSubmitTurnTelemetry } from "./telemetry.js";

// 门面再导出（定义见 ./normalizers.js + ./eventMapping.js，保持 "./client/InProcessGateway.js" 导出面不变）
export { normalizeGatewayModeForLegacyInput, normalizeGatewayRunMode } from "./normalizers.js";
export { mapAgentEvent } from "./eventMapping.js";

export type InProcessGatewayOptions = {
  uuid?: () => string;
  serverInfo?: Partial<GatewayServerInfo>;
  cron?: GatewayCronController;
  /**
   * Web Phase 2 — pluggable session-history reader. Wired by
   * `createLocalGateway` so the in-process gateway can answer
   * `read_session_messages` without leaking transcript paths.
   */
  readSessionMessages?: (input: WebReadSessionMessagesInput) => Promise<WebReadSessionMessagesResult>;
  readSubagentMessages?: (input: WebReadSubagentMessagesInput) => Promise<WebReadSubagentMessagesResult>;
  forkSession?: (input: WebForkSessionInput) => Promise<WebForkSessionResult>;
  recordAgentStatusMessage?: (input: GatewayRecordAgentStatusMessageInput) => Promise<{ recorded: boolean }>;
  /**
   * Web Phase 3 — pluggable project enumerator + describer.
   */
  listProjects?: () => Promise<WebListProjectsResult>;
  describeProject?: (input: WebDescribeProjectInput) => Promise<WebProjectSummary>;
  /**
   * Pluggable config-reload handler wired by `createLocalGateway`.
   * When set, `reloadConfig()` delegates to this callback which owns
   * the PilotConfigStore + ProjectRuntimeRegistry lifecycle.
   */
  reloadConfig?: () => Promise<ReloadConfigResult>;
  prepareWeixinLogin?: () => Promise<PrepareWeixinLoginResult>;
  /**
   * Pluggable extension/MCP reload handler wired by `createLocalGateway`.
   * Unlike `reloadConfig`, this does not depend on `sati.yaml` changing.
   */
  reloadExtensions?: (
    input?: import("../protocol/types.js").ReloadExtensionsInput,
  ) => Promise<import("../protocol/types.js").ReloadExtensionsResult>;
  /**
   * Optional pre-turn hook that lets the host re-read disk config before
   * `submitTurn` resolves a session and starts streaming. Wired by
   * `createLocalGateway` to `configStore.reload("turn-start")` so that
   * a credential / model edit applied between turns is guaranteed to
   * take effect on the very next message even when fs watchers miss the
   * change (network mounts, debounce gaps, container snapshots).
   *
   * Cheap and singleton-deduped — `PilotConfigStore.reload` is a no-op
   * when the yaml hasn't changed and only re-runs the
   * invalidate-runtimes / mark-sessions-dirty path when something
   * actually moved.
   *
   * Failures are swallowed so a transient yaml read error does not
   * block in-progress chats; the existing snapshot remains in use.
   */
  refreshConfigBeforeTurn?: () => Promise<void>;
  /**
   * Authoritative skill CRUD manager for built-in, user, and project skills.
   * Wired by `createLocalGateway` so every host (CLI, TUI, Web UI bridge,
   * SDK) reads and writes the same skill directory the agent loads from.
   */
  skillManager?: SkillManager;
  dispatchHookForSession?: (sessionKey: string, event: string, payload: Record<string, unknown>) => void;
  /** Override a session's cwd via SessionConfigOverrides. */
  setSessionCwd?: (sessionKey: string, cwd: string) => void;
  /** Delegate for Always-On apply — wired to AlwaysOnManager.applyPlan. */
  alwaysOnApply?: (input: AlwaysOnApplyInput) => Promise<AlwaysOnApplyResult>;
  alwaysOnRerunPlan?: (input: AlwaysOnRerunPlanInput) => Promise<AlwaysOnRerunPlanResult>;
  /**
   * Discovery-plan lifecycle service. Wired by `createLocalGateway` via
   * `createDiscoveryPlanService`; powers the always_on_* discovery
   * protocol methods (list plans / reports / cycles / archive / apply).
   */
  discoveryPlanService?: DiscoveryPlanService;
  /**
   * Knowledge capabilities delegate — wired by `createLocalGateway` from the
   * per-project runtime (knowledge paths + resolver stats); powers the
   * `knowledge_capabilities` protocol method.
   */
  knowledgeCapabilities?: (input: KnowledgeCapabilitiesInput) => Promise<KnowledgeCapabilitiesResult>;
  /**
   * M4：面板心跳 delegate — wired by `createLocalGateway` to
   * `SessionPresence.panelTouch`（浏览器经 ui/server relay 的活跃上报，
   * 维护 Web 在线判定）。powers the `panel_heartbeat` protocol method.
   */
  panelHeartbeat?: (input: { sessionKeys: string[] }) => Promise<{ touched: number }>;
  /** M4：团队面板快照 delegate（TeamDb 直查 + presence 在线态；不触发模型回路）。 */
  teamPanelSnapshot?: (input: { sessionKey?: string }) => Promise<{ teams: unknown[] }>;
  /** M4：面板操作 delegate——直调既有 team_* 工具（权限/事件走工具层既有链）。 */
  teamToolCall?: (input: {
    tool: string;
    input: Record<string, unknown>;
    sessionKey?: string;
  }) => Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  /**
   * Optional non-blocking post-turn callback. Used by createLocalGateway to
   * coalesce project-level memory maintenance after a turn has fully ended.
   */
  afterTurnCompleted?: (input: { sessionKey: string; projectKey?: string; runId: string }) => void;
  telemetry?: TelemetryClient;
};

const ACTIVE_TURN_EVENT_LIMIT = 500;
const ACTIVE_TURN_BYTE_LIMIT = 256 * 1024;

type ActiveTurnReplay = {
  sessionKey: string;
  runId: string;
  events: GatewayEvent[];
  bytes: number;
  truncated: boolean;
};

export class InProcessGateway implements Gateway {
  private readonly uuid: () => string;
  /**
   * B1 — registry of active per-session emit sinks. The gateway shares this
   * map with the per-session `GatewayElicitationChannel` so an `askUser`
   * call can surface an `elicitation_request` event into the active
   * `submitTurn` stream from outside the agent's event iterator.
   */
  private readonly emitSinks = new Map<string, (event: GatewayEvent) => void>();
  private readonly activeTurnReplays = new Map<string, ActiveTurnReplay>();
  /** B1 — pending askUser() promises keyed by sessionKey + requestId. */
  private readonly elicitationBus = new GatewayElicitationBus();
  /**
   * Web Phase 2 — pending permission-decision promises. Tools that need
   * Web confirmation register here while the host UI shows the banner.
   */
  private readonly permissionBus = new GatewayPermissionBus();
  /**
   * 输出门禁 HITL 审批（patent 域）— pending approval entries surfaced by
   * the host's output gate. The Web UI lists/decides via
   * `approvalListPending` / `approvalDecide`.
   */
  private readonly approvalBus = new GatewayApprovalBus();
  private readonly sessionPermissionGrants = new Map<string, PermissionRule[]>();
  /**
   * Per-session "turn ended" deferreds. Set when `submitTurn`'s consumer
   * loop starts and resolved in its `finally` after `router.endTurn` has
   * cleared `inFlightTurns`. `abortTurn` awaits this so callers see a
   * consistent contract: once `abortTurn` resolves, a fresh `submitTurn`
   * for the same session is guaranteed not to be rejected with
   * `session_busy`. Without it the gateway's `abort_turn` RPC could return
   * while `inFlightTurns` was still populated, racing the next submit.
   */
  private readonly turnCompletions = new Map<string, Promise<void>>();
  constructor(
    private readonly router: SessionRouter,
    private readonly options: InProcessGatewayOptions = {},
  ) {
    this.uuid = options.uuid ?? randomUUID;
  }

  /**
   * B1 — exposed so per-session bridge channels can find the bus / emit
   * sink without going through `respondElicitation`. Caller MUST already
   * hold a sessionKey.
   */
  getElicitationBus(): GatewayElicitationBus {
    return this.elicitationBus;
  }

  /**
   * Web Phase 2 — exposed so per-session bridge channels (or tests) can
   * register pending permission decisions and emit `permission_request`
   * events.
   */
  getPermissionBus(): GatewayPermissionBus {
    return this.permissionBus;
  }

  /**
   * 输出门禁 HITL 审批 — exposed so the host (createLocalGateway) can
   * register pending approvals from the output gate's onPending and emit
   * `approval_pending` events; the Web UI consumes via the protocol methods.
   */
  getApprovalBus(): GatewayApprovalBus {
    return this.approvalBus;
  }

  /**
   * Push a synthesized {@link GatewayEvent} into the active `submitTurn`
   * stream for the given session. Returns true when a sink existed and
   * the event was queued, false otherwise (e.g. no turn currently in
   * progress for that session).
   *
   * Used by per-session bridge hooks (notably the interactive
   * permission hook) that need to surface UI prompts mid-turn without
   * waiting for the agent's own event loop to emit them.
   */
  emitForSession(sessionKey: string, event: GatewayEvent): boolean {
    const sink = this.emitSinks.get(sessionKey);
    if (!sink) return false;
    const eventWithRunId = this.withActiveTurnRunId(sessionKey, event);
    this.recordActiveTurnEvent(sessionKey, eventWithRunId);
    sink(eventWithRunId);
    return true;
  }

  broadcastRetryProgress(detail: {
    sessionId: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
    provider: string;
    model: string;
  }): void {
    const event: GatewayEvent = {
      type: "agent_status",
      event: "retry_progress",
      detail: {
        attempt: detail.attempt,
        maxAttempts: detail.maxAttempts,
        delayMs: detail.delayMs,
        reason: detail.reason,
        provider: detail.provider,
        model: detail.model,
      },
    };
    this.emitForSession(detail.sessionId, event);
  }

  async *submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
    const plannedInput = normalizePlanCommandInput(input);
    if (!plannedInput) {
      yield {
        type: "assistant_text_delta",
        text: PLAN_COMMAND_USAGE,
      };
      yield {
        type: "turn_completed",
        usage: {},
        finishReason: "completed",
      };
      return;
    }
    input = plannedInput;

    // Per-turn config refresh (defensive). The fs watcher path already
    // catches most edits, but this guarantees a fresh apiKey/url is in
    // effect for the very next turn even when watcher events are
    // dropped or coalesced.
    if (this.options.refreshConfigBeforeTurn) {
      try {
        await this.options.refreshConfigBeforeTurn();
      } catch {
        // Intentional: keep streaming on the previous snapshot rather
        // than failing a turn over a transient yaml read error.
      }
    }
    const runId = input.runId ?? this.uuid();
    if (!this.router.beginTurn(input.sessionKey, runId)) {
      const message = `Session ${input.sessionKey} already has an active turn.`;
      const userHint = "Wait for the current turn to finish or stop it before sending another message.";
      yield {
        type: "agent_status",
        event: "session_busy",
        detail: createVisibleErrorStatusDetail({
          message,
          code: "session_busy",
          userHint,
          scope: "session",
          source: "gateway",
        }),
      };
      yield {
        type: "error",
        code: "session_busy",
        message,
        recoverable: true,
        userHint,
      };
      return;
    }

    let resolveTurnDone!: () => void;
    const turnDone = new Promise<void>(resolve => {
      resolveTurnDone = resolve;
    });
    this.turnCompletions.set(input.sessionKey, turnDone);

    const queue = new AsyncQueue<GatewayEvent>();
    this.activeTurnReplays.set(input.sessionKey, {
      sessionKey: input.sessionKey,
      runId,
      events: [],
      bytes: 0,
      truncated: false,
    });
    this.emitSinks.set(input.sessionKey, event => queue.enqueue(event));
    const emitGatewayFailureStatus = (status: GatewayRecordAgentStatusMessageInput["status"]): Promise<void> => {
      const recorded = this.recordGatewayStatusMessage({
        sessionKey: input.sessionKey,
        turnId: runId,
        projectKey: input.projectKey,
        status,
      });
      const statusEvent: GatewayEvent = {
        type: "agent_status",
        event: status.event,
        detail: status.detail,
      };
      this.recordActiveTurnEvent(input.sessionKey, statusEvent);
      queue.enqueue(statusEvent);
      return recorded;
    };

    if (input.workspaceCwd && this.options.setSessionCwd) {
      this.options.setSessionCwd(input.sessionKey, input.workspaceCwd);
    }

    const telemetryContext = resolveSubmitTurnTelemetry(input);
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timedOut = false;

    // Background pump: agent events → queue.
    const pump = (async () => {
      try {
        const session = await this.router.getOrCreate({
          sessionKey: input.sessionKey,
          projectKey: input.projectKey,
          channelKey: input.channelKey,
          // 浅拷贝（质量评审 M6）：防调用方复用 input 对象原地突变，污染已缓存会话 context
          ...(input.modelRoute ? { modelRoute: { ...input.modelRoute } } : {}),
        });
        if (input.timeoutMs !== undefined && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            const message = `Turn exceeded the ${input.timeoutMs}ms timeout.`;
            void emitGatewayFailureStatus(
              createGatewayFailureStatus({
                event: "turn_timeout",
                code: "turn_timeout",
                message,
                userHint: "The turn exceeded its wall-clock limit. Retry with a smaller task or increase the timeout.",
                detail: { timeoutMs: input.timeoutMs },
              }),
            );
            const gatewayEvent: GatewayEvent = {
              type: "error",
              runId,
              code: "turn_timeout",
              message,
              recoverable: false,
              userHint: "The turn exceeded its wall-clock limit. Retry with a smaller task or increase the timeout.",
            };
            this.recordActiveTurnEvent(input.sessionKey, gatewayEvent);
            queue.enqueue(gatewayEvent);
            this.elicitationBus.rejectSession(input.sessionKey, "turn_timeout");
            this.permissionBus.rejectSession(input.sessionKey, "turn_timeout");
            queue.close();
            try {
              session.abort(`timeout:${runId}`);
            } catch {
              // The queue is already closed, so a faulty abort implementation
              // cannot defeat the hard turn timeout.
            }
          }, input.timeoutMs);
        }
        const permissionSettings = readPermissionSettings();
        const legacyInput = input as { mode?: unknown; runMode?: unknown; basePermissionMode?: unknown };
        const inputMode = normalizeGatewayModeForLegacyInput(legacyInput.mode);
        const runMode = normalizeGatewayRunMode(legacyInput.runMode) ?? (inputMode === "plan" ? "plan" : "agent");
        const permissionMode = inputMode ?? (permissionSettings.skipPermissions ? "bypassPermissions" : undefined);
        const basePermissionMode = normalizeGatewayModeForLegacyInput(legacyInput.basePermissionMode);
        const allowPlanModeTools = input.allowPlanModeTools ?? inputMode === "plan";
        const persistedRules = permissionSettingsToRuleSet(permissionSettings);
        const sessionAllowRules = this.sessionPermissionGrants.get(input.sessionKey) ?? [];
        this.options.telemetry?.trackFeatureLoopStage({
          module: "session",
          ownerModule: telemetryContext.ownerModule,
          executionKind: telemetryContext.executionKind,
          phase: telemetryContext.phase,
          loopStage: "loop_start",
          outcome: "success",
          sessionId: input.sessionKey,
          metadata: {
            runId,
            channelKey: input.channelKey,
            permissionMode: permissionMode ?? "default",
          },
        });
        // Promote a text-only turn to blocks when the host channel attached
        // files/images. UI uploads come through this path; resolving them here
        // keeps attachment semantics in the gateway for every client.
        const allowedReadFiles = await collectRegisteredAttachmentReadFiles(input.attachments);
        const agentInput = await buildAgentInputWithAttachments(input.message, input.attachments, allowedReadFiles);
        const syntheticMessages: CanonicalMessage[] = (input.syntheticMessages ?? []).map(s => ({
          role: "user" as const,
          content: [{ type: "text" as const, text: s.text }],
          metadata: { synthetic: true, purpose: s.purpose ?? "channel_hint" },
        }));
        for await (const event of session.submit(agentInput, {
          turnId: runId,
          maxTurns: input.maxTurns,
          runMode,
          permissionMode,
          basePermissionMode,
          allowPlanModeTools,
          canPrompt: input.canPrompt,
          allowedReadFiles,
          permissionRules: {
            ...persistedRules,
            allow: [...sessionAllowRules, ...persistedRules.allow],
          },
          appendSystemPrompt: input.appendSystemPrompt,
          ...(syntheticMessages.length > 0 ? { syntheticMessages } : {}),
        })) {
          if (this.turnCompletions.get(input.sessionKey) !== turnDone) {
            break;
          }
          emitSessionTelemetry(this.options.telemetry, event, {
            sessionId: input.sessionKey,
            runId,
            channelKey: input.channelKey,
            permissionMode: permissionMode ?? "default",
            ownerModule: telemetryContext.ownerModule,
            executionKind: telemetryContext.executionKind,
            phase: telemetryContext.phase,
          });
          for (const gatewayEvent of mapAgentEvent(event, runId)) {
            if (gatewayEvent.type === "context_budget") {
              this.recordGatewayStatusMessage({
                sessionKey: input.sessionKey,
                turnId: runId,
                projectKey: input.projectKey,
                status: {
                  event: "context_budget",
                  kind: "status",
                  text: "context_budget",
                  detail: { ...gatewayEvent },
                },
              });
            }
            this.recordActiveTurnEvent(input.sessionKey, gatewayEvent);
            queue.enqueue(gatewayEvent);
          }
        }
      } catch (error) {
        this.options.telemetry?.trackError(error, {
          module: "session",
          ownerModule: telemetryContext.ownerModule,
          executionKind: telemetryContext.executionKind,
          phase: telemetryContext.phase,
          loopStage: "loop_end",
          errorCategory: "loop_error",
          sessionId: input.sessionKey,
          metadata: {
            runId,
            channelKey: input.channelKey,
          },
        });
        if (this.turnCompletions.get(input.sessionKey) === turnDone) {
          const message = error instanceof Error ? error.message : String(error);
          await emitGatewayFailureStatus(
            createGatewayFailureStatus({
              event: "gateway_submit_failed",
              code: "gateway_submit_failed",
              message,
              userHint:
                "Sati failed before the agent turn could finish. Retry this message; if it repeats, check the gateway logs.",
            }),
          );
          const gatewayEvent: GatewayEvent = {
            type: "error",
            runId,
            code: "gateway_submit_failed",
            message,
            recoverable: false,
            userHint:
              "Sati failed before the agent turn could finish. Retry this message; if it repeats, check the gateway logs.",
          };
          this.recordActiveTurnEvent(input.sessionKey, gatewayEvent);
          queue.enqueue(gatewayEvent);
        }
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        queue.close();
      }
    })();

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      // Clean up the emit-sink and any orphaned elicitation / permission
      // entries before returning so a subsequent turn doesn't see stale
      // state.
      this.emitSinks.delete(input.sessionKey);
      this.activeTurnReplays.delete(input.sessionKey);
      this.elicitationBus.rejectSession(input.sessionKey, "turn_ended");
      this.permissionBus.rejectSession(input.sessionKey, "turn_ended");
      this.router.endTurn(input.sessionKey, runId);
      if (timedOut) {
        // The timed-out AgentSession is never safe to reuse. Do not await a
        // misbehaving tool here: the hard timeout must release the Cron run.
        await this.router.close(input.sessionKey);
        void pump.catch(() => undefined);
      } else {
        // Defensive — make sure the pump promise is settled before we resolve.
        await pump.catch(() => undefined);
      }
      // Signal any in-flight `abortTurn` awaiters that the session slot
      // has been released. Drop our deferred only if we still own it —
      // a later turn for the same session may have already installed
      // its own.
      if (this.turnCompletions.get(input.sessionKey) === turnDone) {
        this.turnCompletions.delete(input.sessionKey);
      }
      resolveTurnDone();
      this.options.afterTurnCompleted?.({
        sessionKey: input.sessionKey,
        projectKey: input.projectKey,
        runId,
      });
    }
  }

  async abortTurn(input: { sessionKey: string; runId?: string; reason?: string }): Promise<void> {
    const reason = input.reason ?? (input.runId ? `aborted:${input.runId}` : "aborted");
    await this.router.abort(input.sessionKey, reason);
    // Wait for the in-flight `submitTurn` (if any) to fully unwind so
    // `inFlightTurns` has been cleared by the time the RPC response is
    // sent. Otherwise a fast "stop → re-send" from a client races the
    // gateway's own cleanup and the next submit is rejected with
    // `session_busy`.
    const pending = this.turnCompletions.get(input.sessionKey);
    if (!pending) return;
    await pending;
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    return this.router.list(input);
  }

  async resumeSession(input: { sessionKey: string }): Promise<{ sessionKey: string }> {
    return input;
  }

  async newSession(input: NewSessionInput): Promise<{ sessionKey: string }> {
    const suffix = this.uuid();
    const projectKey = input.projectKey ? `project=${input.projectKey}:` : "";
    const rawKey = `${input.channelKey}:${projectKey}s_${suffix}`;
    // 与磁盘 transcript 文件名保持一致（sanitizeSessionIdForPath 幂等）。
    // 聊天直连（P3）下新会话由本方法创建：若返回含原始路径分隔符的 key
    // （如 `web:project=/Users/xujian/.sati:s_<uuid>`），而会话列表从磁盘
    // 文件名（`/` → `-`）读取 sessionId，同一会话就出现两种编码——UI resume
    // 提交的 key 与 gateway 注册的 key 不一致，getOrCreate 会新建空会话、
    // turn 事件 sid 与 selectedSession.id 失配（complete 帧不复位 isLoading，
    // 追问被 UI 排队/静默丢弃）。旧中转路径（ui/server newSessionKey）正是
    // 为避免该问题而生成无路径分隔符的 key，此处对齐同一约定。
    return { sessionKey: sanitizeSessionIdForPath(rawKey) };
  }

  async closeSession(input: { sessionKey: string; reason?: string }): Promise<void> {
    await this.router.close(input.sessionKey);
    this.sessionPermissionGrants.delete(input.sessionKey);
  }

  async recordAgentStatusMessage(input: GatewayRecordAgentStatusMessageInput): Promise<{ recorded: boolean }> {
    if (!this.options.recordAgentStatusMessage) {
      return { recorded: false };
    }
    return this.options.recordAgentStatusMessage(input);
  }

  private async recordGatewayStatusMessage(input: GatewayRecordAgentStatusMessageInput): Promise<void> {
    if (!this.options.recordAgentStatusMessage) {
      return;
    }
    try {
      await this.options.recordAgentStatusMessage(input);
    } catch (error) {
      // 状态消息落盘失败不影响 turn 主流程，仅记录告警。
      console.warn("[sati] failed to record gateway status message:", error);
    }
  }

  async describeServer(): Promise<GatewayServerInfo> {
    return {
      mode: "in_process",
      sessionCount: this.router.sessionCount(),
      ...this.options.serverInfo,
    };
  }

  async getActiveTurnSnapshot(input: GatewayActiveTurnSnapshotInput): Promise<GatewayActiveTurnSnapshot> {
    const replay = this.activeTurnReplays.get(input.sessionKey);
    if (!replay) {
      return {
        active: false,
        sessionKey: input.sessionKey,
        events: [],
      };
    }
    return {
      active: true,
      sessionKey: replay.sessionKey,
      runId: replay.runId,
      events: replay.events
        .filter(event => this.shouldReplayActiveTurnEvent(input.sessionKey, event))
        .map(event => cloneGatewayEvent(event)),
      ...(replay.truncated ? { truncated: true } : {}),
    };
  }

  async cronCreate(input: CronCreateInput): Promise<CronCreateResult> {
    return this.requireCron().createTask(input);
  }

  async cronUpdate(input: CronUpdateInput): Promise<CronUpdateResult> {
    return this.requireCron().updateTask(input);
  }

  async cronList(input: CronListInput): Promise<CronListResult> {
    return this.requireCron().listTasks(input);
  }

  async cronDelete(input: CronDeleteInput): Promise<CronDeleteResult> {
    return this.requireCron().deleteTask(input);
  }

  async cronStop(input: CronStopInput): Promise<CronStopResult> {
    return this.requireCron().stopTask(input);
  }

  async cronRunNow(input: CronRunNowInput): Promise<CronRunNowResult> {
    return this.requireCron().runTaskNow(input);
  }

  async respondElicitation(input: GatewayElicitationResponseInput): Promise<{ delivered: boolean }> {
    const entry = this.elicitationBus.consume(input.sessionKey, input.requestId);
    if (!entry) return { delivered: false };
    entry.resolve(input.answer);
    this.options.dispatchHookForSession?.(input.sessionKey, "ElicitationResult", {
      requestId: input.requestId,
      delivered: true,
    });
    return { delivered: true };
  }

  async permissionDecide(input: GatewayPermissionDecisionInput): Promise<{ delivered: boolean }> {
    const entry = this.permissionBus.consume(input.sessionKey, input.requestId);
    if (!entry) return { delivered: false };
    entry.resolve({
      requestId: input.requestId,
      decision: input.decision,
      remember: input.remember,
      reason: input.reason,
    });
    return { delivered: true };
  }

  async approvalListPending(input: GatewayApprovalListPendingInput): Promise<GatewayApprovalListPendingResult> {
    return {
      pending: this.approvalBus.list(input.sessionKey).map(({ sessionKey: _sk, ...info }) => info),
    };
  }

  async approvalDecide(input: GatewayApprovalDecideInput): Promise<GatewayApprovalDecideResult> {
    // fail-closed：总线无此挂起条目（已审批/已过期/幽灵会话）直接拒绝。
    if (!this.approvalBus.hasPending(input.sessionKey, input.pendingIndex)) {
      return { delivered: false };
    }
    const session = this.router.get(input.sessionKey);
    if (!session) return { delivered: false };
    const ok =
      input.verdict === "adopted"
        ? session.approvePendingOutput(input.pendingIndex)
        : session.rejectPendingOutput(input.pendingIndex, input.feedback);
    if (!ok) return { delivered: false };
    // 广播 approval_resolved 由宿主 output-gate 回调（onApproved/onRejected）负责；
    // 此处仅兜底从总线移除（宿主未配置回调时保证不残留）。UI 侧在决策返回后乐观移除。
    this.approvalBus.remove(input.sessionKey, input.pendingIndex);
    return { delivered: true };
  }

  async panelHeartbeat(input: { sessionKeys: string[] }): Promise<{
    touched: number;
    error?: { code: string; message: string };
  }> {
    if (!this.options.panelHeartbeat) {
      // 未接线统一兜底形态（S3 评审）：与 GatewayWsConnection 的 notConfigured 出口一致，
      // 可选能力降级为结果而非抛错（feature-detect 语义）。
      return notConfigured({ touched: 0 }, "Panel heartbeat is not configured on this gateway.");
    }
    return this.options.panelHeartbeat(input);
  }

  async teamPanelSnapshot(input: { sessionKey?: string }): Promise<{ teams: unknown[] }> {
    if (!this.options.teamPanelSnapshot) {
      // 未接线统一兜底形态：与 GatewayWsConnection 的 notConfigured 出口一致。
      return notConfigured({ teams: [] }, "Team panel snapshot is not configured on this gateway.");
    }
    return this.options.teamPanelSnapshot(input);
  }

  async teamToolCall(input: {
    tool: string;
    input: Record<string, unknown>;
    sessionKey?: string;
  }): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }> {
    if (!this.options.teamToolCall) {
      // 未接线统一兜底形态：与 GatewayWsConnection 的 notConfigured 出口一致。
      return notConfigured(
        { ok: false, error: { code: "not_configured", message: "Team tool call is not configured on this gateway." } },
        "Team tool call is not configured on this gateway.",
      );
    }
    return this.options.teamToolCall(input);
  }

  async grantSessionPermission(
    input: GatewaySessionPermissionGrantInput,
  ): Promise<{ granted: boolean; entry?: string }> {
    const rule = permissionEntryToRule(input.entry, "allow", "session");
    if (!rule.toolName) {
      return { granted: false };
    }

    const rules = this.sessionPermissionGrants.get(input.sessionKey) ?? [];
    const alreadyGranted = rules.some(
      existing => existing.toolName === rule.toolName && existing.pattern === rule.pattern,
    );
    if (!alreadyGranted) {
      rules.push(rule);
      this.sessionPermissionGrants.set(input.sessionKey, rules);
    }
    return { granted: true, entry: input.entry };
  }

  async readSessionMessages(input: WebReadSessionMessagesInput): Promise<WebReadSessionMessagesResult> {
    if (!this.options.readSessionMessages) {
      throw new Error("read_session_messages is not configured. Wire `readSessionMessages` via createLocalGateway.");
    }
    return this.options.readSessionMessages(input);
  }

  async readSubagentMessages(input: WebReadSubagentMessagesInput): Promise<WebReadSubagentMessagesResult> {
    if (!this.options.readSubagentMessages) {
      throw new Error("read_subagent_messages is not configured. Wire `readSubagentMessages` via createLocalGateway.");
    }
    return this.options.readSubagentMessages(input);
  }

  async forkSession(input: WebForkSessionInput): Promise<WebForkSessionResult> {
    if (!this.options.forkSession) {
      throw new Error("fork_session is not configured. Wire `forkSession` via createLocalGateway.");
    }
    return this.options.forkSession(input);
  }

  async listProjects(): Promise<WebListProjectsResult> {
    if (!this.options.listProjects) {
      throw new Error("list_projects is not configured.");
    }
    return this.options.listProjects();
  }

  async describeProject(input: WebDescribeProjectInput): Promise<WebProjectSummary> {
    if (!this.options.describeProject) {
      throw new Error("describe_project is not configured.");
    }
    return this.options.describeProject(input);
  }

  async reloadConfig(): Promise<ReloadConfigResult> {
    if (!this.options.reloadConfig) {
      return { reloaded: false, reason: "unsupported" };
    }
    return this.options.reloadConfig();
  }

  async prepareWeixinLogin(): Promise<PrepareWeixinLoginResult> {
    if (!this.options.prepareWeixinLogin) {
      return {
        requested: false,
        requestedAt: new Date().toISOString(),
        reason: "unsupported",
      };
    }
    return this.options.prepareWeixinLogin();
  }

  async reloadExtensions(
    input?: import("../protocol/types.js").ReloadExtensionsInput,
  ): Promise<import("../protocol/types.js").ReloadExtensionsResult> {
    if (!this.options.reloadExtensions) {
      return { reloaded: false, reason: "unsupported" };
    }
    return this.options.reloadExtensions(input);
  }

  setCronController(cron: GatewayCronController | undefined): void {
    this.options.cron = cron;
  }

  setAlwaysOnApply(handler: InProcessGatewayOptions["alwaysOnApply"]): void {
    this.options.alwaysOnApply = handler;
  }

  setAlwaysOnRerunPlan(handler: InProcessGatewayOptions["alwaysOnRerunPlan"]): void {
    this.options.alwaysOnRerunPlan = handler;
  }

  setDiscoveryPlanService(service: DiscoveryPlanService | undefined): void {
    this.options.discoveryPlanService = service;
  }

  setPrepareWeixinLogin(handler: InProcessGatewayOptions["prepareWeixinLogin"]): void {
    this.options.prepareWeixinLogin = handler;
  }

  // -------------------------------------------------------------------
  // Skill management — see `SkillManager` for the actual disk ops. The
  // gateway methods just guard "skill manager configured" and translate
  // domain errors into structured failures the WS dispatcher and host
  // bridges can render. `SkillValidationError` is preserved as a special
  // case so the UI can surface the `validation` payload to the user.
  // -------------------------------------------------------------------

  async skillsList(input: SkillsListInput): Promise<SkillsListResult> {
    return this.requireSkills().list(input);
  }

  async skillRead(input: SkillAddressInput): Promise<SkillReadResult> {
    return this.requireSkills().read(input);
  }

  async skillWrite(input: SkillWriteInput): Promise<SkillWriteResult> {
    return this.requireSkills().write(input);
  }

  async skillCreate(input: SkillCreateInput): Promise<SkillCreateResult> {
    return this.requireSkills().create(input);
  }

  async skillDelete(input: SkillDeleteInput): Promise<SkillDeleteResult> {
    return this.requireSkills().delete(input);
  }

  async skillImport(input: SkillImportInput): Promise<SkillImportResult> {
    return this.requireSkills().import(input);
  }

  async skillValidate(input: SkillValidateInput): Promise<SkillValidationResult> {
    return this.requireSkills().validate(input);
  }

  async skillScan(input: SkillScanInput): Promise<SkillScanResult> {
    return this.requireSkills().scan(input);
  }

  private requireSkills(): SkillManager {
    if (!this.options.skillManager) {
      throw new SkillManagerError("not_configured", "Skill manager is not configured on this gateway.");
    }
    return this.options.skillManager;
  }

  async alwaysOnApply(input: AlwaysOnApplyInput): Promise<AlwaysOnApplyResult> {
    if (!this.options.alwaysOnApply) {
      return {
        sessionKey: "",
        error: { code: "not_configured", message: "Always-On apply is not configured on this gateway." },
      };
    }
    return this.options.alwaysOnApply(input);
  }

  async alwaysOnRerunPlan(input: AlwaysOnRerunPlanInput): Promise<AlwaysOnRerunPlanResult> {
    if (!this.options.alwaysOnRerunPlan) {
      return {
        runId: "",
        error: { code: "not_configured", message: "Always-On rerun is not configured on this gateway." },
      };
    }
    return this.options.alwaysOnRerunPlan(input);
  }

  // -------------------------------------------------------------------
  // Discovery-plan protocol methods (backed by `DiscoveryPlanService`)
  // -------------------------------------------------------------------

  async alwaysOnListPlans(input: AlwaysOnListPlansInput): Promise<AlwaysOnListPlansResult> {
    const service = this.options.discoveryPlanService;
    if (!service) {
      return { plans: [], error: { code: "not_configured", message: "Always-On plans list is not configured." } };
    }
    const { plans } = await service.getPlansOverview(input.projectKey);
    return { plans };
  }

  async alwaysOnReadReport(input: AlwaysOnReadReportInput): Promise<AlwaysOnReadReportResult> {
    const service = this.options.discoveryPlanService;
    if (!service) {
      return { content: "", error: { code: "not_configured", message: "Always-On report is not configured." } };
    }
    return service.readReport(input.projectKey, input.planId);
  }

  async alwaysOnListCycles(input: AlwaysOnListCyclesInput): Promise<AlwaysOnListCyclesResult> {
    const service = this.options.discoveryPlanService;
    if (!service) {
      return { cycles: [], error: { code: "not_configured", message: "Always-On cycles list is not configured." } };
    }
    return service.getCyclesOverview(input.projectKey);
  }

  async alwaysOnArchiveCycle(input: AlwaysOnArchiveCycleInput): Promise<AlwaysOnArchiveCycleResult> {
    const service = this.options.discoveryPlanService;
    if (!service) {
      return { archived: false, error: { code: "not_configured", message: "Always-On archive is not configured." } };
    }
    return service.archiveCycle(input.projectKey, input.cycleId);
  }

  /**
   * Queue → apply → finalize a work cycle in one RPC. The apply state
   * machine lives in `DiscoveryPlanService.applyCycle`; this method only
   * delegates the host's apply handler, so missing wiring surfaces as a
   * `not_configured` result instead of a throw.
   */
  async alwaysOnApplyCycle(input: AlwaysOnApplyCycleInput): Promise<AlwaysOnApplyCycleResult> {
    const service = this.options.discoveryPlanService;
    if (!service) {
      return { cycle: null, error: { code: "not_configured", message: "Always-On apply is not configured." } };
    }
    return service.applyCycle(input.projectKey, input.workCycleId, this.options.alwaysOnApply);
  }

  // -------------------------------------------------------------------
  // Knowledge capabilities protocol method (observability exit)
  // -------------------------------------------------------------------

  async knowledgeCapabilities(input: KnowledgeCapabilitiesInput): Promise<KnowledgeCapabilitiesResult> {
    const handler = this.options.knowledgeCapabilities;
    if (!handler) {
      return notConfigured(
        { dataDir: "", capabilities: [], embeddingConfigured: false, rerankConfigured: false },
        "Knowledge capabilities not available on this gateway",
      );
    }
    return handler(input);
  }

  /**
   * True when the given session has a turn in flight. Hosts wire this into
   * their discovery-plan I/O so live plan execution surfaces real status.
   */
  isSessionActive(sessionKey: string): boolean {
    return this.router.hasInFlightTurn(sessionKey);
  }

  private requireCron(): GatewayCronController {
    if (!this.options.cron) {
      throw new Error("Cron runtime is not configured.");
    }
    return this.options.cron;
  }

  private shouldReplayActiveTurnEvent(sessionKey: string, event: GatewayEvent): boolean {
    if (event.type === "permission_request") {
      return this.permissionBus.hasPending(sessionKey, event.requestId);
    }
    if (event.type === "elicitation_request") {
      return this.elicitationBus.hasPending(sessionKey, event.requestId);
    }
    if (event.type === "elicitation_cancelled") {
      return false;
    }
    return true;
  }

  private recordActiveTurnEvent(sessionKey: string, event: GatewayEvent): void {
    const replay = this.activeTurnReplays.get(sessionKey);
    if (!replay) return;
    const copy = cloneGatewayEvent(event);
    const bytes = Buffer.byteLength(JSON.stringify(copy), "utf8");
    replay.events.push(copy);
    replay.bytes += bytes;
    while (replay.events.length > ACTIVE_TURN_EVENT_LIMIT || replay.bytes > ACTIVE_TURN_BYTE_LIMIT) {
      const dropped = replay.events.shift();
      if (!dropped) break;
      replay.bytes -= Buffer.byteLength(JSON.stringify(dropped), "utf8");
      replay.truncated = true;
    }
  }

  private withActiveTurnRunId(sessionKey: string, event: GatewayEvent): GatewayEvent {
    if (getGatewayEventRunId(event)) return event;
    const replay = this.activeTurnReplays.get(sessionKey);
    if (!replay) return event;
    return { ...event, runId: replay.runId };
  }
}
