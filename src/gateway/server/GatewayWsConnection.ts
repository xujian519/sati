import type { Gateway, GatewayEvent } from "../protocol/types.js";
import type { WsGatewayMethod, WsHelloFrame, WsRequestFrame } from "../protocol/frames.js";
import { SATI_GATEWAY_PROTOCOL_VERSION, isProtocolCompatible } from "../protocol/version.js";
import { notConfigured } from "../protocol/notConfigured.js";
import { GatewayMethodUnavailableError } from "../protocol/methodUnavailable.js";
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
      // 帧非 JSON → 以 4002 关闭连接（对端协议错误，不重抛）。
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
      // 同上，另有 GatewayMethodUnavailableError：可选方法未接线时必须带上
      // `method_unavailable`，否则调用方只能拿到笼统的 gateway_request_failed。
      if (error instanceof SkillManagerError || error instanceof GatewayMethodUnavailableError) {
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

  /** 直连：gateway 必实现方法（结果原样回，可选 map 变换如统一 {ok:true}）。 */
  private callMethod<K extends keyof Gateway>(
    name: K,
    params: GatewayMethodParams<K>,
    map?: (result: unknown) => unknown,
  ): Promise<unknown> {
    const method = this.options.gateway[name] as (p: GatewayMethodParams<K>) => Promise<unknown>;
    const result = method.call(this.options.gateway, params);
    return map ? result.then(map) : result;
  }

  /**
   * 可选：方法未接线时回退 fallback(params)（not_configured 降级或合成默认），
   * 不崩溃。必选形态差异（not_configured 文案 / 合成默认值）留在表项里一眼可见。
   */
  private callOptional<K extends keyof Gateway>(
    name: K,
    params: GatewayMethodParams<K>,
    fallback: (params: GatewayMethodParams<K>) => unknown,
  ): Promise<unknown> {
    const method = this.options.gateway[name] as ((p: GatewayMethodParams<K>) => Promise<unknown>) | undefined;
    if (!method) return Promise.resolve(fallback(params));
    return method.call(this.options.gateway, params);
  }

  /**
   * method → 分发器表（P2.4）：与 methodGuards.ts 的 METHOD_PARAM_GUARDS 同构的
   * required Record —— WsGatewayMethod union 新增方法名时 typecheck 强制补表项，
   * 旧 switch default 的「Unknown gateway method」收敛为 dispatchRequest 唯一防御分支。
   * 表项按「直连 / {ok:true} 包装 / 可选回退 / 必填抛错 / skill 绑定 / kanban 订阅特判」分组；
   * callMethod/callOptional 消掉逐 case 的 `if (!method)` 样板。
   */
  private readonly methodDispatchers: Record<WsGatewayMethod, (params: unknown) => Promise<unknown>> = {
    // —— 直连：结果原样回 ——
    list_sessions: p => this.callMethod("listSessions", p as GatewayMethodParams<"listSessions">),
    resume_session: p => this.callMethod("resumeSession", p as GatewayMethodParams<"resumeSession">),
    new_session: p => this.callMethod("newSession", p as GatewayMethodParams<"newSession">),
    cron_create: p => this.callMethod("cronCreate", p as GatewayMethodParams<"cronCreate">),
    cron_update: p => this.callMethod("cronUpdate", p as GatewayMethodParams<"cronUpdate">),
    cron_list: p => this.callMethod("cronList", p as GatewayMethodParams<"cronList">),
    cron_delete: p => this.callMethod("cronDelete", p as GatewayMethodParams<"cronDelete">),
    cron_stop: p => this.callMethod("cronStop", p as GatewayMethodParams<"cronStop">),
    cron_run_now: p => this.callMethod("cronRunNow", p as GatewayMethodParams<"cronRunNow">),
    elicitation_respond: p => this.callMethod("respondElicitation", p as GatewayMethodParams<"respondElicitation">),
    permission_decide: p => this.callMethod("permissionDecide", p as GatewayMethodParams<"permissionDecide">),
    grant_session_permission: p =>
      this.callMethod("grantSessionPermission", p as GatewayMethodParams<"grantSessionPermission">),
    read_session_messages: p => this.callMethod("readSessionMessages", p as GatewayMethodParams<"readSessionMessages">),
    read_subagent_messages: p =>
      this.callMethod("readSubagentMessages", p as GatewayMethodParams<"readSubagentMessages">),
    fork_session: p => this.callMethod("forkSession", p as GatewayMethodParams<"forkSession">),
    describe_project: p => this.callMethod("describeProject", p as GatewayMethodParams<"describeProject">),

    // —— 直连：返回值统一包装成 {ok:true} ——
    abort_turn: p => this.callMethod("abortTurn", p as GatewayMethodParams<"abortTurn">, () => ({ ok: true })),
    close_session: p => this.callMethod("closeSession", p as GatewayMethodParams<"closeSession">, () => ({ ok: true })),

    // —— 直连：无参 ——
    describe_server: () => this.options.gateway.describeServer(),
    list_projects: () => this.options.gateway.listProjects(),

    // —— 可选：未接线 → not_configured 降级 ——
    steer_turn: p =>
      this.callOptional("steerTurn", p as GatewayMethodParams<"steerTurn">, () =>
        notConfigured({ delivered: false }, "Mid-turn steering not available"),
      ),
    cancel_steer: p =>
      this.callOptional("cancelSteer", p as GatewayMethodParams<"cancelSteer">, () =>
        notConfigured({ cancelled: false }, "Mid-turn steering not available"),
      ),
    edit_last_turn: p =>
      this.callOptional("editLastTurn", p as GatewayMethodParams<"editLastTurn">, () =>
        notConfigured({ rewritten: false }, "Edit last turn not available"),
      ),
    regenerate_last_turn: p =>
      this.callOptional("regenerateLastTurn", p as GatewayMethodParams<"regenerateLastTurn">, () =>
        notConfigured({ rewritten: false }, "Regenerate last turn not available"),
      ),
    panel_heartbeat: p =>
      this.callOptional("panelHeartbeat", p as GatewayMethodParams<"panelHeartbeat">, () =>
        notConfigured({ touched: 0 }, "Panel heartbeat not available"),
      ),
    team_panel_snapshot: p =>
      this.callOptional("teamPanelSnapshot", p as GatewayMethodParams<"teamPanelSnapshot">, () =>
        notConfigured({ teams: [] }, "Team panel snapshot not available"),
      ),
    team_tool_call: p =>
      this.callOptional("teamToolCall", p as GatewayMethodParams<"teamToolCall">, () =>
        notConfigured(
          { ok: false, error: { code: "not_configured", message: "Team tool call not available" } },
          "Team tool call not available",
        ),
      ),
    approval_list_pending: p =>
      this.callOptional("approvalListPending", p as GatewayMethodParams<"approvalListPending">, () =>
        notConfigured({ pending: [] }, "Approval list not available"),
      ),
    approval_decide: p =>
      this.callOptional("approvalDecide", p as GatewayMethodParams<"approvalDecide">, () =>
        notConfigured({ delivered: false }, "Approval decide not available"),
      ),
    hook_trust_list: p =>
      this.callOptional("hookTrustList", p as GatewayMethodParams<"hookTrustList">, () =>
        notConfigured({ workspaceIdentityKey: "", entries: [] }, "Hook trust not available"),
      ),
    hook_trust_decide: p =>
      this.callOptional("hookTrustDecide", p as GatewayMethodParams<"hookTrustDecide">, () =>
        notConfigured({ applied: false }, "Hook trust not available"),
      ),
    always_on_apply: p =>
      this.callOptional("alwaysOnApply", p as GatewayMethodParams<"alwaysOnApply">, () =>
        notConfigured({ sessionKey: "" }, "Always-On apply not available"),
      ),
    always_on_rerun_plan: p =>
      this.callOptional("alwaysOnRerunPlan", p as GatewayMethodParams<"alwaysOnRerunPlan">, () =>
        notConfigured({ runId: "" }, "Always-On rerun not available"),
      ),
    always_on_list_plans: p =>
      this.callOptional("alwaysOnListPlans", p as GatewayMethodParams<"alwaysOnListPlans">, () =>
        notConfigured({ plans: [] }, "Always-On plans list not available"),
      ),
    always_on_read_report: p =>
      this.callOptional("alwaysOnReadReport", p as GatewayMethodParams<"alwaysOnReadReport">, () =>
        notConfigured({ content: "" }, "Always-On report not available"),
      ),
    always_on_list_cycles: p =>
      this.callOptional("alwaysOnListCycles", p as GatewayMethodParams<"alwaysOnListCycles">, () =>
        notConfigured({ cycles: [] }, "Always-On cycles list not available"),
      ),
    always_on_archive_cycle: p =>
      this.callOptional("alwaysOnArchiveCycle", p as GatewayMethodParams<"alwaysOnArchiveCycle">, () =>
        notConfigured({ archived: false }, "Always-On archive not available"),
      ),
    always_on_apply_cycle: p =>
      this.callOptional("alwaysOnApplyCycle", p as GatewayMethodParams<"alwaysOnApplyCycle">, () =>
        notConfigured({ cycle: null }, "Always-On apply not available"),
      ),
    knowledge_capabilities: p =>
      this.callOptional("knowledgeCapabilities", p as GatewayMethodParams<"knowledgeCapabilities">, () =>
        notConfigured(
          { dataDir: "", capabilities: [], embeddingConfigured: false, rerankConfigured: false },
          "Knowledge capabilities not available",
        ),
      ),
    kanban_get: p =>
      this.callOptional("kanbanGet", p as GatewayMethodParams<"kanbanGet">, () =>
        notConfigured({}, "Kanban is not available"),
      ),
    kanban_add_card: p =>
      this.callOptional("kanbanAddCard", p as GatewayMethodParams<"kanbanAddCard">, () =>
        notConfigured({ card: null }, "Kanban is not available"),
      ),
    kanban_update_card: p =>
      this.callOptional("kanbanUpdateCard", p as GatewayMethodParams<"kanbanUpdateCard">, () =>
        notConfigured({ card: null }, "Kanban is not available"),
      ),
    kanban_move_card: p =>
      this.callOptional("kanbanMoveCard", p as GatewayMethodParams<"kanbanMoveCard">, () =>
        notConfigured({ ok: false }, "Kanban is not available"),
      ),
    kanban_archive_card: p =>
      this.callOptional("kanbanArchiveCard", p as GatewayMethodParams<"kanbanArchiveCard">, () =>
        notConfigured({ ok: false }, "Kanban is not available"),
      ),
    kanban_restore_card: p =>
      this.callOptional("kanbanRestoreCard", p as GatewayMethodParams<"kanbanRestoreCard">, () =>
        notConfigured({ ok: false }, "Kanban is not available"),
      ),
    kanban_purge_card: p =>
      this.callOptional("kanbanPurgeCard", p as GatewayMethodParams<"kanbanPurgeCard">, () =>
        notConfigured({ ok: false }, "Kanban is not available"),
      ),
    kanban_bulk_archive_cards: p =>
      this.callOptional("kanbanBulkArchiveCards", p as GatewayMethodParams<"kanbanBulkArchiveCards">, () =>
        notConfigured({ ok: false }, "Kanban is not available"),
      ),
    kanban_bulk_move_cards: p =>
      this.callOptional("kanbanBulkMoveCards", p as GatewayMethodParams<"kanbanBulkMoveCards">, () =>
        notConfigured({ ok: false }, "Kanban is not available"),
      ),
    kanban_duplicate_card: p =>
      this.callOptional("kanbanDuplicateCard", p as GatewayMethodParams<"kanbanDuplicateCard">, () =>
        notConfigured({ card: null }, "Kanban is not available"),
      ),
    kanban_move_card_to_project: p =>
      this.callOptional("kanbanMoveCardToProject", p as GatewayMethodParams<"kanbanMoveCardToProject">, () =>
        notConfigured({ card: null }, "Kanban is not available"),
      ),
    kanban_add_column: p =>
      this.callOptional("kanbanAddColumn", p as GatewayMethodParams<"kanbanAddColumn">, () =>
        notConfigured({ column: null }, "Kanban is not available"),
      ),
    kanban_rename_column: p =>
      this.callOptional("kanbanRenameColumn", p as GatewayMethodParams<"kanbanRenameColumn">, () =>
        notConfigured({ ok: false }, "Kanban is not available"),
      ),
    kanban_delete_column: p =>
      this.callOptional("kanbanDeleteColumn", p as GatewayMethodParams<"kanbanDeleteColumn">, () =>
        notConfigured({ ok: false }, "Kanban is not available"),
      ),
    kanban_reorder_columns: p =>
      this.callOptional("kanbanReorderColumns", p as GatewayMethodParams<"kanbanReorderColumns">, () =>
        notConfigured({ ok: false }, "Kanban is not available"),
      ),
    kanban_undo: p =>
      this.callOptional("kanbanUndo", p as GatewayMethodParams<"kanbanUndo">, () =>
        notConfigured({ ok: false }, "Kanban is not available"),
      ),

    // —— 可选：未接线 → 合成默认（非 not_configured 形状） ——
    record_agent_status_message: p =>
      this.callOptional("recordAgentStatusMessage", p as GatewayMethodParams<"recordAgentStatusMessage">, () => ({
        recorded: false,
      })),
    active_turn_snapshot: p =>
      this.callOptional("getActiveTurnSnapshot", p as GatewayMethodParams<"getActiveTurnSnapshot">, params => ({
        active: false,
        sessionKey: (params as { sessionKey?: string } | undefined)?.sessionKey ?? "",
        events: [],
      })),
    reload_config: p =>
      this.callOptional("reloadConfig", p as GatewayMethodParams<"reloadConfig">, () => ({
        reloaded: false,
        reason: "unsupported",
      })),
    prepare_weixin_login: p =>
      this.callOptional("prepareWeixinLogin", p as GatewayMethodParams<"prepareWeixinLogin">, () => ({
        requested: false,
        requestedAt: new Date().toISOString(),
        reason: "unsupported",
      })),
    reload_extensions: p =>
      this.callOptional("reloadExtensions", p as GatewayMethodParams<"reloadExtensions">, () => ({
        reloaded: false,
        reason: "unsupported",
      })),

    // —— 可选但语义必填：未接线必须显式失败（调用方据结果做破坏性决策） ——
    close_project_sessions: p => {
      // 显式失败而非 not_configured 降级：调用方（项目删除）必须知道会话
      // 是否真的排空了，否则会在活跃写入器之下删文件。
      if (!this.options.gateway.closeProjectSessions) {
        throw new GatewayMethodUnavailableError("Project session closure is unavailable.");
      }
      return this.options.gateway.closeProjectSessions(p as GatewayMethodParams<"closeProjectSessions">);
    },

    // —— skill：可选方法经 requireSkillMethod 绑定（未接线抛结构化 SkillManagerError） ——
    skill_list: p => requireSkillMethod(this.options.gateway.skillsList, this.options.gateway)(p as never),
    skill_read: p => requireSkillMethod(this.options.gateway.skillRead, this.options.gateway)(p as never),
    skill_write: p => requireSkillMethod(this.options.gateway.skillWrite, this.options.gateway)(p as never),
    skill_create: p => requireSkillMethod(this.options.gateway.skillCreate, this.options.gateway)(p as never),
    skill_delete: p => requireSkillMethod(this.options.gateway.skillDelete, this.options.gateway)(p as never),
    skill_import: p => requireSkillMethod(this.options.gateway.skillImport, this.options.gateway)(p as never),
    skill_validate: p => requireSkillMethod(this.options.gateway.skillValidate, this.options.gateway)(p as never),
    skill_scan: p => requireSkillMethod(this.options.gateway.skillScan, this.options.gateway)(p as never),

    // —— kanban 订阅：走连接级 subscriber 与连接持有订阅的 manager ——
    kanban_subscribe: p => {
      const manager = this.options.kanban;
      if (!manager) {
        return Promise.resolve(notConfigured({ subscribed: false }, "Kanban is not available"));
      }
      const projectId = (p as { projectId?: string } | undefined)?.projectId;
      if (typeof projectId !== "string" || projectId === "") {
        throw new Error("kanban_subscribe requires projectId");
      }
      manager.subscribe(projectId, this.kanbanSubscriber);
      return Promise.resolve({ subscribed: true });
    },
    kanban_unsubscribe: p => {
      const manager = this.options.kanban;
      if (!manager) {
        return Promise.resolve(notConfigured({ unsubscribed: false }, "Kanban is not available"));
      }
      const projectId = (p as { projectId?: string } | undefined)?.projectId;
      if (typeof projectId !== "string" || projectId === "") {
        throw new Error("kanban_unsubscribe requires projectId");
      }
      manager.unsubscribe(projectId, this.kanbanSubscriber);
      return Promise.resolve({ unsubscribed: true });
    },

    // —— 特判外的方法 ——
    // submit_turn 由 handleRequest 事件流分支处理（16ms 缓冲 + final 帧），不进入本表；
    // 走到这里说明前置分支被破坏，语义对齐旧 switch default。
    submit_turn: () => {
      throw new Error("Unknown gateway method submit_turn.");
    },
  };

  private dispatchRequest(frame: WsRequestFrame): Promise<unknown> {
    // 表为 required Record，正常路径必有表项；undefined 分支只承接运行时传入 union
    // 之外的旧方法名，语义对齐旧 switch 的 default（抛 Unknown gateway method）。
    const dispatcher = this.methodDispatchers[frame.method as WsGatewayMethod] as
      | ((params: unknown) => Promise<unknown>)
      | undefined;
    if (dispatcher === undefined) {
      throw new Error(`Unknown gateway method ${(frame as { method?: string }).method}.`);
    }
    return dispatcher(frame.params);
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
