import type { Gateway, GatewayEvent } from "../protocol/types.js";
import type { WsHelloFrame, WsRequestFrame } from "../protocol/frames.js";
import { SATI_GATEWAY_PROTOCOL_VERSION, isProtocolCompatible } from "../protocol/version.js";
import { SkillManagerError, SkillValidationError } from "../../extension/skills/index.js";
import { TextWebSocketConnection } from "./websocket.js";

export type GatewayWsConnectionOptions = {
  gateway: Gateway;
  token: string;
  serverVersion: string;
};

export class GatewayWsConnection {
  private authed = false;
  private readonly inFlightSessions = new Set<string>();
  /** submit_turn 事件流发送缓冲：16ms 窗口合并，减少长轮次数千事件的 write/syscall。 */
  private readonly pendingTexts: string[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly FLUSH_INTERVAL_MS = 16;

  constructor(
    private readonly ws: TextWebSocketConnection,
    private readonly options: GatewayWsConnectionOptions,
  ) {
    ws.onMessage(message => void this.handleMessage(message));
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
      if (frame.method === "submit_turn") {
        const sessionKey = (frame.params as { sessionKey?: string } | undefined)?.sessionKey;
        if (sessionKey) this.inFlightSessions.add(sessionKey);
        let seq = 0;
        let lastCompleted: GatewayEvent | undefined;
        try {
          for await (const event of this.options.gateway.submitTurn(frame.params as never)) {
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
        return this.options.gateway.abortTurn(frame.params as never).then(() => ({ ok: true }));
      case "list_sessions":
        return this.options.gateway.listSessions(frame.params as never);
      case "resume_session":
        return this.options.gateway.resumeSession(frame.params as never);
      case "new_session":
        return this.options.gateway.newSession(frame.params as never);
      case "close_session":
        return this.options.gateway.closeSession(frame.params as never).then(() => ({ ok: true }));
      case "record_agent_status_message":
        if (this.options.gateway.recordAgentStatusMessage) {
          return this.options.gateway.recordAgentStatusMessage(frame.params as never);
        }
        return Promise.resolve({ recorded: false });
      case "describe_server":
        return this.options.gateway.describeServer();
      case "active_turn_snapshot":
        if (this.options.gateway.getActiveTurnSnapshot) {
          return this.options.gateway.getActiveTurnSnapshot(frame.params as never);
        }
        return Promise.resolve({
          active: false,
          sessionKey: (frame.params as { sessionKey?: string } | undefined)?.sessionKey ?? "",
          events: [],
        });
      case "cron_create":
        return this.options.gateway.cronCreate(frame.params as never);
      case "cron_list":
        return this.options.gateway.cronList(frame.params as never);
      case "cron_delete":
        return this.options.gateway.cronDelete(frame.params as never);
      case "cron_stop":
        return this.options.gateway.cronStop(frame.params as never);
      case "cron_run_now":
        return this.options.gateway.cronRunNow(frame.params as never);
      case "elicitation_respond":
        return this.options.gateway.respondElicitation(frame.params as never);
      case "permission_decide":
        return this.options.gateway.permissionDecide(frame.params as never);
      case "grant_session_permission":
        return this.options.gateway.grantSessionPermission(frame.params as never);
      case "read_session_messages":
        return this.options.gateway.readSessionMessages(frame.params as never);
      case "read_subagent_messages":
        return this.options.gateway.readSubagentMessages(frame.params as never);
      case "fork_session":
        return this.options.gateway.forkSession(frame.params as never);
      case "list_projects":
        return this.options.gateway.listProjects();
      case "describe_project":
        return this.options.gateway.describeProject(frame.params as never);
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
          return this.options.gateway.reloadExtensions(frame.params as never);
        }
        return Promise.resolve({ reloaded: false, reason: "unsupported" });
      case "skill_list":
        return requireSkillMethod(this.options.gateway.skillsList, this.options.gateway)(frame.params as never);
      case "skill_read":
        return requireSkillMethod(this.options.gateway.skillRead, this.options.gateway)(frame.params as never);
      case "skill_write":
        return requireSkillMethod(this.options.gateway.skillWrite, this.options.gateway)(frame.params as never);
      case "skill_create":
        return requireSkillMethod(this.options.gateway.skillCreate, this.options.gateway)(frame.params as never);
      case "skill_delete":
        return requireSkillMethod(this.options.gateway.skillDelete, this.options.gateway)(frame.params as never);
      case "skill_import":
        return requireSkillMethod(this.options.gateway.skillImport, this.options.gateway)(frame.params as never);
      case "skill_validate":
        return requireSkillMethod(this.options.gateway.skillValidate, this.options.gateway)(frame.params as never);
      case "skill_scan":
        return requireSkillMethod(this.options.gateway.skillScan, this.options.gateway)(frame.params as never);
      case "always_on_apply":
        if (this.options.gateway.alwaysOnApply) {
          return this.options.gateway.alwaysOnApply(frame.params as never);
        }
        return Promise.resolve({
          sessionKey: "",
          error: { code: "not_configured", message: "Always-On apply not available" },
        });
      case "always_on_rerun_plan":
        if (this.options.gateway.alwaysOnRerunPlan) {
          return this.options.gateway.alwaysOnRerunPlan(frame.params as never);
        }
        return Promise.resolve({
          runId: "",
          error: { code: "not_configured", message: "Always-On rerun not available" },
        });
      case "always_on_list_plans":
        if (this.options.gateway.alwaysOnListPlans) {
          return this.options.gateway.alwaysOnListPlans(frame.params as never);
        }
        return Promise.resolve({
          plans: [],
          error: { code: "not_configured", message: "Always-On plans list not available" },
        });
      case "always_on_read_report":
        if (this.options.gateway.alwaysOnReadReport) {
          return this.options.gateway.alwaysOnReadReport(frame.params as never);
        }
        return Promise.resolve({
          content: "",
          error: { code: "not_configured", message: "Always-On report not available" },
        });
      case "always_on_list_cycles":
        if (this.options.gateway.alwaysOnListCycles) {
          return this.options.gateway.alwaysOnListCycles(frame.params as never);
        }
        return Promise.resolve({
          cycles: [],
          error: { code: "not_configured", message: "Always-On cycles list not available" },
        });
      case "always_on_archive_cycle":
        if (this.options.gateway.alwaysOnArchiveCycle) {
          return this.options.gateway.alwaysOnArchiveCycle(frame.params as never);
        }
        return Promise.resolve({
          archived: false,
          error: { code: "not_configured", message: "Always-On archive not available" },
        });
      case "always_on_apply_cycle":
        if (this.options.gateway.alwaysOnApplyCycle) {
          return this.options.gateway.alwaysOnApplyCycle(frame.params as never);
        }
        return Promise.resolve({
          cycle: null,
          error: { code: "not_configured", message: "Always-On apply not available" },
        });
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
