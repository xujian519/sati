import type { Gateway, GatewayEvent } from "../protocol/types.js";
import type { WsHelloFrame, WsRequestFrame } from "../protocol/frames.js";
import { SATI_GATEWAY_PROTOCOL_VERSION, isProtocolCompatible } from "../protocol/version.js";
import { notConfigured } from "../protocol/notConfigured.js";
import { SkillManagerError, SkillValidationError } from "../../extension/skills/index.js";
import type { KanbanBoardManager, KanbanSubscriber } from "../kanban/KanbanBoardManager.js";
import { TextWebSocketConnection } from "./websocket.js";
import { validateMethodParams } from "./methodGuards.js";
import type { SessionPresence } from "./sessionPresence.js";

/** 从 `Gateway` 接口推导某方法的首个参数类型（兼容可选方法 `| undefined` 与内联对象类型）。 */
type GatewayMethodParams<K extends keyof Gateway> = Parameters<NonNullable<Gateway[K]>>[0];

export type GatewayWsConnectionOptions = {
  gateway: Gateway;
  token: string;
  serverVersion: string;
  /** M3：连接活跃追踪（可选——未注入时零开销，不破坏既有构造点/测试）。 */
  presence?: SessionPresence;
  /** 项目看板订阅与广播管理器；未注入时 `kanban_subscribe` 等直接返回 not_configured。 */
  kanban?: KanbanBoardManager;
};

export class GatewayWsConnection {
  private authed = false;
  private readonly presence: SessionPresence | undefined;
  /**
   * 最近一帧携带的 sessionKey（onClose 注销用）。
   * 已知限制（连接级单槽位）：同 sessionKey 多连接并存时，任一关闭即触发 close
   * （宽限窗 + 下一帧 touch 复位兜底，误判方向 fail-safe）；连接内交错多 key 时仅最后 key 注销。
   */
  private lastSessionKey: string | undefined;
  private readonly inFlightSessions = new Set<string>();
  private readonly kanbanSubscriber: KanbanSubscriber;
  /** submit_turn 事件流发送缓冲：16ms 窗口合并，减少长轮次数千事件的 write/syscall。 */
  private readonly pendingTexts: string[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly FLUSH_INTERVAL_MS = 16;

  constructor(
    private readonly ws: TextWebSocketConnection,
    private readonly options: GatewayWsConnectionOptions,
  ) {
    this.presence = options.presence;
    ws.onMessage(message => void this.handleMessage(message));
    const subscriberId = `conn-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    this.kanbanSubscriber = {
      id: subscriberId,
      send: payload => {
        this.sendNotification("kanban_updated", payload);
      },
    };

    ws.onClose(() => {
      // M3：连接关闭注销活跃（宽限窗内仍算在线，防瞬断误判）
      if (this.lastSessionKey !== undefined) {
        this.presence?.close(this.lastSessionKey);
      }
    });
    ws.onClose(() => {
      this.options.kanban?.unsubscribeAll(this.kanbanSubscriber);
    });
    ws.onClose(() => this.abortInFlightTurns());
    // 连接关闭时清理发送缓冲与定时器（防悬空定时器/内存残留）
    ws.onClose(() => {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
      this.pendingTexts.length = 0;
    });
  }

  private abortInFlightTurns(): void {
    for (const sessionKey of this.inFlightSessions) {
      this.options.gateway.abortTurn({ sessionKey }).catch(() => undefined);
    }
    this.inFlightSessions.clear();
  }

  sendNotification(name: string, payload?: unknown): void {
    if (!this.authed) return;
    this.ws.sendText(JSON.stringify({ type: "notification", name, payload }));
  }

  /** 缓冲一条发送文本，16ms 窗口后合并批量写入。 */
  private queueText(text: string): void {
    this.pendingTexts.push(text);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushPending();
    }, this.FLUSH_INTERVAL_MS);
  }

  /** 立即冲刷缓冲（含取消 pending 定时器）。 */
  private flushPending(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.pendingTexts.length === 0) return;
    const batch = this.pendingTexts.splice(0, this.pendingTexts.length);
    this.ws.sendBatch(batch);
  }

  onClose(callback: () => void): void {
    this.ws.onClose(callback);
  }

  private async handleMessage(message: string): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      this.ws.close(4002, "invalid_json");
      return;
    }

    if (!this.authed) {
      await this.handleHello(frame);
      return;
    }

    if (!isRequestFrame(frame)) {
      this.ws.close(4002, "invalid_frame");
      return;
    }
    await this.handleRequest(frame);
  }

  private async handleHello(frame: unknown): Promise<void> {
    if (!isHelloFrame(frame)) {
      this.ws.close(4001, "hello_required");
      return;
    }
    if (!isProtocolCompatible(frame.protocolVersion, SATI_GATEWAY_PROTOCOL_VERSION)) {
      this.ws.close(4001, "protocol_mismatch");
      return;
    }
    if (frame.token !== this.options.token) {
      this.ws.close(4003, "auth_failed");
      return;
    }
    this.authed = true;
    this.ws.sendText(
      JSON.stringify({
        type: "hello_ok",
        protocolVersion: SATI_GATEWAY_PROTOCOL_VERSION,
        serverVersion: this.options.serverVersion,
        serverInfo: await this.options.gateway.describeServer(),
      }),
    );
  }

  private async handleRequest(frame: WsRequestFrame): Promise<void> {
    try {
      // TD-GATEWAY-002/006：线上 JSON.parse 出的 params 在分发前做一次
      // 守卫表收窄，畸形入参回结构化 invalid_params 而非深入实现层炸 TypeError。
      const paramError = validateMethodParams(frame.method, frame.params);
      if (paramError) {
        this.ws.sendText(
          JSON.stringify({
            type: "response",
            id: frame.id,
            ok: false,
            error: { code: "invalid_params", message: paramError },
          }),
        );
        return;
      }
      // M3：任何请求帧都刷新连接活跃（submit_turn 分支继续使用本变量）
      const sessionKey = (frame.params as { sessionKey?: string } | undefined)?.sessionKey;
      if (sessionKey !== undefined && sessionKey !== "") {
        this.lastSessionKey = sessionKey;
        this.presence?.touch(sessionKey);
      }
      if (frame.method === "submit_turn") {
        if (sessionKey) this.inFlightSessions.add(sessionKey);
        let seq = 0;
        let lastCompleted: GatewayEvent | undefined;
        try {
          for await (const event of this.options.gateway.submitTurn(
            frame.params as GatewayMethodParams<"submitTurn">,
          )) {
            if (event.type === "turn_completed") {
              lastCompleted = event;
            }
            // 事件流经 16ms 缓冲批量发送（帧语义不变，仅减少 write 次数）；
            // 循环结束立即冲刷保证 final 帧紧随其后、顺序不变。
            this.queueText(JSON.stringify({ type: "event", id: frame.id, seq: seq++, final: false, event }));
          }
        } finally {
          this.flushPending();
          if (sessionKey) this.inFlightSessions.delete(sessionKey);
        }
        const usage = lastCompleted?.type === "turn_completed" ? lastCompleted.usage : {};
        const finishReason = lastCompleted?.type === "turn_completed" ? lastCompleted.finishReason : "completed";
        this.ws.sendText(
          JSON.stringify({
            type: "event",
            id: frame.id,
            seq,
            final: true,
            event: { type: "turn_completed", usage, finishReason },
          }),
        );
        return;
      }

      const result = await this.dispatchRequest(frame);
      this.ws.sendText(JSON.stringify({ type: "response", id: frame.id, ok: true, result }));
    } catch (error) {
      // SkillManagerError carries a structured `code` we want to round-
      // trip to the client (so the UI can surface "conflict", "not_found",
      // "invalid_slug", etc. as actionable messages instead of a generic
      // 500). SkillValidationError additionally carries the structured
      // validation payload that powers the compliance panel.
      if (error instanceof SkillValidationError) {
        this.ws.sendText(
          JSON.stringify({
            type: "response",
            id: frame.id,
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              validation: error.validation,
            },
          }),
        );
        return;
      }
      if (error instanceof SkillManagerError) {
        this.ws.sendText(
          JSON.stringify({
            type: "response",
            id: frame.id,
            ok: false,
            error: {
              code: error.code,
              message: error.message,
            },
          }),
        );
        return;
      }
      this.ws.sendText(
        JSON.stringify({
          type: "response",
          id: frame.id,
          ok: false,
          error: {
            code: "gateway_request_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
  }

  private dispatchRequest(frame: WsRequestFrame): Promise<unknown> {
    switch (frame.method) {
      case "abort_turn":
        return this.options.gateway
          .abortTurn(frame.params as GatewayMethodParams<"abortTurn">)
          .then(() => ({ ok: true }));
      case "steer_turn":
        if (this.options.gateway.steerTurn) {
          return this.options.gateway.steerTurn(frame.params as GatewayMethodParams<"steerTurn">);
        }
        return Promise.resolve(notConfigured({ delivered: false }, "Mid-turn steering not available"));
      case "cancel_steer":
        if (this.options.gateway.cancelSteer) {
          return this.options.gateway.cancelSteer(frame.params as GatewayMethodParams<"cancelSteer">);
        }
        return Promise.resolve(notConfigured({ cancelled: false }, "Mid-turn steering not available"));
      case "edit_last_turn":
        if (this.options.gateway.editLastTurn) {
          return this.options.gateway.editLastTurn(frame.params as GatewayMethodParams<"editLastTurn">);
        }
        return Promise.resolve(notConfigured({ rewritten: false }, "Edit last turn not available"));
      case "regenerate_last_turn":
        if (this.options.gateway.regenerateLastTurn) {
          return this.options.gateway.regenerateLastTurn(frame.params as GatewayMethodParams<"regenerateLastTurn">);
        }
        return Promise.resolve(notConfigured({ rewritten: false }, "Regenerate last turn not available"));
      case "list_sessions":
        return this.options.gateway.listSessions(frame.params as GatewayMethodParams<"listSessions">);
      case "resume_session":
        return this.options.gateway.resumeSession(frame.params as GatewayMethodParams<"resumeSession">);
      case "new_session":
        return this.options.gateway.newSession(frame.params as GatewayMethodParams<"newSession">);
      case "close_session":
        return this.options.gateway
          .closeSession(frame.params as GatewayMethodParams<"closeSession">)
          .then(() => ({ ok: true }));
      case "record_agent_status_message":
        if (this.options.gateway.recordAgentStatusMessage) {
          return this.options.gateway.recordAgentStatusMessage(
            frame.params as GatewayMethodParams<"recordAgentStatusMessage">,
          );
        }
        return Promise.resolve({ recorded: false });
      case "describe_server":
        return this.options.gateway.describeServer();
      case "active_turn_snapshot":
        if (this.options.gateway.getActiveTurnSnapshot) {
          return this.options.gateway.getActiveTurnSnapshot(
            frame.params as GatewayMethodParams<"getActiveTurnSnapshot">,
          );
        }
        return Promise.resolve({
          active: false,
          sessionKey: (frame.params as { sessionKey?: string } | undefined)?.sessionKey ?? "",
          events: [],
        });
      case "cron_create":
        return this.options.gateway.cronCreate(frame.params as GatewayMethodParams<"cronCreate">);
      case "cron_update":
        return this.options.gateway.cronUpdate(frame.params as GatewayMethodParams<"cronUpdate">);
      case "cron_list":
        return this.options.gateway.cronList(frame.params as GatewayMethodParams<"cronList">);
      case "cron_delete":
        return this.options.gateway.cronDelete(frame.params as GatewayMethodParams<"cronDelete">);
      case "cron_stop":
        return this.options.gateway.cronStop(frame.params as GatewayMethodParams<"cronStop">);
      case "cron_run_now":
        return this.options.gateway.cronRunNow(frame.params as GatewayMethodParams<"cronRunNow">);
      case "panel_heartbeat":
        if (this.options.gateway.panelHeartbeat) {
          return this.options.gateway.panelHeartbeat(frame.params as GatewayMethodParams<"panelHeartbeat">);
        }
        return Promise.resolve(notConfigured({ touched: 0 }, "Panel heartbeat not available"));
      case "team_panel_snapshot":
        if (this.options.gateway.teamPanelSnapshot) {
          return this.options.gateway.teamPanelSnapshot(frame.params as GatewayMethodParams<"teamPanelSnapshot">);
        }
        return Promise.resolve(notConfigured({ teams: [] }, "Team panel snapshot not available"));
      case "team_tool_call":
        if (this.options.gateway.teamToolCall) {
          return this.options.gateway.teamToolCall(frame.params as GatewayMethodParams<"teamToolCall">);
        }
        return Promise.resolve(
          notConfigured(
            { ok: false, error: { code: "not_configured", message: "Team tool call not available" } },
            "Team tool call not available",
          ),
        );
      case "elicitation_respond":
        return this.options.gateway.respondElicitation(frame.params as GatewayMethodParams<"respondElicitation">);
      case "permission_decide":
        return this.options.gateway.permissionDecide(frame.params as GatewayMethodParams<"permissionDecide">);
      case "grant_session_permission":
        return this.options.gateway.grantSessionPermission(
          frame.params as GatewayMethodParams<"grantSessionPermission">,
        );
      case "approval_list_pending":
        if (this.options.gateway.approvalListPending) {
          return this.options.gateway.approvalListPending(frame.params as GatewayMethodParams<"approvalListPending">);
        }
        return Promise.resolve(notConfigured({ pending: [] }, "Approval list not available"));
      case "approval_decide":
        if (this.options.gateway.approvalDecide) {
          return this.options.gateway.approvalDecide(frame.params as GatewayMethodParams<"approvalDecide">);
        }
        return Promise.resolve(notConfigured({ delivered: false }, "Approval decide not available"));
      case "read_session_messages":
        return this.options.gateway.readSessionMessages(frame.params as GatewayMethodParams<"readSessionMessages">);
      case "read_subagent_messages":
        return this.options.gateway.readSubagentMessages(frame.params as GatewayMethodParams<"readSubagentMessages">);
      case "fork_session":
        return this.options.gateway.forkSession(frame.params as GatewayMethodParams<"forkSession">);
      case "list_projects":
        return this.options.gateway.listProjects();
      case "describe_project":
        return this.options.gateway.describeProject(frame.params as GatewayMethodParams<"describeProject">);
      case "reload_config":
        if (this.options.gateway.reloadConfig) {
          return this.options.gateway.reloadConfig();
        }
        return Promise.resolve({ reloaded: false, reason: "unsupported" });
      case "prepare_weixin_login":
        if (this.options.gateway.prepareWeixinLogin) {
          return this.options.gateway.prepareWeixinLogin();
        }
        return Promise.resolve({
          requested: false,
          requestedAt: new Date().toISOString(),
          reason: "unsupported",
        });
      case "reload_extensions":
        if (this.options.gateway.reloadExtensions) {
          return this.options.gateway.reloadExtensions(frame.params as GatewayMethodParams<"reloadExtensions">);
        }
        return Promise.resolve({ reloaded: false, reason: "unsupported" });
      case "skill_list":
        return requireSkillMethod(
          this.options.gateway.skillsList,
          this.options.gateway,
        )(frame.params as GatewayMethodParams<"skillsList">);
      case "skill_read":
        return requireSkillMethod(
          this.options.gateway.skillRead,
          this.options.gateway,
        )(frame.params as GatewayMethodParams<"skillRead">);
      case "skill_write":
        return requireSkillMethod(
          this.options.gateway.skillWrite,
          this.options.gateway,
        )(frame.params as GatewayMethodParams<"skillWrite">);
      case "skill_create":
        return requireSkillMethod(
          this.options.gateway.skillCreate,
          this.options.gateway,
        )(frame.params as GatewayMethodParams<"skillCreate">);
      case "skill_delete":
        return requireSkillMethod(
          this.options.gateway.skillDelete,
          this.options.gateway,
        )(frame.params as GatewayMethodParams<"skillDelete">);
      case "skill_import":
        return requireSkillMethod(
          this.options.gateway.skillImport,
          this.options.gateway,
        )(frame.params as GatewayMethodParams<"skillImport">);
      case "skill_validate":
        return requireSkillMethod(
          this.options.gateway.skillValidate,
          this.options.gateway,
        )(frame.params as GatewayMethodParams<"skillValidate">);
      case "skill_scan":
        return requireSkillMethod(
          this.options.gateway.skillScan,
          this.options.gateway,
        )(frame.params as GatewayMethodParams<"skillScan">);
      case "always_on_apply":
        if (this.options.gateway.alwaysOnApply) {
          return this.options.gateway.alwaysOnApply(frame.params as GatewayMethodParams<"alwaysOnApply">);
        }
        return Promise.resolve(notConfigured({ sessionKey: "" }, "Always-On apply not available"));
      case "always_on_rerun_plan":
        if (this.options.gateway.alwaysOnRerunPlan) {
          return this.options.gateway.alwaysOnRerunPlan(frame.params as GatewayMethodParams<"alwaysOnRerunPlan">);
        }
        return Promise.resolve(notConfigured({ runId: "" }, "Always-On rerun not available"));
      case "always_on_list_plans":
        if (this.options.gateway.alwaysOnListPlans) {
          return this.options.gateway.alwaysOnListPlans(frame.params as GatewayMethodParams<"alwaysOnListPlans">);
        }
        return Promise.resolve(notConfigured({ plans: [] }, "Always-On plans list not available"));
      case "always_on_read_report":
        if (this.options.gateway.alwaysOnReadReport) {
          return this.options.gateway.alwaysOnReadReport(frame.params as GatewayMethodParams<"alwaysOnReadReport">);
        }
        return Promise.resolve(notConfigured({ content: "" }, "Always-On report not available"));
      case "always_on_list_cycles":
        if (this.options.gateway.alwaysOnListCycles) {
          return this.options.gateway.alwaysOnListCycles(frame.params as GatewayMethodParams<"alwaysOnListCycles">);
        }
        return Promise.resolve(notConfigured({ cycles: [] }, "Always-On cycles list not available"));
      case "always_on_archive_cycle":
        if (this.options.gateway.alwaysOnArchiveCycle) {
          return this.options.gateway.alwaysOnArchiveCycle(frame.params as GatewayMethodParams<"alwaysOnArchiveCycle">);
        }
        return Promise.resolve(notConfigured({ archived: false }, "Always-On archive not available"));
      case "always_on_apply_cycle":
        if (this.options.gateway.alwaysOnApplyCycle) {
          return this.options.gateway.alwaysOnApplyCycle(frame.params as GatewayMethodParams<"alwaysOnApplyCycle">);
        }
        return Promise.resolve(notConfigured({ cycle: null }, "Always-On apply not available"));
      case "knowledge_capabilities":
        if (this.options.gateway.knowledgeCapabilities) {
          return this.options.gateway.knowledgeCapabilities(
            frame.params as GatewayMethodParams<"knowledgeCapabilities">,
          );
        }
        return Promise.resolve(
          notConfigured(
            { dataDir: "", capabilities: [], embeddingConfigured: false, rerankConfigured: false },
            "Knowledge capabilities not available",
          ),
        );
      case "kanban_get":
        if (this.options.gateway.kanbanGet) {
          return this.options.gateway.kanbanGet(frame.params as GatewayMethodParams<"kanbanGet">);
        }
        return Promise.resolve(notConfigured({}, "Kanban is not available"));
      case "kanban_add_card":
        if (this.options.gateway.kanbanAddCard) {
          return this.options.gateway.kanbanAddCard(frame.params as GatewayMethodParams<"kanbanAddCard">);
        }
        return Promise.resolve(notConfigured({ card: null }, "Kanban is not available"));
      case "kanban_update_card":
        if (this.options.gateway.kanbanUpdateCard) {
          return this.options.gateway.kanbanUpdateCard(frame.params as GatewayMethodParams<"kanbanUpdateCard">);
        }
        return Promise.resolve(notConfigured({ card: null }, "Kanban is not available"));
      case "kanban_move_card":
        if (this.options.gateway.kanbanMoveCard) {
          return this.options.gateway.kanbanMoveCard(frame.params as GatewayMethodParams<"kanbanMoveCard">);
        }
        return Promise.resolve(notConfigured({ ok: false }, "Kanban is not available"));
      case "kanban_archive_card":
        if (this.options.gateway.kanbanArchiveCard) {
          return this.options.gateway.kanbanArchiveCard(frame.params as GatewayMethodParams<"kanbanArchiveCard">);
        }
        return Promise.resolve(notConfigured({ ok: false }, "Kanban is not available"));
      case "kanban_restore_card":
        if (this.options.gateway.kanbanRestoreCard) {
          return this.options.gateway.kanbanRestoreCard(frame.params as GatewayMethodParams<"kanbanRestoreCard">);
        }
        return Promise.resolve(notConfigured({ ok: false }, "Kanban is not available"));
      case "kanban_purge_card":
        if (this.options.gateway.kanbanPurgeCard) {
          return this.options.gateway.kanbanPurgeCard(frame.params as GatewayMethodParams<"kanbanPurgeCard">);
        }
        return Promise.resolve(notConfigured({ ok: false }, "Kanban is not available"));
      case "kanban_bulk_archive_cards":
        if (this.options.gateway.kanbanBulkArchiveCards) {
          return this.options.gateway.kanbanBulkArchiveCards(
            frame.params as GatewayMethodParams<"kanbanBulkArchiveCards">,
          );
        }
        return Promise.resolve(notConfigured({ ok: false }, "Kanban is not available"));
      case "kanban_bulk_move_cards":
        if (this.options.gateway.kanbanBulkMoveCards) {
          return this.options.gateway.kanbanBulkMoveCards(frame.params as GatewayMethodParams<"kanbanBulkMoveCards">);
        }
        return Promise.resolve(notConfigured({ ok: false }, "Kanban is not available"));
      case "kanban_duplicate_card":
        if (this.options.gateway.kanbanDuplicateCard) {
          return this.options.gateway.kanbanDuplicateCard(frame.params as GatewayMethodParams<"kanbanDuplicateCard">);
        }
        return Promise.resolve(notConfigured({ card: null }, "Kanban is not available"));
      case "kanban_move_card_to_project":
        if (this.options.gateway.kanbanMoveCardToProject) {
          return this.options.gateway.kanbanMoveCardToProject(
            frame.params as GatewayMethodParams<"kanbanMoveCardToProject">,
          );
        }
        return Promise.resolve(notConfigured({ card: null }, "Kanban is not available"));
      case "kanban_add_column":
        if (this.options.gateway.kanbanAddColumn) {
          return this.options.gateway.kanbanAddColumn(frame.params as GatewayMethodParams<"kanbanAddColumn">);
        }
        return Promise.resolve(notConfigured({ column: null }, "Kanban is not available"));
      case "kanban_rename_column":
        if (this.options.gateway.kanbanRenameColumn) {
          return this.options.gateway.kanbanRenameColumn(frame.params as GatewayMethodParams<"kanbanRenameColumn">);
        }
        return Promise.resolve(notConfigured({ ok: false }, "Kanban is not available"));
      case "kanban_delete_column":
        if (this.options.gateway.kanbanDeleteColumn) {
          return this.options.gateway.kanbanDeleteColumn(frame.params as GatewayMethodParams<"kanbanDeleteColumn">);
        }
        return Promise.resolve(notConfigured({ ok: false }, "Kanban is not available"));
      case "kanban_reorder_columns":
        if (this.options.gateway.kanbanReorderColumns) {
          return this.options.gateway.kanbanReorderColumns(frame.params as GatewayMethodParams<"kanbanReorderColumns">);
        }
        return Promise.resolve(notConfigured({ ok: false }, "Kanban is not available"));
      case "kanban_undo":
        if (this.options.gateway.kanbanUndo) {
          return this.options.gateway.kanbanUndo(frame.params as GatewayMethodParams<"kanbanUndo">);
        }
        return Promise.resolve(notConfigured({ ok: false }, "Kanban is not available"));
      case "kanban_subscribe": {
        const manager = this.options.kanban;
        if (!manager) {
          return Promise.resolve(notConfigured({ subscribed: false }, "Kanban is not available"));
        }
        const subParams = frame.params as { projectId?: string } | undefined;
        const projectId = subParams?.projectId;
        if (typeof projectId !== "string" || projectId === "") {
          throw new Error("kanban_subscribe requires projectId");
        }
        manager.subscribe(projectId, this.kanbanSubscriber);
        return Promise.resolve({ subscribed: true });
      }
      case "kanban_unsubscribe": {
        const manager = this.options.kanban;
        if (!manager) {
          return Promise.resolve(notConfigured({ unsubscribed: false }, "Kanban is not available"));
        }
        const unsubParams = frame.params as { projectId?: string } | undefined;
        const projectId = unsubParams?.projectId;
        if (typeof projectId !== "string" || projectId === "") {
          throw new Error("kanban_unsubscribe requires projectId");
        }
        manager.unsubscribe(projectId, this.kanbanSubscriber);
        return Promise.resolve({ unsubscribed: true });
      }
      default:
        throw new Error(`Unknown gateway method ${(frame as { method?: string }).method}.`);
    }
  }
}

/**
 * Guard for optional Skill RPC methods on the Gateway. The Gateway
 * interface marks every `skill*` method as optional so older
 * RemoteGateway-backed servers don't break the type contract. When a
 * client invokes a method this server's gateway doesn't implement, we
 * fail with a structured `not_configured` error instead of crashing
 * the dispatcher.
 */
function requireSkillMethod<TArg, TRet>(
  method: ((arg: TArg) => Promise<TRet>) | undefined,
  gateway: Gateway,
): (arg: TArg) => Promise<TRet> {
  if (!method) {
    throw new SkillManagerError("not_configured", "Skill management is not enabled on this gateway.");
  }
  return method.bind(gateway);
}

function isHelloFrame(value: unknown): value is WsHelloFrame {
  return (
    isRecord(value) &&
    value.type === "hello" &&
    typeof value.protocolVersion === "string" &&
    typeof value.clientName === "string" &&
    typeof value.clientVersion === "string" &&
    typeof value.token === "string"
  );
}

function isRequestFrame(value: unknown): value is WsRequestFrame {
  return (
    isRecord(value) && value.type === "request" && typeof value.id === "string" && typeof value.method === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
