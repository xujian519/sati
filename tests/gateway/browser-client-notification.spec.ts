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

describe("GatewayBrowserClient.onNotification", () => {
  it("notification 帧分发给已注册 handler（name + payload 原样透传）", async () => {
    const { client, sockets } = makeClient();
    await connectClient(client, sockets);

    const received: Array<{ name: string; payload: unknown }> = [];
    client.onNotification((name, payload) => received.push({ name, payload }));

    const payload = { sessionKey: "s-1", channelKey: "web", event: { type: "turn_started", runId: "r-1" } };
    sockets[0]!.emitMessage(JSON.stringify({ type: "notification", name: "always-on:turn-event", payload }));

    assert.equal(received.length, 1);
    assert.equal(received[0]!.name, "always-on:turn-event");
    assert.deepEqual(received[0]!.payload, payload);
  });

  it("payload 缺省时以 undefined 分发；多个 handler 全部收到", async () => {
    const { client, sockets } = makeClient();
    await connectClient(client, sockets);

    const a: Array<{ name: string; payload: unknown }> = [];
    const b: Array<{ name: string; payload: unknown }> = [];
    client.onNotification((name, payload) => a.push({ name, payload }));
    client.onNotification((name, payload) => b.push({ name, payload }));

    sockets[0]!.emitMessage(JSON.stringify({ type: "notification", name: "worktree_removed" }));

    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0]!.payload, undefined);
  });

  it("notification 帧不影响 request/response 与 event 流的正常分发", async () => {
    const { client, sockets } = makeClient();
    await connectClient(client, sockets);

    client.onNotification(() => {});
    const pending = client.request("list_projects", {});
    sockets[0]!.emitMessage(JSON.stringify({ type: "notification", name: "config_changed", payload: {} }));
    sockets[0]!.emitMessage(JSON.stringify({ type: "response", id: "id-1", ok: true, result: { projects: [] } }));
    assert.deepEqual(await pending, { projects: [] });
  });

  it("重连后 handler 列表存活，新连接上的通知仍可收到", async () => {
    const { client, sockets } = makeClient();
    await connectClient(client, sockets);

    const received: string[] = [];
    client.onNotification(name => received.push(name));

    sockets[0]!.emitClose(1006);
    const reconnecting = client.reconnect();
    sockets[1]!.open();
    await tick();
    sockets[1]!.emitMessage(HELLO_OK);
    await reconnecting;

    sockets[1]!.emitMessage(JSON.stringify({ type: "notification", name: "config_changed", payload: {} }));
    assert.deepEqual(received, ["config_changed"]);
  });

  it("unsubscribe 后不再收到通知，且不影响其他 handler", async () => {
    const { client, sockets } = makeClient();
    await connectClient(client, sockets);

    const kept: string[] = [];
    const removed: string[] = [];
    const unsubscribe = client.onNotification(name => removed.push(name));
    client.onNotification(name => kept.push(name));

    sockets[0]!.emitMessage(JSON.stringify({ type: "notification", name: "config_changed", payload: {} }));
    assert.deepEqual(removed, ["config_changed"]);
    assert.deepEqual(kept, ["config_changed"]);

    unsubscribe();
    sockets[0]!.emitMessage(JSON.stringify({ type: "notification", name: "worktree_removed", payload: {} }));
    assert.deepEqual(removed, ["config_changed"]);
    assert.deepEqual(kept, ["config_changed", "worktree_removed"]);
  });
});
