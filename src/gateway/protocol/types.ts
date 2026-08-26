import type { AgentTurnResult } from "../../agent/index.js";
import type { AgentStatusMessageInput } from "../../session/transcript/TranscriptWriter.js";
import type { AgentRunMode } from "../../agent/protocol/input.js";
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
import type { CanonicalUsage } from "../../model/index.js";
import type { TelemetryExecutionKind, TelemetryModule } from "../../telemetry/index.js";
import type { SessionInfo as ProjectSessionInfo } from "../../session/index.js";
import type { KnowledgeCapability } from "../../knowledge/diagnostics.js";
import type { KnowledgeRuntimeStatsSnapshot } from "../../knowledge/shared/knowledge-stats.js";
import type { SatiElicitationAnswer, SatiElicitationQuestion } from "../../tool/elicitation/SatiElicitationChannel.js";
import type { KanbanUpdatedPayload } from "../../board/protocol/types.js";
import type {
  WebListProjectsResult as WebUiListProjectsResult,
  WebProjectSummary as WebUiProjectSummary,
  WebReadSessionMessagesInput as WebUiReadSessionMessagesInput,
  WebReadSessionMessagesResult as WebUiReadSessionMessagesResult,
  WebReadSubagentMessagesInput as WebUiReadSubagentMessagesInput,
  WebReadSubagentMessagesResult as WebUiReadSubagentMessagesResult,
  WebForkSessionInput as WebUiForkSessionInput,
  WebForkSessionResult as WebUiForkSessionResult,
  WebAlwaysOnListPlansInput as AlwaysOnListPlansInput,
  WebAlwaysOnListPlansResult as AlwaysOnListPlansResult,
  WebAlwaysOnReadReportInput as AlwaysOnReadReportInput,
  WebAlwaysOnReadReportResult as AlwaysOnReadReportResult,
  WebAlwaysOnListCyclesInput as AlwaysOnListCyclesInput,
  WebAlwaysOnListCyclesResult as AlwaysOnListCyclesResult,
  WebAlwaysOnArchiveCycleInput as AlwaysOnArchiveCycleInput,
  WebAlwaysOnArchiveCycleResult as AlwaysOnArchiveCycleResult,
  WebAlwaysOnApplyCycleInput as AlwaysOnApplyCycleInput,
  WebAlwaysOnApplyCycleResult as AlwaysOnApplyCycleResult,
} from "../../web/client/protocol.js";
import type {
  KanbanAddCardInput,
  KanbanAddCardResult,
  KanbanAddColumnInput,
  KanbanAddColumnResult,
  KanbanArchiveCardInput,
  KanbanArchiveCardResult,
  KanbanBulkArchiveCardsInput,
  KanbanBulkArchiveCardsResult,
  KanbanBulkMoveCardsInput,
  KanbanBulkMoveCardsResult,
  KanbanDeleteColumnInput,
  KanbanDeleteColumnResult,
  KanbanDuplicateCardInput,
  KanbanDuplicateCardResult,
  KanbanGetInput,
  KanbanGetResult,
  KanbanMoveCardInput,
  KanbanMoveCardResult,
  KanbanMoveCardToProjectInput,
  KanbanMoveCardToProjectResult,
  KanbanPurgeCardInput,
  KanbanPurgeCardResult,
  KanbanRenameColumnInput,
  KanbanRenameColumnResult,
  KanbanRestoreCardInput,
  KanbanRestoreCardResult,
  KanbanSubscribeInput,
  KanbanSubscribeResult,
  KanbanUndoInput,
  KanbanUndoResult,
  KanbanUnsubscribeInput,
  KanbanUnsubscribeResult,
  KanbanUpdateCardInput,
  KanbanUpdateCardResult,
} from "../kanban/types.js";
import type {
  SkillCreateInput,
  SkillCreateResult,
  SkillDeleteInput,
  SkillDeleteResult,
  SkillImportInput,
  SkillImportResult,
  SkillAddressInput,
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

export type GatewayChannelKey =
  | "cli"
  | "tui"
  | "feishu"
  | "weixin"
  | "qq"
  | "web"
  | "test"
  | "telegram"
  | "discord"
  | "slack"
  | "matrix"
  | "mattermost"
  | "signal"
  | "whatsapp"
  | "bluebubbles"
  | "dingtalk"
  | "wecom"
  | "wecom_callback"
  | "email"
  | "sms"
  | "homeassistant"
  | "api_server"
  | "webhook"
  | (string & {});

export type GatewayMode = "default" | "plan" | "bypassPermissions";

export type ChannelAttachment = {
  type: "file" | "image" | "text" | "unknown";
  name?: string;
  path?: string;
  mimeType?: string;
  content?: string;
  bytes?: number;
  metadata?: Record<string, unknown>;
};

export type GatewayOutboundAttachment = {
  type: "file" | "image" | "text" | "unknown";
  name?: string;
  path?: string;
  mimeType?: string;
  content?: string;
  bytes?: number;
  source: "tool_result" | "media_reference" | "local_path";
  metadata?: Record<string, unknown>;
};

export type TurnUsage = CanonicalUsage;

export type GatewaySubmitTurnInput = {
  sessionKey: string;
  channelKey: GatewayChannelKey;
  message: string;
  projectKey?: string;
  /** Override the agent session's working directory for this session. */
  workspaceCwd?: string;
  attachments?: ChannelAttachment[];
  runMode?: AgentRunMode;
  mode?: GatewayMode;
  /** The user's actual permission preference before plan-mode override. */
  basePermissionMode?: GatewayMode;
  /** Allow model-visible plan mode tools for this turn. Defaults to true only for explicit plan-mode turns. */
  allowPlanModeTools?: boolean;
  /**
   * Whether the submitting host can answer mid-turn user prompts such as
   * permission requests or ask_user_question elicitation. Headless CLI runs
   * set this false so the agent avoids tools that would otherwise hang.
   */
  canPrompt?: boolean;
  runId?: string;
  maxTurns?: number;
  /** Hard wall-clock limit for this turn. The gateway aborts and closes the session when exceeded. */
  timeoutMs?: number;
  /**
   * Team member model route override (M4): applied to the session config at
   * session creation and sticky for cached sessions — the model is baked when
   * the session is created, later turns reuse it.
   */
  modelRoute?: { provider: string; model: string };
  telemetry?: {
    ownerModule?: TelemetryModule;
    executionKind?: TelemetryExecutionKind;
    phase?: string;
  };
  /**
   * Channel-specific synthetic messages appended to the turn input.
   * These are stored in the transcript with `metadata.synthetic: true`
   * so they are visible to the model but hidden from the Web UI.
   */
  syntheticMessages?: Array<{ text: string; purpose?: string }>;
  /**
   * 本回合系统提示追加段（如团队成员角色提示）：透传到 AgentLoop，
   * 追加在组装好的系统提示末尾（不替换默认提示）。
   */
  appendSystemPrompt?: string;
};

export type GatewayRecordAgentStatusMessageInput = {
  sessionKey: string;
  turnId: string;
  projectKey?: string;
  status: AgentStatusMessageInput;
};

type GatewayTurnScopedEventMetadata = {
  /**
   * Stable id of the active turn that produced this event. Turn-scoped events
   * carry it so streaming clients can match deltas with lifecycle boundaries.
   */
  runId?: string;
};

export type GatewayEvent = GatewayTurnScopedEventMetadata &
  (
    | { type: "turn_started"; runId: string }
    | { type: "model_request_started"; model?: string; provider?: string }
    | { type: "assistant_text_delta"; text: string }
    | { type: "assistant_attachment"; attachment: GatewayOutboundAttachment }
    | { type: "file_artifacts"; artifacts: import("../../session/artifacts/FileArtifact.js").FileArtifact[] }
    | { type: "assistant_thinking_delta"; text: string }
    | { type: "tool_call_started"; toolCallId: string; name: string; argsPreview?: string }
    | {
        type: "tool_call_finished";
        toolCallId: string;
        ok: boolean;
        resultPreview?: string;
        resultLineCount?: number;
        resultBytes?: number;
        toolName?: string;
        resultPath?: string;
        /**
         * Inline image results — emitted when the tool returns one or more
         * `SatiToolResultContent { type: "image" }` blocks (e.g. `read_file`
         * on a PNG/JPG, or PDF-page rendering). Hosts render these alongside
         * the tool's row so the user sees the picture next to the call site
         * instead of in a stray user-side bubble. Empty when no images were
         * returned. Base64 payloads should already be size-budgeted by the tool.
         */
        images?: Array<{
          mimeType: string;
          data: string;
          bytes?: number;
          detail?: "auto" | "low" | "high";
        }>;
        /**
         * `SatiToolErrorCode` of the underlying failure when `ok === false`.
         * Hosts use this to render type-specific affordances — e.g. the Web UI
         * only surfaces the "Add to Allowed Tools" suggestion for
         * `permission_denied` / `permission_required`, not for execution
         * failures like a non-zero shell exit code.
         */
        errorCode?: string;
        /** Structured data from the tool result (e.g. planFilePath for exit_plan_mode). */
        data?: Record<string, unknown>;
      }
    | { type: "tool_result_detail_available"; toolCallId: string; resultPath?: string; fullText?: string }
    | { type: "permission_request"; requestId: string; toolName: string; payload: unknown }
    /**
     * 输出门禁挂起（patent 域 HITL）：命中审批词的专利结论已挂起等待人工审批。
     * 消息本体已入库（不丢消息），挂起仅流程控制。宿主应展示审批入口，
     * 最终经 `Gateway.approvalDecide({ verdict })` 完成审批。
     */
    | {
        type: "approval_pending";
        sessionKey: string;
        pendingIndex: number;
        textPreview: string;
        triggerKeyword: string;
        sessionId?: string;
        turnId?: string;
        createdAt: number;
      }
    /**
     * 挂起审批已处理（通过/拒绝）：宿主据此移除审批卡片。
     * 注意：turn 结束后 emit 可能无接收方（事件丢失），宿主应在
     * `approvalDecide` 返回后自行移除卡片（本事件为补充通知）。
     */
    | { type: "approval_resolved"; sessionKey: string; pendingIndex: number; verdict: "adopted" | "rejected" }
    /**
     * 团队编排事件（M2）：TeamEvent 事件族经现有广播通道按队长会话扇出。
     * 协议不升版（复用 agent_event 帧，无新增方法）；Web 端 M4 起消费，未知帧忽略。
     */
    | {
        type: "team_event";
        teamId: string;
        event: import("../../agent/team/protocol/events.js").TeamEvent;
      }
    /**
     * B1 elicitation request: a tool (`ask_user_question`) wants the host
     * channel to render a multiple-choice dialog. The host MUST eventually
     * call `Gateway.respondElicitation({ requestId, answer })` so the
     * waiting tool can resume.
     */
    | {
        type: "elicitation_request";
        requestId: string;
        toolCallId: string;
        toolName: string;
        previewFormat?: "html" | "markdown";
        questions: SatiElicitationQuestion[];
        metadata?: Record<string, unknown>;
      }
    /**
     * Surfaced when the agent loop is aborted while a question is still
     * pending. The host should dismiss the dialog without expecting an
     * answer — `respondElicitation` is no longer required for this id.
     */
    | { type: "elicitation_cancelled"; requestId: string; reason?: string }
    | { type: "structured_output"; payload: unknown }
    | { type: "plan_mode_changed"; mode: GatewayMode | (string & {}) }
    | { type: "config_changed"; changedPaths: string[]; changeClasses: string[] }
    | { type: "worktree_created"; runId: string; cwd: string }
    | { type: "worktree_removed"; cwd: string }
    /**
     * 项目看板变更推送。agent/UI 写入看板后，gateway 向订阅该项目的
     * 客户端风扇分发此事件，payload 结构见 `KanbanUpdatedPayload`。
     */
    | { type: "kanban_updated"; payload: KanbanUpdatedPayload }
    | {
        type: "context_budget";
        used: number;
        displayUsed?: number;
        budgetUsed?: number;
        total: number;
        effectiveTotal?: number;
        reservedOutputTokens?: number;
        ratio: number;
        state: "ok" | "warning" | "blocking";
      }
    | { type: "turn_completed"; usage: TurnUsage; finishReason: AgentTurnResult["stopReason"] | string }
    | { type: "agent_status"; event: string; detail?: Record<string, unknown> }
    | {
        type: "error";
        message: string;
        code?: string;
        recoverable: boolean;
        userHint?: string;
        providerError?: {
          provider?: string;
          protocol?: string;
          status?: number;
          code?: string;
          message?: string;
          raw?: string;
        };
      }
  );

export type GatewayActiveTurnSnapshotInput = {
  sessionKey: string;
};

export type GatewayActiveTurnSnapshot = {
  active: boolean;
  sessionKey: string;
  runId?: string;
  /**
   * Volatile replay events for the currently active turn. Durable transcript
   * history remains the source of truth after the turn completes.
   */
  events: GatewayEvent[];
  truncated?: boolean;
};

export type GatewayElicitationResponseInput = {
  sessionKey: string;
  requestId: string;
  answer: SatiElicitationAnswer;
};

/**
 * Web-facing permission decision input. Mirrors the elicitation
 * round-trip pattern: the agent (via `GatewayPermissionBus`) emits a
 * `permission_request` event during a turn; the host UI eventually calls
 * `Gateway.permissionDecide({ requestId, decision })` to unblock the
 * waiting tool.
 *
 * `delivered: false` is returned when the requestId is unknown (already
 * cancelled, decided, or session ended).
 */
export type GatewayPermissionDecisionInput = {
  sessionKey: string;
  requestId: string;
  decision: "allow" | "deny";
  /** Persist the decision as an `allow_session` rule when true. */
  remember?: boolean;
  /** Optional free-form reason; surfaced in audit/transcript. */
  reason?: string;
};

/**
 * 输出门禁 HITL 审批（patent 域）：挂起消息展示与审批决策的 DTO。
 * pendingIndex 对应 PatentOutputGate 的挂起索引（每会话内唯一）；
 * verdict 与 approval.ts 的 ApprovalVerdict 对齐（adopted / rejected；
 * modified 留给审批 UI 的"编辑后通过"增强，当前不暴露）。
 */
export type GatewayApprovalPendingInfo = {
  pendingIndex: number;
  textPreview: string;
  triggerKeyword: string;
  sessionId?: string;
  turnId?: string;
  createdAt: number;
};

export type GatewayApprovalListPendingInput = {
  /** 缺省列出全部会话的挂起审批。 */
  sessionKey?: string;
};

export type GatewayApprovalListPendingResult = {
  pending: GatewayApprovalPendingInfo[];
};

export type GatewayApprovalDecideInput = {
  sessionKey: string;
  pendingIndex: number;
  verdict: "adopted" | "rejected";
  /** 拒绝时的人工反馈理由（写入审计记录）。 */
  feedback?: string;
};

export type GatewayApprovalDecideResult = {
  /** false = 挂起条目不存在或会话不可用（已审批/已过期/跨会话）。 */
  delivered: boolean;
};

export type GatewaySessionPermissionGrantInput = {
  sessionKey: string;
  entry: string;
};

export type WebReadSessionMessagesInput = WebUiReadSessionMessagesInput;
export type WebReadSessionMessagesResult = WebUiReadSessionMessagesResult;
export type WebReadSubagentMessagesInput = WebUiReadSubagentMessagesInput;
export type WebReadSubagentMessagesResult = WebUiReadSubagentMessagesResult;
export type WebForkSessionInput = WebUiForkSessionInput;
export type WebForkSessionResult = WebUiForkSessionResult;
export type WebProjectSummary = WebUiProjectSummary;
export type WebListProjectsResult = WebUiListProjectsResult;
export type WebDescribeProjectInput = { projectKey: string };

export type GatewayError = {
  code: string;
  message: string;
  recoverable: boolean;
};

export type ListSessionsInput = {
  projectKey?: string;
  limit?: number;
  cursor?: string;
};

export type GatewaySessionInfo = ProjectSessionInfo & {
  sessionKey?: string;
};

export type ListSessionsResult = {
  sessions: GatewaySessionInfo[];
  nextCursor?: string;
};

export type NewSessionInput = {
  projectKey?: string;
  channelKey: GatewayChannelKey;
  hint?: string;
};

export type GatewayServerInfo = {
  mode: "in_process" | "remote";
  protocolVersion?: string;
  projectKey?: string;
  sessionCount?: number;
};

export type GatewayCronController = {
  createTask(input: CronCreateInput): Promise<CronCreateResult>;
  updateTask(input: CronUpdateInput): Promise<CronUpdateResult>;
  listTasks(input: CronListInput): Promise<CronListResult>;
  deleteTask(input: CronDeleteInput): Promise<CronDeleteResult>;
  stopTask(input: CronStopInput): Promise<CronStopResult>;
  runTaskNow(input: CronRunNowInput): Promise<CronRunNowResult>;
};

export type ReloadConfigResult = {
  reloaded: boolean;
  changedPaths?: string[];
  reason?: "unsupported" | "unchanged";
};

export type PrepareWeixinLoginResult = {
  requested: boolean;
  requestedAt: string;
  reason?: "unsupported";
};

export type ReloadExtensionsInput = {
  projectKey?: string;
  changedPaths?: string[];
};

export type ReloadExtensionsResult = {
  reloaded: boolean;
  changedPaths?: string[];
  reason?: "unsupported" | "unchanged";
};

export type AlwaysOnApplyInput = {
  projectKey: string;
  workCycleId: string;
  projectName: string;
};

export type AlwaysOnApplyResult = {
  sessionKey: string;
  error?: { code: string; message: string };
};

export type AlwaysOnRerunPlanInput = {
  projectKey: string;
  planId: string;
  projectName: string;
};

export type AlwaysOnRerunPlanResult = {
  runId: string;
  error?: { code: string; message: string };
};

// ---------------------------------------------------------------------------
// Knowledge capabilities wire shapes (gateway `knowledge_capabilities` 出口，
// 数据源与 diagnostics.resolveKnowledgeCapabilities 同源，避免静默降级盲区）。
//
// 与 Always-On shapes 不同，这些类型**不**定义在浏览器镜像
// `src/web/client/protocol.ts`：浏览器不直接调用该方法（UI 经 REST 代理
// `ui/server/knowledge.js` → sati-bridge 转发），类型仅供 Node 侧消费。
// 直接复用 diagnostics 的 canonical 类型（KnowledgeCapability /
// KnowledgeRuntimeStatsSnapshot），避免 wire 层与诊断层漂移。
// ---------------------------------------------------------------------------

export type KnowledgeCapabilitiesInput = {
  /** 项目根目录（缺省用 gateway 默认项目）。 */
  projectKey?: string;
};

export type KnowledgeCapabilitiesResult = {
  /** 知识库数据根目录（探测结果，供 UI 展示）。 */
  dataDir: string;
  /** 能力清单（含运行时能力项 kg-fts-tokenizer / wiki-semantic-index）。 */
  capabilities: KnowledgeCapability[];
  /** 是否已配置 embedding 客户端。 */
  embeddingConfigured: boolean;
  /** 是否已配置 rerank 客户端。 */
  rerankConfigured: boolean;
  /** 运行时统计快照（缓存/语义/重排计数 + 熔断器状态）。 */
  stats?: KnowledgeRuntimeStatsSnapshot;
  error?: { code: string; message: string };
};

// Always-On discovery-plan wire shapes are defined once in the browser-safe
// `src/web/client/protocol.ts` and re-exported here under the canonical names,
// so the two sides cannot drift. Conventions: `projectKey` is the absolute
// project root; archive uses `cycleId`, apply uses `workCycleId` (wire names).
export type {
  WebAlwaysOnListPlansInput as AlwaysOnListPlansInput,
  WebAlwaysOnListPlansResult as AlwaysOnListPlansResult,
  WebAlwaysOnReadReportInput as AlwaysOnReadReportInput,
  WebAlwaysOnReadReportResult as AlwaysOnReadReportResult,
  WebAlwaysOnListCyclesInput as AlwaysOnListCyclesInput,
  WebAlwaysOnListCyclesResult as AlwaysOnListCyclesResult,
  WebAlwaysOnArchiveCycleInput as AlwaysOnArchiveCycleInput,
  WebAlwaysOnArchiveCycleResult as AlwaysOnArchiveCycleResult,
  WebAlwaysOnApplyCycleInput as AlwaysOnApplyCycleInput,
  WebAlwaysOnApplyCycleResult as AlwaysOnApplyCycleResult,
  WebAlwaysOnWebPlan as AlwaysOnWebPlan,
  WebAlwaysOnCycle as AlwaysOnWebCycle,
} from "../../web/client/protocol.js";

export interface Gateway {
  submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent>;
  abortTurn(input: { sessionKey: string; runId?: string; reason?: string }): Promise<void>;
  listSessions(input: ListSessionsInput): Promise<ListSessionsResult>;
  resumeSession(input: { sessionKey: string }): Promise<{ sessionKey: string }>;
  newSession(input: NewSessionInput): Promise<{ sessionKey: string }>;
  closeSession(input: { sessionKey: string; reason?: string }): Promise<void>;
  recordAgentStatusMessage?(input: GatewayRecordAgentStatusMessageInput): Promise<{ recorded: boolean }>;
  describeServer(): Promise<GatewayServerInfo>;
  getActiveTurnSnapshot?(input: GatewayActiveTurnSnapshotInput): Promise<GatewayActiveTurnSnapshot>;
  cronCreate(input: CronCreateInput): Promise<CronCreateResult>;
  cronUpdate(input: CronUpdateInput): Promise<CronUpdateResult>;
  cronList(input: CronListInput): Promise<CronListResult>;
  cronDelete(input: CronDeleteInput): Promise<CronDeleteResult>;
  cronStop(input: CronStopInput): Promise<CronStopResult>;
  cronRunNow(input: CronRunNowInput): Promise<CronRunNowResult>;
  /**
   * B1 — host responds to an `elicitation_request` event surfaced through
   * `submitTurn`. Resolves the waiting tool's `askUser()` promise. Returns
   * `{ delivered: false }` if the requestId is unknown (already cancelled
   * or the session has ended).
   */
  respondElicitation(input: GatewayElicitationResponseInput): Promise<{ delivered: boolean }>;
  /**
   * Web Phase 2 — host responds to a `permission_request` event surfaced
   * through `submitTurn`. Resolves the agent-side permission promise so the
   * blocked tool either runs (allow) or returns a denial. Returns
   * `{ delivered: false }` if the requestId is unknown.
   */
  permissionDecide(input: GatewayPermissionDecisionInput): Promise<{ delivered: boolean }>;
  /**
   * 输出门禁 HITL 审批（patent 域）：列出挂起审批（供审批 UI 恢复/轮询）。
   * Optional — 旧实现无此能力时 hosts 应 feature-detect。
   */
  approvalListPending?(input: GatewayApprovalListPendingInput): Promise<GatewayApprovalListPendingResult>;
  /**
   * 输出门禁 HITL 审批：通过/拒绝一条挂起审批。通过 = 完成流程控制并触发
   * 宿主 onApproved（消息已在挂起时入库）；拒绝 = 移除挂起并触发 onRejected。
   * 返回 `{ delivered: false }` 当挂起条目不存在（已处理/已过期/跨会话）。
   * Optional — 同 approvalListPending。
   */
  approvalDecide?(input: GatewayApprovalDecideInput): Promise<GatewayApprovalDecideResult>;
  /**
   * Grants a tool only for the current session. This is intentionally
   * non-persistent: global Settings / permissions.json stay unchanged.
   */
  grantSessionPermission(input: GatewaySessionPermissionGrantInput): Promise<{ granted: boolean; entry?: string }>;
  /**
   * Web Phase 2 — read transcript history for a session and project it onto
   * the Web `WebMessage` DTO.
   */
  readSessionMessages(input: WebReadSessionMessagesInput): Promise<WebReadSessionMessagesResult>;
  /**
   * Fork a session transcript at a prior user turn into a new session file.
   */
  forkSession(input: WebForkSessionInput): Promise<WebForkSessionResult>;
  /**
   * Read a subagent's sidechain transcript and return its messages in WebMessage format.
   */
  readSubagentMessages(input: WebReadSubagentMessagesInput): Promise<WebReadSubagentMessagesResult>;
  /**
   * Web Phase 3 — enumerate projects from Sati home + an optional
   * registry.
   */
  listProjects(): Promise<WebListProjectsResult>;
  /**
   * Web Phase 3 — load a single project summary.
   */
  describeProject(input: WebDescribeProjectInput): Promise<WebProjectSummary>;
  /**
   * Trigger a config reload from `~/.sati/sati.yaml` and
   * invalidate cached runtimes. Returns the list of changed config paths
   * so callers can decide whether further action is needed.
   *
   * Optional — implementations that don't own a config store (e.g. the
   * fallback gateway or `RemoteGateway` backed by a server without the
   * capability) may leave it undefined.
   */
  reloadConfig?(): Promise<ReloadConfigResult>;

  /**
   * Ask the gateway host to start or restart the Weixin channel so it can
   * generate a runtime QR code. The host owns channel construction; UI/server
   * callers must not invoke `weixin-ilink.loginWithQR()` directly.
   */
  prepareWeixinLogin?(): Promise<PrepareWeixinLoginResult>;

  /**
   * Trigger a plugin/skill/MCP extension reload without waiting for the file
   * watcher. Used by UI config writers that already know an extension-backed
   * file changed (for example `mcp.json`).
   */
  reloadExtensions?(input?: ReloadExtensionsInput): Promise<ReloadExtensionsResult>;

  /**
   * Skill-management RPCs. The gateway is the authoritative owner of
   * bundled read-only skills, `~/.sati/skills/` (user scope), and
   * `<project>/.sati/skills/` (project scope). The Web UI's REST endpoints under `/api/skills/*`
   * are now thin shims that forward here, so a skill the agent loads
   * and a skill the UI shows always come from the same place.
   *
   * Optional — a `RemoteGateway` backed by an older server without
   * these methods leaves them undefined; hosts should feature-detect.
   */
  /**
   * Trigger an Always-On apply phase: merge workspace changes into the
   * project root via a `bypassPermissions` agent loop inside
   * `DiscoveryFire.drainTurn`. Progress events are broadcast as
   * `always-on:turn-event` notifications.
   */
  alwaysOnApply?(input: AlwaysOnApplyInput): Promise<AlwaysOnApplyResult>;
  /**
   * Re-execute an existing Always-On plan through DiscoveryFire phases 2-4
   * (workspace, execution, report). Used by the UI retry button.
   */
  alwaysOnRerunPlan?(input: AlwaysOnRerunPlanInput): Promise<AlwaysOnRerunPlanResult>;

  skillsList?(input: SkillsListInput): Promise<SkillsListResult>;
  skillRead?(input: SkillAddressInput): Promise<SkillReadResult>;
  skillWrite?(input: SkillWriteInput): Promise<SkillWriteResult>;
  skillCreate?(input: SkillCreateInput): Promise<SkillCreateResult>;
  skillDelete?(input: SkillDeleteInput): Promise<SkillDeleteResult>;
  skillImport?(input: SkillImportInput): Promise<SkillImportResult>;
  skillValidate?(input: SkillValidateInput): Promise<SkillValidationResult>;
  skillScan?(input: SkillScanInput): Promise<SkillScanResult>;

  /** List Always-On discovery plans for a project (Web UI dashboard). */
  alwaysOnListPlans?(input: AlwaysOnListPlansInput): Promise<AlwaysOnListPlansResult>;
  /** Read a discovery plan's report markdown. */
  alwaysOnReadReport?(input: AlwaysOnReadReportInput): Promise<AlwaysOnReadReportResult>;
  /** List work cycles for a project. */
  alwaysOnListCycles?(input: AlwaysOnListCyclesInput): Promise<AlwaysOnListCyclesResult>;
  /** Archive a work cycle and its associated plans. */
  alwaysOnArchiveCycle?(input: AlwaysOnArchiveCycleInput): Promise<AlwaysOnArchiveCycleResult>;
  /** Queue → apply → finalize a work cycle in one RPC (composition of apply). */
  alwaysOnApplyCycle?(input: AlwaysOnApplyCycleInput): Promise<AlwaysOnApplyCycleResult>;

  /**
   * 知识库能力自检（可观测性出口）：返回能力清单 + 运行时统计（熔断器/
   * 缓存/语义失败计数），把静默降级（FTS5 缺失回退 LIKE 等）暴露给 UI/自动化。
   *
   * Optional — 不拥有知识库装配的 gateway 实现可缺省；host 应做 feature-detect。
   */
  knowledgeCapabilities?(input: KnowledgeCapabilitiesInput): Promise<KnowledgeCapabilitiesResult>;

  /**
   * M4：面板心跳上报（ui/server relay 汇总活跃浏览器会话 key；gateway 侧
   * panelTouch 维护 Web 在线判定——浏览器关闭不触发 gateway onClose，以心跳
   * 停更 + 宽限窗判离线）。返回本次实际 touch 的会话数。
   * Optional — 旧实现无此能力时 hosts 应 feature-detect；未接线时返回
   * `error.code = "not_configured"` 兜底结果（S3 评审统一形态）。
   */
  panelHeartbeat?(input: { sessionKeys: string[] }): Promise<{
    touched: number;
    error?: { code: string; message: string };
  }>;

  /** M4：团队面板快照（TeamDb 直查 + presence 在线态；不触发模型回路）。 */
  teamPanelSnapshot?(input: { sessionKey?: string }): Promise<{ teams: unknown[] }>;
  /** M4：面板操作——直调既有 team_* 工具（权限 requireTeamCaptain/requireTeamMember + TeamEvent 广播走工具层）。 */
  teamToolCall?(input: { tool: string; input: Record<string, unknown>; sessionKey?: string }): Promise<{
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  }>;

  /**
   * 项目看板（Kanban）方法族。全部为可选新增；旧 gateway/客户端经
   * `describe_server` / `not_configured` feature-detect，不假设实现存在。
   */
  kanbanGet?(input: KanbanGetInput): Promise<KanbanGetResult>;
  kanbanAddCard?(input: KanbanAddCardInput): Promise<KanbanAddCardResult>;
  kanbanUpdateCard?(input: KanbanUpdateCardInput): Promise<KanbanUpdateCardResult>;
  kanbanMoveCard?(input: KanbanMoveCardInput): Promise<KanbanMoveCardResult>;
  kanbanArchiveCard?(input: KanbanArchiveCardInput): Promise<KanbanArchiveCardResult>;
  kanbanRestoreCard?(input: KanbanRestoreCardInput): Promise<KanbanRestoreCardResult>;
  kanbanPurgeCard?(input: KanbanPurgeCardInput): Promise<KanbanPurgeCardResult>;
  kanbanBulkArchiveCards?(input: KanbanBulkArchiveCardsInput): Promise<KanbanBulkArchiveCardsResult>;
  kanbanBulkMoveCards?(input: KanbanBulkMoveCardsInput): Promise<KanbanBulkMoveCardsResult>;
  kanbanDuplicateCard?(input: KanbanDuplicateCardInput): Promise<KanbanDuplicateCardResult>;
  kanbanMoveCardToProject?(input: KanbanMoveCardToProjectInput): Promise<KanbanMoveCardToProjectResult>;
  kanbanAddColumn?(input: KanbanAddColumnInput): Promise<KanbanAddColumnResult>;
  kanbanRenameColumn?(input: KanbanRenameColumnInput): Promise<KanbanRenameColumnResult>;
  kanbanDeleteColumn?(input: KanbanDeleteColumnInput): Promise<KanbanDeleteColumnResult>;
  kanbanUndo?(input: KanbanUndoInput): Promise<KanbanUndoResult>;
  kanbanSubscribe?(input: KanbanSubscribeInput): Promise<KanbanSubscribeResult>;
  kanbanUnsubscribe?(input: KanbanUnsubscribeInput): Promise<KanbanUnsubscribeResult>;
}
