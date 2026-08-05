import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GatewayBrowserClient, type WebSocketLike } from "../../src/web/client/GatewayBrowserClient.js";

const HELLO_OK = JSON.stringify({
  type: "hello_ok",
  protocolVersion: "1.0",
  serverVersion: "test",
  serverInfo: { version: "test" },
});

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

/**
 * Deterministic WebSocket-like double: open/message/close are driven by the
 * test, so we can interleave "old socket close" with "new socket hello" in
 * any order.
 */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    for (const listener of this.listeners.get("open") ?? []) listener({});
  }
  emitClose(code?: number, reason?: string): void {
    this.readyState = 3;
    for (const listener of this.listeners.get("close") ?? []) listener({ code, reason });
  }
  emitMessage(raw: string): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: raw });
  }
  emitError(): void {
    for (const listener of this.listeners.get("error") ?? []) listener({});
  }
}

function makeClient(): { client: GatewayBrowserClient; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  let id = 0;
  const client = new GatewayBrowserClient({
    url: "ws://localhost:1/ws",
    token: "test-token",
    clientName: "test",
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    newId: () => `id-${++id}`,
  });
  return { client, sockets };
}

/** Let the client's async connect() proceed past waitForOpen + listener registration. */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function connectClient(client: GatewayBrowserClient, sockets: FakeSocket[]): Promise<void> {
  const hello = client.connect();
  sockets[0]!.open();
  await tick();
  sockets[0]!.emitMessage(HELLO_OK);
  await hello;
  assert.equal(client.connected, true);
}

describe("GatewayBrowserClient.reconnect", () => {
  it("reconnect 成功后旧 socket 的延迟 close 事件不破坏新连接", async () => {
    const { client, sockets } = makeClient();
    await connectClient(client, sockets);

    // 断线（旧 socket close，模拟意外断线）
    sockets[0]!.emitClose(1006);
    assert.equal(client.connected, false);

    // 触发 reconnect：内部会 close 旧 socket 并打开新 socket（B）
    const reconnecting = client.reconnect();
    assert.equal(sockets.length, 2, "reconnect 应打开一个新 socket");

    // 关键时序：旧 socket 的 close 事件在新连接 hello 到达后才触发
    sockets[1]!.open();
    await tick();
    sockets[1]!.emitMessage(HELLO_OK);
    // 新连接已 hello_ok，此时旧 socket 的 close 事件才到达
    sockets[0]!.emitClose(1006, "stale");

    await reconnecting;
    assert.equal(client.connected, true, "旧 close 事件不得破坏新连接状态");

    // 新连接仍可正常发请求
    const pending = client.request("list_projects", {});
    sockets[1]!.emitMessage(JSON.stringify({ type: "response", id: "id-1", ok: true, result: { projects: [] } }));
    assert.deepEqual(await pending, { projects: [] });
  });

  it("旧 socket 的 close 事件在新连接 hello 之前到达也不会拒绝新 hello", async () => {
    const { client, sockets } = makeClient();
    await connectClient(client, sockets);

    sockets[0]!.emitClose(1006);

    const reconnecting = client.reconnect();
    // 新 socket 已创建但尚未 open/hello；旧 socket 的 close 事件此刻到达
    sockets[0]!.emitClose(1006, "stale-before-hello");

    sockets[1]!.open();
    await tick();
    sockets[1]!.emitMessage(HELLO_OK);
    await reconnecting;
    assert.equal(client.connected, true);
  });

  it("用户 close() 之后 reconnect 被拒绝", async () => {
    const { client, sockets } = makeClient();
    await connectClient(client, sockets);

    client.close();
    await assert.rejects(() => client.reconnect(), /closed by the user/);
  });

  it("意外断线触发 disconnect handlers；用户 close 不触发", async () => {
    const { client, sockets } = makeClient();
    await connectClient(client, sockets);

    const disconnects: Array<{ code?: number }> = [];
    client.onDisconnect(info => disconnects.push(info));

    sockets[0]!.emitClose(1011, "server error");
    assert.equal(disconnects.length, 1);
    assert.equal(disconnects[0]!.code, 1011);

    // 用户 close 不触发 disconnect handler
    client.close();
    assert.equal(disconnects.length, 1);
  });
});
