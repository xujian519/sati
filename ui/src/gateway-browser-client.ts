export type GatewayEvent =
  | { type: "turn_started"; runId: string }
  | { type: "assistant_text_delta"; text: string }
  | { type: "assistant_thinking_delta"; text: string }
  | { type: "tool_call_started"; toolCallId: string; name: string; argsPreview?: string }
  | { type: "tool_call_finished"; toolCallId: string; ok: boolean; resultPreview?: string }
  | { type: "permission_request"; requestId: string; toolName: string; payload: unknown }
  | { type: "structured_output"; payload: unknown }
  | { type: "plan_mode_changed"; mode: string }
  | { type: "turn_completed"; usage: Record<string, number>; finishReason: string }
  | { type: "error"; message: string; code?: string; recoverable: boolean };

export type GatewaySubmitTurnInput = {
  sessionKey: string;
  channelKey: "web";
  message: string;
  projectKey?: string;
};

export class GatewayBrowserClient {
  private ws?: WebSocket;
  private streams = new Map<string, (event: GatewayEvent, final: boolean) => void>();

  constructor(private readonly options: { url: string; token: string }) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.options.url);
    await new Promise<void>((resolve, reject) => {
      this.ws!.addEventListener("open", () => resolve(), { once: true });
      this.ws!.addEventListener("error", () => reject(new Error("failed to connect")), { once: true });
    });
    this.ws.addEventListener("message", (event) => this.handleMessage(String(event.data ?? "")));
    this.ws.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: "1.0",
        clientName: "web",
        clientVersion: "0.1.0",
        token: this.options.token,
      }),
    );
  }

  submitTurn(input: GatewaySubmitTurnInput, onEvent: (event: GatewayEvent) => void): void {
    const id = crypto.randomUUID();
    this.streams.set(id, (event, final) => {
      if (!final) onEvent(event);
      else this.streams.delete(id);
    });
    this.ws?.send(JSON.stringify({ type: "request", id, method: "submit_turn", params: input }));
  }

  private handleMessage(raw: string): void {
    const frame = JSON.parse(raw) as { type: string; id?: string; event?: GatewayEvent; final?: boolean };
    if (frame.type !== "event" || !frame.id || !frame.event) return;
    this.streams.get(frame.id)?.(frame.event, frame.final === true);
  }
}

export async function readLocalToken(): Promise<string> {
  const response = await fetch("/auth/local-token");
  const body = (await response.json()) as { token: string };
  return body.token;
}
