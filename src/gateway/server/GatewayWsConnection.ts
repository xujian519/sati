import type { Gateway } from "../protocol/types.js";
import type { WsHelloFrame, WsRequestFrame } from "../protocol/frames.js";
import { POLITDECK_GATEWAY_PROTOCOL_VERSION } from "../protocol/version.js";
import { TextWebSocketConnection } from "./websocket.js";

export type GatewayWsConnectionOptions = {
  gateway: Gateway;
  token: string;
  serverVersion: string;
};

export class GatewayWsConnection {
  private authed = false;

  constructor(
    private readonly ws: TextWebSocketConnection,
    private readonly options: GatewayWsConnectionOptions,
  ) {
    ws.onMessage((message) => void this.handleMessage(message));
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
    if (frame.protocolVersion !== POLITDECK_GATEWAY_PROTOCOL_VERSION) {
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
        protocolVersion: POLITDECK_GATEWAY_PROTOCOL_VERSION,
        serverVersion: this.options.serverVersion,
        serverInfo: await this.options.gateway.describeServer(),
      }),
    );
  }

  private async handleRequest(frame: WsRequestFrame): Promise<void> {
    try {
      if (frame.method === "submit_turn") {
        let seq = 0;
        for await (const event of this.options.gateway.submitTurn(frame.params as never)) {
          this.ws.sendText(JSON.stringify({ type: "event", id: frame.id, seq: seq++, final: false, event }));
        }
        this.ws.sendText(
          JSON.stringify({
            type: "event",
            id: frame.id,
            seq,
            final: true,
            event: { type: "turn_completed", usage: {}, finishReason: "completed" },
          }),
        );
        return;
      }

      const result = await this.dispatchRequest(frame);
      this.ws.sendText(JSON.stringify({ type: "response", id: frame.id, ok: true, result }));
    } catch (error) {
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
      case "describe_server":
        return this.options.gateway.describeServer();
      default:
        throw new Error(`Unknown gateway method ${(frame as { method?: string }).method}.`);
    }
  }
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
    isRecord(value) &&
    value.type === "request" &&
    typeof value.id === "string" &&
    typeof value.method === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
