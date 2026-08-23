import { randomUUID } from "node:crypto";
import type { GatewayEvent } from "../protocol/types.js";
import type {
  GatewayWsClientName,
  WsEventFrame,
  WsGatewayMethod,
  WsHelloOk,
  WsNotificationFrame,
  WsResponseFrame,
} from "../protocol/frames.js";
import { SATI_GATEWAY_PROTOCOL_VERSION } from "../protocol/version.js";
import { APP_VERSION } from "../../version.js";

export type GatewayWsNotificationHandler = (name: string, payload: unknown) => void;

/**
 * Structured error preserving the server-side `code` (e.g.
 * `conflict`, `invalid_slug`, `not_found`, `validation_failed`) and
 * any extra payload like the validation report. Hosts use the `code`
 * to map back to UI affordances (HTTP status codes, retry hints,
 * etc.) instead of pattern-matching on the human-readable `message`.
 *
 * Plain `Error` is still thrown for transport-level failures (WS
 * closed, hello timeout, etc.) so callers can distinguish "the
 * gateway said no" from "the gateway is unreachable".
 */
export class GatewayRequestError extends Error {
  public readonly validation?: unknown;
  constructor(
    public readonly code: string,
    message: string,
    extra?: { validation?: unknown },
  ) {
    super(message);
    this.name = "GatewayRequestError";
    if (extra?.validation !== undefined) {
      this.validation = extra.validation;
    }
  }
}

export type GatewayWsClientOptions = {
  url: string;
  token: string;
  clientName?: GatewayWsClientName;
  clientVersion?: string;
  protocolVersion?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class GatewayWsClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly streams = new Map<string, AsyncEventQueue<GatewayEvent>>();
  private readonly notificationHandlers: GatewayWsNotificationHandler[] = [];
  private ws?: WebSocket;
  /** 当前 socket 上注册的监听器引用（重连/关闭时显式摘除，防旧 socket 事件污染新连接）。 */
  private wsHandlers?: { onMessage: (event: MessageEvent) => void; onClose: () => void };
  private hello?: WsHelloOk;

  constructor(private readonly options: GatewayWsClientOptions) {}

  onNotification(handler: GatewayWsNotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  async connect(): Promise<WsHelloOk> {
    // 重连安全：先摘除旧 socket 监听器、拒绝其挂起请求/流，再关旧 socket。
    // 若直接复用旧 socket 的 close 回调，旧连接的关闭事件会错误地拒绝新连接
    // 的 pending 请求（pending/streams 为实例共享状态）。
    if (this.ws) {
      this.resetConnection("Gateway connection replaced by reconnect.");
    } else {
      this.detachSocketListeners();
    }
    this.hello = undefined; // 新连接需重新握手，避免旧 hello 提前结束新 connect() 的等待

    const ws = new WebSocket(this.options.url);
    this.ws = ws;
    await waitForOpen(ws);
    const onMessage = (event: MessageEvent) => this.handleMessage(String(event.data ?? ""));
    const onClose = () => this.closePending(new Error("Gateway WebSocket closed."));
    this.wsHandlers = { onMessage, onClose };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    ws.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: this.options.protocolVersion ?? SATI_GATEWAY_PROTOCOL_VERSION,
        clientName: this.options.clientName ?? "cli",
        clientVersion: this.options.clientVersion ?? APP_VERSION,
        token: this.options.token,
      }),
    );

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("Gateway hello timed out."));
        }
      }, 10_000);

      const onClose = (event: CloseEvent) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          const reason = event.reason || `code ${event.code}`;
          reject(new Error(`Gateway closed during hello: ${reason}`));
        }
      };
      ws.addEventListener("close", onClose, { once: true });

      const onHello = () => {
        if (settled) return;
        if (this.hello) {
          settled = true;
          clearTimeout(timeout);
          ws.removeEventListener("close", onClose);
          resolve(this.hello);
        } else {
          setTimeout(onHello, 50);
        }
      };
      onHello();
    });
  }

  request<T = unknown>(method: WsGatewayMethod, params: unknown): Promise<T> {
    const id = randomUUID();
    this.send({ type: "request", id, method, params });
    return new Promise<T>((resolve, reject) => {
      // resolve 期望 T，而 PendingRequest 统一按 unknown 存储；这里只做参数位置的
      // 逆变标注（运行时语义不变），调用侧得以按 method 精确回推返回类型。
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
  }

  stream(method: WsGatewayMethod, params: unknown): AsyncIterable<GatewayEvent> {
    const id = randomUUID();
    const queue = new AsyncEventQueue<GatewayEvent>();
    this.streams.set(id, queue);
    this.send({ type: "request", id, method, params });
    return queue;
  }

  close(): void {
    this.resetConnection("Gateway WebSocket closed.");
  }

  /** 摘除当前 socket 的监听器并关闭连接；挂起请求/流以 reason 失败（确定性收尾，不依赖 close 事件送达）。 */
  private resetConnection(reason: string): void {
    this.detachSocketListeners();
    this.closePending(new Error(reason));
    const ws = this.ws;
    this.ws = undefined;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close();
    }
  }

  private detachSocketListeners(): void {
    if (this.ws && this.wsHandlers) {
      this.ws.removeEventListener("message", this.wsHandlers.onMessage);
      this.ws.removeEventListener("close", this.wsHandlers.onClose);
    }
    this.wsHandlers = undefined;
  }

  private send(frame: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway WebSocket is not connected.");
    }
    this.ws.send(JSON.stringify(frame));
  }

  private handleMessage(message: string): void {
    const frame = JSON.parse(message) as WsHelloOk | WsResponseFrame | WsEventFrame | WsNotificationFrame;
    if (frame.type === "hello_ok") {
      this.hello = frame;
      return;
    }
    if (frame.type === "notification") {
      for (const handler of this.notificationHandlers) {
        try {
          handler(frame.name, frame.payload);
        } catch {
          /* notification handlers must not crash the client */
        }
      }
      return;
    }
    if (frame.type === "response") {
      const pending = this.pending.get(frame.id);
      if (!pending) {
        return;
      }
      this.pending.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.result);
      } else {
        // Preserve the structured error envelope. The legacy contract
        // was `Error(message)`; we now also carry `code` and any extra
        // payload (e.g. `validation` for SkillValidationError) so
        // hosts can route on a stable identifier instead of parsing
        // the message string.
        const envelope = frame.error as { code?: string; message?: string; validation?: unknown };
        pending.reject(
          new GatewayRequestError(
            envelope.code ?? "gateway_request_failed",
            envelope.message ?? "Gateway request failed.",
            envelope.validation !== undefined ? { validation: envelope.validation } : undefined,
          ),
        );
      }
      return;
    }
    if (frame.type === "event") {
      const stream = this.streams.get(frame.id);
      if (!stream) {
        return;
      }
      if (!frame.final) {
        stream.push(frame.event);
        return;
      }
      this.streams.delete(frame.id);
      stream.close();
    }
  }

  private closePending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const stream of this.streams.values()) {
      stream.fail(error);
    }
    this.streams.clear();
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  private error?: Error;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: Error): void {
    this.error = error;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.error) {
      return Promise.reject(this.error);
    }
    const value = this.values.shift();
    if (value) {
      return Promise.resolve({ done: false, value });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("Failed to connect to gateway WebSocket.")), { once: true });
  });
}
