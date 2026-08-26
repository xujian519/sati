/**
 * Gateway 项目看板（Kanban）协议接线测试。
 *
 * 覆盖：
 * - InProcessGateway 直接方法调用与持久化
 * - 未注入 KanbanBoardManager 时返回 not_configured 降级
 * - WebSocket 订阅/取消订阅与 kanban_updated 通知风扇分发
 * - 多项目订阅隔离
 * - GatewayServer 未注入 kanban 时 feature-detect 降级
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { GatewayWsClient } from "../../src/gateway/client/GatewayWsClient.js";
import { KanbanBoardManager } from "../../src/gateway/kanban/KanbanBoardManager.js";
import { startGatewayServer } from "../../src/gateway/server/GatewayServer.js";
import type { KanbanUpdatedPayload } from "../../src/board/protocol/types.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";

function makeFakeRouter(): SessionRouter {
  return { sessionCount: () => 0 } as unknown as SessionRouter;
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "sati-kanban-gw-"));
  const manager = new KanbanBoardManager();
  const gateway = new InProcessGateway(makeFakeRouter(), {
    kanban: manager,
    serverInfo: { mode: "in_process", projectKey: root },
  });
  return { root, manager, gateway };
}

test("InProcessGateway：未注入 kanban 时返回 not_configured 降级", async () => {
  const gateway = new InProcessGateway(makeFakeRouter(), {});
  const getResult = await gateway.kanbanGet({ projectKey: "/proj" });
  assert.equal(getResult.error?.code, "not_configured");
  assert.deepEqual(getResult.columns, []);

  const addResult = await gateway.kanbanAddColumn({ projectKey: "/proj", title: "待办" });
  assert.equal(addResult.error?.code, "not_configured");
  assert.equal(addResult.column, null);

  const moveResult = await gateway.kanbanMoveCard({ projectKey: "/proj", cardId: "k1", columnId: "c1" });
  assert.equal(moveResult.error?.code, "not_configured");
  assert.equal(moveResult.ok, false);
});

test("InProcessGateway：kanban_get 返回默认三列", async () => {
  const { root, gateway } = await setup();
  try {
    const board = await gateway.kanbanGet({ projectKey: root });
    assert.equal(board.version, 1);
    assert.equal(board.columns.length, 3);
    assert.deepEqual(
      board.columns.map(c => c.title),
      ["待办", "进行中", "已完成"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("InProcessGateway：kanban_get 默认过滤回收站卡，includeArchived 则包含", async () => {
  const { root, gateway } = await setup();
  try {
    const board = await gateway.kanbanGet({ projectKey: root });
    const firstColId = board.columns[0]!.id;
    const added = await gateway.kanbanAddCard({ projectKey: root, columnId: firstColId, title: "任务 A" });
    await gateway.kanbanArchiveCard({ projectKey: root, cardId: added.card!.id });

    const active = await gateway.kanbanGet({ projectKey: root });
    assert.equal(active.cards.length, 0, "默认不含回收站卡片");

    const withArchived = await gateway.kanbanGet({ projectKey: root, includeArchived: true });
    assert.equal(withArchived.cards.length, 1, "includeArchived 时包含回收站卡片");
    assert.equal(withArchived.cards[0]!.id, added.card!.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("InProcessGateway：kanban_add_column / kanban_add_card 持久化并可再读", async () => {
  const { root, gateway } = await setup();
  try {
    const col = await gateway.kanbanAddColumn({ projectKey: root, title: "阻塞" });
    assert.equal(col.column?.title, "阻塞");

    const board = await gateway.kanbanGet({ projectKey: root });
    assert.equal(board.columns.length, 4);
    const addedColumn = board.columns.find(c => c.title === "阻塞");
    assert.ok(addedColumn);

    const firstColId = board.columns[0]!.id;
    const card = await gateway.kanbanAddCard({ projectKey: root, columnId: firstColId, title: "任务 A" });
    assert.equal(card.card?.title, "任务 A");

    const board2 = await gateway.kanbanGet({ projectKey: root });
    assert.equal(board2.cards.length, 1);
    assert.equal(board2.cards[0]!.columnId, firstColId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("InProcessGateway：kanban_undo 恢复到上一次保存状态", async () => {
  const { root, gateway } = await setup();
  try {
    const board = await gateway.kanbanGet({ projectKey: root });
    const firstColId = board.columns[0]!.id;
    await gateway.kanbanAddCard({ projectKey: root, columnId: firstColId, title: "任务 A" });
    const boardAfter = await gateway.kanbanGet({ projectKey: root });
    assert.equal(boardAfter.cards.length, 1);

    await gateway.kanbanUndo({ projectKey: root });
    const boardUndone = await gateway.kanbanGet({ projectKey: root });
    assert.equal(boardUndone.cards.length, 0);
    assert.deepEqual(
      boardUndone.columns.map(c => c.title),
      board.columns.map(c => c.title),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WebSocket：订阅后写操作触发 kanban_updated 通知", async () => {
  const { root, manager, gateway } = await setup();
  const server = await startGatewayServer({ gateway, port: 0, kanban: manager });
  const client = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: "test" });
  try {
    await client.connect();

    const notifications: KanbanUpdatedPayload[] = [];
    client.onNotification((name, payload) => {
      if (name === "kanban_updated") {
        notifications.push(payload as KanbanUpdatedPayload);
      }
    });

    const sub = await client.request<{ subscribed: boolean }>("kanban_subscribe", { projectId: root });
    assert.equal(sub.subscribed, true);

    const col = await client.request<{ column: { id: string } | null }>("kanban_add_column", {
      projectKey: root,
      title: "新增列",
    });
    assert.ok(col.column);

    // 通知为异步风扇分发，等待一次事件循环。
    await new Promise(r => setTimeout(r, 50));
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]!.projectId, root);
    assert.equal(notifications[0]!.kind, "column");
    assert.equal(notifications[0]!.columnId, col.column!.id);
  } finally {
    client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("WebSocket：订阅按 projectId 隔离", async () => {
  const rootA = await mkdtemp(join(tmpdir(), "sati-kanban-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "sati-kanban-b-"));
  const manager = new KanbanBoardManager();
  const gateway = new InProcessGateway(makeFakeRouter(), {
    kanban: manager,
    serverInfo: { mode: "in_process", projectKey: rootA },
  });
  const server = await startGatewayServer({ gateway, port: 0, kanban: manager });
  const client = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: "test" });
  try {
    await client.connect();

    const notifications: KanbanUpdatedPayload[] = [];
    client.onNotification((name, payload) => {
      if (name === "kanban_updated") {
        notifications.push(payload as KanbanUpdatedPayload);
      }
    });

    await client.request("kanban_subscribe", { projectId: rootA });
    await client.request("kanban_add_column", { projectKey: rootB, title: "B 列" });

    await new Promise(r => setTimeout(r, 50));
    assert.equal(notifications.length, 0, "订阅项目 A 时不应收到项目 B 的变更通知");

    await client.request("kanban_add_column", { projectKey: rootA, title: "A 列" });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]!.projectId, rootA);
  } finally {
    client.close();
    await server.close();
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("WebSocket：取消订阅后不再收到通知", async () => {
  const { root, manager, gateway } = await setup();
  const server = await startGatewayServer({ gateway, port: 0, kanban: manager });
  const client = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: "test" });
  try {
    await client.connect();

    const notifications: KanbanUpdatedPayload[] = [];
    client.onNotification((name, payload) => {
      if (name === "kanban_updated") {
        notifications.push(payload as KanbanUpdatedPayload);
      }
    });

    await client.request("kanban_subscribe", { projectId: root });
    await client.request("kanban_add_column", { projectKey: root, title: "列 1" });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(notifications.length, 1);

    const unsub = await client.request<{ unsubscribed: boolean }>("kanban_unsubscribe", { projectId: root });
    assert.equal(unsub.unsubscribed, true);

    await client.request("kanban_add_column", { projectKey: root, title: "列 2" });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(notifications.length, 1, "取消订阅后不应再收到通知");
  } finally {
    client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("WebSocket：未注入 kanban 时 kanban 方法返回 not_configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-kanban-nocfg-"));
  // gateway 与 GatewayServer 均未注入 kanban manager
  const gateway = new InProcessGateway(makeFakeRouter(), {});
  const server = await startGatewayServer({ gateway, port: 0 });
  const client = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: "test" });
  try {
    await client.connect();

    const result = await client.request<{ error?: { code: string }; column?: null }>("kanban_add_column", {
      projectKey: root,
      title: "列",
    });
    assert.equal(result.error?.code, "not_configured");
    assert.equal(result.column, null);
  } finally {
    client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("InProcessGateway：kanban_reorder_columns 重排列并持久化", async () => {
  const { root, gateway } = await setup();
  try {
    const board = await gateway.kanbanGet({ projectKey: root });
    const ids = board.columns.map(c => c.id);

    const result = await gateway.kanbanReorderColumns({ projectKey: root, columnIds: [...ids].reverse() });
    assert.equal(result.ok, true);

    const reloaded = await gateway.kanbanGet({ projectKey: root });
    assert.deepEqual(
      reloaded.columns.map(c => c.id),
      [...ids].reverse(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("InProcessGateway：kanban_reorder_columns 未注入 kanban 时 not_configured", async () => {
  const gateway = new InProcessGateway(makeFakeRouter(), {});
  const result = await gateway.kanbanReorderColumns({ projectKey: "/proj", columnIds: ["c1"] });
  assert.equal(result.error?.code, "not_configured");
  assert.equal(result.ok, false);
});
