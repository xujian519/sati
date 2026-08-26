/**
 * ui/server WebSocket 广播状态中枢（B2 分片）。
 *
 * 从 ui/server/index.js 拆出（机械搬移，不改逻辑）：connectedClients +
 * sessionWatchRegistry 是 chat 连接 / 广播 / always-on 转发 / projects-watcher
 * 四方的共享状态，本模块作为**单一来源**（严禁反向 import chat/watcher，
 * 否则出现两份状态导致广播丢失/重复）。
 */

import { WebSocket } from "ws";
import { createSessionWatchRegistry } from "../session-watch-registry.js";
import {
  registerAlwaysOnNotificationForwarding,
  registerKanbanNotificationForwarding,
  gwKanbanSubscribe,
  gwKanbanUnsubscribe,
} from "../sati-bridge.js";

/** 所有已连接的浏览器侧 WS 客户端（chat 连接层 add/delete）。 */
const connectedClients = new Set();
/** 会话 watch 注册表（chat 连接层 watch/unwatch）。 */
const sessionWatchRegistry = createSessionWatchRegistry();

registerAlwaysOnNotificationForwarding(connectedClients, (sessionId, frame) => {
  // Always-On gateway notifications do not carry the originating UI socket.
  // Delivering them to every tab caused unrelated sessions' live status
  // (notably compaction progress) to race in the frontend. A tab explicitly
  // watches its displayed session, so that registry is the routing authority.
  broadcastToSessionWatchers(sessionId, frame, undefined);
});

/**
 * 项目看板（Kanban）watcher 注册表（Phase 5）：projectId → 正在查看该项目看板的
 * 浏览器 ws 连接。看板是项目级、不随会话变，因此 fanout 以 projectId 为键而非
 * session watch 注册表。浏览器连接关闭时经 kanbanUnwatchAll 清理，避免内存泄漏与
 * gateway 侧订阅残留。
 *
 * gateway 订阅（kanban_subscribe）在第 0 个 watcher 加入时发起、第 0 个离开时取消；
 * 共享 gateway 连接只推送一次事件，再由本表 fanout 到所有 watchers。
 */
const kanbanProjectWatchers = new Map(); // projectId -> Set<ws>

function kanbanWatchers(projectId) {
  let set = kanbanProjectWatchers.get(projectId);
  if (!set) {
    set = new Set();
    kanbanProjectWatchers.set(projectId, set);
  }
  return set;
}

/** 浏览器 ws 开始查看某项目的看板；首个 watcher 触发 gateway kanban_subscribe。 */
function kanbanWatchProject(projectId, ws) {
  const set = kanbanWatchers(projectId);
  const wasFirst = set.size === 0;
  set.add(ws);
  if (wasFirst) {
    gwKanbanSubscribe(projectId).catch(err => {
      console.warn("[sati-bridge] kanban_subscribe 失败:", err?.message || err);
    });
  }
}

/** 浏览器 ws 离开某项目的看板；最后一个 watcher 离开触发 gateway kanban_unsubscribe。 */
function kanbanUnwatchProject(projectId, ws) {
  const set = kanbanProjectWatchers.get(projectId);
  if (!set) return;
  const wasLast = set.size === 1;
  set.delete(ws);
  if (set.size === 0) {
    kanbanProjectWatchers.delete(projectId);
  }
  if (wasLast) {
    gwKanbanUnsubscribe(projectId).catch(err => {
      console.warn("[sati-bridge] kanban_unsubscribe 失败:", err?.message || err);
    });
  }
}

/** ws 连接关闭时清理其查看的所有看板项目（防泄漏/订阅残留）。 */
function kanbanUnwatchAll(ws) {
  for (const [projectId, set] of kanbanProjectWatchers) {
    if (set.delete(ws) && set.size === 0) {
      kanbanProjectWatchers.delete(projectId);
      gwKanbanUnsubscribe(projectId).catch(err => {
        console.warn("[sati-bridge] kanban_unsubscribe 失败:", err?.message || err);
      });
    }
  }
}

registerKanbanNotificationForwarding(connectedClients, (projectId, payload) => {
  const frame = { type: "kanban_updated", payload };
  const set = kanbanProjectWatchers.get(projectId);
  if (!set || set.size === 0) return;
  const message = JSON.stringify(frame);
  for (const client of set) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
});

function normalizeSessionId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function broadcastChatFrame(frame, originWs, userId) {
  const payload = JSON.stringify(frame);
  const delivered = new Set();
  const frameSessionId = normalizeSessionId(frame?.sessionId);

  if (frameSessionId) {
    const watchers = sessionWatchRegistry.getWatchers(frameSessionId);
    watchers.forEach(client => {
      if (client.readyState !== WebSocket.OPEN) return;
      if ((client.__satiUserId ?? null) !== userId) return;
      client.send(payload);
      delivered.add(client);
    });
  }

  if (originWs.readyState === WebSocket.OPEN && !delivered.has(originWs)) {
    originWs.send(payload);
    delivered.add(originWs);
  }

  // Reconnect fail-safe: if the origin websocket closed and no watcher
  // received the frame yet, fan out to same-user sockets.
  if (delivered.size === 0) {
    connectedClients.forEach(client => {
      if (client.readyState !== WebSocket.OPEN) return;
      if ((client.__satiUserId ?? null) !== userId) return;
      client.send(payload);
    });
  }
}

function broadcastToSessionWatchers(sessionId, frame, userId, excludeWs = null) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return;
  const payload = JSON.stringify(frame);
  const watchers = sessionWatchRegistry.getWatchers(normalizedSessionId);
  watchers.forEach(client => {
    if (client === excludeWs) return;
    if (client.readyState !== WebSocket.OPEN) return;
    // `undefined` denotes a gateway-originated event with no submitting
    // user. Its recipient set is already constrained by the session watch.
    if (userId !== undefined && (client.__satiUserId ?? null) !== userId) return;
    client.send(payload);
  });
}

// Broadcast progress to all connected WebSocket clients
function broadcastProgress(progress) {
  const message = JSON.stringify({
    type: "loading_progress",
    ...progress,
  });
  connectedClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Broadcasts ~/.sati/sati.yaml reload events (from UI saves or external file edits)
// to every connected WebSocket client so open Settings tabs refresh instantly.
function broadcastConfigReloaded(payload) {
  const message = JSON.stringify({ type: "config:reloaded", ...payload });
  connectedClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}
process.on("sati:config-broadcast", broadcastConfigReloaded);

export {
  connectedClients,
  sessionWatchRegistry,
  normalizeSessionId,
  broadcastChatFrame,
  broadcastToSessionWatchers,
  broadcastProgress,
  broadcastConfigReloaded,
  kanbanWatchProject,
  kanbanUnwatchProject,
  kanbanUnwatchAll,
};
