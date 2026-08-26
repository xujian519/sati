/**
 * ui/server 浏览器侧聊天 WebSocket 连接层（B4b 分片）。
 *
 * 从 ui/server/index.js 拆出（机械搬移，不改逻辑）：wss 创建 +
 * verifyClient 认证 + /ws 路由（chat）+ /plugin-ws/ 代理 +
 * WebSocketWriter + handleChatConnection。
 */

import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import { authenticateWebSocket } from "../middleware/auth.js";
import { DISABLE_LOCAL_AUTH, IS_PLATFORM } from "../constants/config.js";
import { getPluginPort } from "../utils/plugin-process-manager.js";
import { createNormalizedMessage } from "../sati-message.js";
import {
  abortViaGateway,
  approvalDecideViaGateway,
  decidePermissionViaGateway,
  elicitationRespondViaGateway,
  getActiveSessionIdsViaGateway,
  getSessionActivityViaGateway,
  getSessionTokenBudget,
  grantSessionPermissionViaGateway,
  runChatViaGateway,
} from "../sati-bridge.js";
import { handleShellConnection } from "./shell.js";
import {
  broadcastChatFrame,
  broadcastToSessionWatchers,
  connectedClients,
  kanbanUnwatchAll,
  kanbanUnwatchProject,
  kanbanWatchProject,
  normalizeSessionId,
  sessionWatchRegistry,
} from "./broadcast.js";

// M4：浏览器会话活跃表（Web 下线判定）——浏览器消息到达即刷新（按 ws 连接引用计数），
// 浏览器连接关闭即移除（精确下线信号：gateway 侧看不到浏览器关闭——浏览器流量经本
// relay 的共享 ws 连接转发，不触发 gateway onClose）。引用计数防多标签页同会话误删：
// 任一标签关闭不丢另个标签页的活跃性。由 team-presence 心跳聚合上报 gateway
// （panel_heartbeat → SessionPresence.panelTouch），gateway 侧超宽限窗判离线。
const browserSessionActivity = new Map(); // sessionKey -> Set<ws>

function touchBrowserSession(sessionKey, ws) {
  if (!sessionKey || !ws) return;
  let connections = browserSessionActivity.get(sessionKey);
  if (!connections) {
    connections = new Set();
    browserSessionActivity.set(sessionKey, connections);
  }
  connections.add(ws);
}

function untrackBrowserSessions(ws) {
  for (const [sessionKey, connections] of browserSessionActivity) {
    if (connections.delete(ws) && connections.size === 0) {
      browserSessionActivity.delete(sessionKey);
    }
  }
}

/** M4：当前活跃浏览器会话 key 快照（team-presence 心跳聚合用；浏览器全关即空表）。 */
export function getBrowserActiveKeys() {
  return [...browserSessionActivity.keys()];
}

export function createChatWebSocketServer(server) {
  const wss = new WebSocketServer({
    server,
    verifyClient: info => {
      console.log("WebSocket connection attempt to:", info.req.url);

      // Platform / no-login mode skips token validation; otherwise extract the
      // token from the query string or Authorization header.
      const bypass = IS_PLATFORM || DISABLE_LOCAL_AUTH;
      const token = bypass
        ? null
        : new URL(info.req.url, "http://localhost").searchParams.get("token") ||
          info.req.headers.authorization?.split(" ")[1];

      const user = authenticateWebSocket(token);
      if (!user) {
        console.log(`[WARN] WebSocket authentication failed${bypass ? " (bypass)" : ""}`);
        return false;
      }

      info.req.user = user;
      console.log(`[OK] WebSocket authenticated for user: ${user.username}`);
      return true;
    },
  });

  // WebSocket connection handler that routes based on URL path
  wss.on("connection", (ws, request) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    console.log("[INFO] Client connected to:", pathname);

    if (pathname === "/shell") {
      handleShellConnection(ws);
    } else if (pathname === "/ws") {
      handleChatConnection(ws, request);
    } else if (pathname.startsWith("/plugin-ws/")) {
      handlePluginWsProxy(ws, pathname);
    } else {
      console.log("[WARN] Unknown WebSocket path:", pathname);
      ws.close();
    }
  });

  return wss;
}

function handlePluginWsProxy(clientWs, pathname) {
  const pluginName = pathname.replace("/plugin-ws/", "");
  if (!pluginName || /[^a-zA-Z0-9_-]/.test(pluginName)) {
    clientWs.close(4400, "Invalid plugin name");
    return;
  }

  const port = getPluginPort(pluginName);
  if (!port) {
    clientWs.close(4404, "Plugin not running");
    return;
  }

  const upstream = new WebSocket(`ws://127.0.0.1:${port}/ws`);

  upstream.on("open", () => {
    console.log(`[Plugins] WS proxy connected to "${pluginName}" on port ${port}`);
  });

  // Relay messages bidirectionally
  upstream.on("message", data => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
  });
  clientWs.on("message", data => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
  });

  // Propagate close in both directions
  upstream.on("close", () => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });
  clientWs.on("close", () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
  });

  upstream.on("error", err => {
    console.error(`[Plugins] WS proxy error for "${pluginName}":`, err.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(4502, "Upstream error");
  });
  clientWs.on("error", () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
  });
}

/**
 * WebSocket Writer - Wrapper for WebSocket to match SSEStreamWriter interface
 *
 * Provider files use `createNormalizedMessage()` from `providers/types.js` and
 * adapter `normalizeMessage()` to produce unified NormalizedMessage events.
 * The writer simply serialises and sends.
 */
class WebSocketWriter {
  constructor(ws, userId = null) {
    this.ws = ws;
    this.sessionId = null;
    this.userId = userId;
    this.isWebSocketWriter = true; // Marker for transport detection
  }

  send(data) {
    const message = JSON.stringify(data);
    if (this.ws.readyState === 1) {
      // WebSocket.OPEN
      this.ws.send(message);
      return;
    }

    // A chat turn can outlive the browser WebSocket that submitted it
    // (refresh, reconnect, dev-client hiccup). Keep the gateway stream live
    // by handing subsequent frames to the user's replacement connection.
    connectedClients.forEach(client => {
      if (client.readyState !== 1) return; // WebSocket.OPEN
      if (client.__satiUserId !== this.userId) return;
      client.send(message);
    });
  }

  updateWebSocket(newRawWs) {
    this.ws = newRawWs;
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  getSessionId() {
    return this.sessionId;
  }
}

// Handle chat WebSocket connections
function handleChatConnection(ws, request) {
  console.log("[INFO] Chat WebSocket connected");

  // Add to connected clients for project updates
  const userId = request?.user?.id ?? request?.user?.userId ?? null;
  ws.__satiUserId = userId;
  connectedClients.add(ws);
  // Sati's cron manager lives inside `sati server`;
  // no legacy daemon lease is needed.
  let cleanedUp = false;

  // Wrap WebSocket with writer for consistent interface with SSEStreamWriter
  const writer = new WebSocketWriter(ws, userId);
  const streamWriter = {
    send: data => broadcastChatFrame(data, ws, userId),
  };

  ws.on("message", async message => {
    try {
      const data = JSON.parse(message);

      if (data.type === "ping") return;
      const requestSessionId = normalizeSessionId(data.sessionId);

      // M4：任何浏览器帧到达都刷新会话活跃（含 watch-session / 只读面板帧——
      // 面板停留不算离线）；连接关闭时在 cleanup 内 untrackBrowserSessions 移除。
      touchBrowserSession(requestSessionId, ws);

      if (data.type === "watch-session") {
        if (requestSessionId) {
          sessionWatchRegistry.watch(requestSessionId, ws);
        }
        return;
      }

      if (data.type === "unwatch-session") {
        if (requestSessionId) {
          sessionWatchRegistry.unwatch(requestSessionId, ws);
        }
        return;
      }

      if (data.type === "kanban-watch") {
        if (typeof data.projectId === "string" && data.projectId.trim()) {
          kanbanWatchProject(data.projectId, ws);
        }
        return;
      }

      if (data.type === "kanban-unwatch") {
        if (typeof data.projectId === "string" && data.projectId.trim()) {
          kanbanUnwatchProject(data.projectId, ws);
        }
        return;
      }

      if (
        data.type === "sati-command" ||
        // Deprecated: legacy per-provider frame types kept for back-compat.
        data.type === "claude-command" ||
        data.type === "cursor-command" ||
        data.type === "codex-command" ||
        data.type === "gemini-command"
      ) {
        console.log("[DEBUG] User message:", data.command || "[Continue/Resume]");
        console.log("📁 Project:", data.options?.projectPath || data.options?.cwd || "Unknown");
        console.log("🔄 Session:", data.options?.sessionId ? "Resume" : "New");
        const commandSessionId = normalizeSessionId(data.options?.sessionId || data.options?.sessionKey);
        // M4：sati-command 的会话 key 在 options 内（data.sessionId 可能缺省），单独刷新活跃
        if (commandSessionId) {
          touchBrowserSession(commandSessionId, ws);
          sessionWatchRegistry.watch(commandSessionId, ws);
          const userVisibleInput =
            typeof data.options?.userVisibleInput === "string" ? data.options.userVisibleInput.trim() : "";
          if (userVisibleInput) {
            const nowIso = new Date().toISOString();
            const provider = data.options?.providerHint || "sati";
            const optimisticUserFrame = createNormalizedMessage({
              id: `local_ws_user_${crypto.randomUUID()}`,
              sessionId: commandSessionId,
              provider,
              kind: "text",
              role: "user",
              content: userVisibleInput,
              ...(Array.isArray(data.options?.attachments) && data.options.attachments.length > 0
                ? { attachments: data.options.attachments }
                : {}),
              timestamp: nowIso,
            });
            const optimisticStatusFrame = createNormalizedMessage({
              id: `local_ws_status_${crypto.randomUUID()}`,
              sessionId: commandSessionId,
              provider,
              kind: "status",
              text: "Processing",
              canInterrupt: true,
              timestamp: nowIso,
            });
            // The submitting tab already rendered its optimistic user row.
            // Push only to sibling watchers so they mirror instantly.
            broadcastToSessionWatchers(commandSessionId, optimisticUserFrame, userId, ws);
            broadcastToSessionWatchers(commandSessionId, optimisticStatusFrame, userId, ws);
          }
        }
        const providerHint = data.options?.providerHint || data.type.replace("-command", "");
        await runChatViaGateway(data.command, data.options, streamWriter, providerHint);
      } else if (data.type === "abort-session") {
        console.log("[DEBUG] Abort session request:", data.sessionId);
        const provider = data.provider || "sati";
        const success = await abortViaGateway(data.sessionId, provider);
        writer.send(
          createNormalizedMessage({
            kind: "complete",
            exitCode: success ? 0 : 1,
            aborted: true,
            success,
            sessionId: data.sessionId,
            provider,
          }),
        );
      } else if (data.type === "permission-response") {
        if (data.requestId) {
          await decidePermissionViaGateway(data.requestId, data.allow ? "allow" : "deny", {
            remember: Boolean(data.rememberEntry),
            reason: data.message,
          });
          const resolvedSessionId = normalizeSessionId(data.sessionId);
          if (resolvedSessionId) {
            broadcastToSessionWatchers(
              resolvedSessionId,
              createNormalizedMessage({
                kind: "permission_cancelled",
                requestId: data.requestId,
                sessionId: resolvedSessionId,
                provider: data.provider || "sati",
              }),
              userId,
            );
          }
        }
      } else if (data.type === "approval-response") {
        // 输出门禁 HITL 审批：通过/拒绝一条挂起审批（verdict: adopted | rejected）。
        const verdict = data.verdict === "adopted" ? "adopted" : "rejected";
        const result = await approvalDecideViaGateway(
          data.sessionId,
          data.pendingIndex,
          verdict,
          typeof data.feedback === "string" ? data.feedback : undefined,
        );
        const resolvedSessionId = normalizeSessionId(data.sessionId);
        if (result?.delivered && resolvedSessionId) {
          // 通知同会话 watchers 移除审批卡片（乐观移除的兜底广播）。
          broadcastToSessionWatchers(
            resolvedSessionId,
            createNormalizedMessage({
              kind: "approval_resolved",
              pendingIndex: data.pendingIndex,
              verdict,
              sessionId: resolvedSessionId,
              provider: data.provider || "sati",
            }),
            userId,
          );
        }
      } else if (data.type === "session-permission-grant") {
        const result = await grantSessionPermissionViaGateway(data.sessionId, data.entry);
        ws.send(
          JSON.stringify({
            type: "session-permission-grant-result",
            requestId: typeof data.requestId === "string" ? data.requestId : null,
            sessionId: data.sessionId,
            entry: data.entry,
            granted: result.granted === true,
            ...(typeof result.entry === "string" ? { grantedEntry: result.entry } : {}),
          }),
        );
      } else if (data.type === "elicitation-response") {
        if (data.requestId) {
          await elicitationRespondViaGateway(data.requestId, data.answer);
          const resolvedSessionId = normalizeSessionId(data.sessionId);
          if (resolvedSessionId) {
            broadcastToSessionWatchers(
              resolvedSessionId,
              createNormalizedMessage({
                kind: "permission_cancelled",
                requestId: data.requestId,
                sessionId: resolvedSessionId,
                provider: data.provider || "sati",
              }),
              userId,
            );
          }
        }
      } else if (data.type === "check-session-status") {
        const sessionId = data.sessionId;
        if (normalizeSessionId(sessionId)) {
          sessionWatchRegistry.watch(sessionId, ws);
        }
        const provider = data.provider || "sati";
        const includeActiveTurnMessages = data.includeActiveTurnMessages !== false;
        // Gateway activity may be unavailable (disconnected, restarting). In
        // that case report unknown (`isProcessing: null`) instead of inactive
        // so the UI keeps the session in a synchronizing state rather than
        // cancelling running subagents or clearing the active run.
        const activity = await getSessionActivityViaGateway(sessionId, provider, includeActiveTurnMessages);
        writer.send({
          type: "session-status",
          sessionId,
          provider,
          isProcessing: activity.isProcessing,
          activeRunId: activity.activeRunId,
          activeTurnMessages: activity.activeTurnMessages,
          tokenBudget: getSessionTokenBudget(sessionId),
        });
      } else if (data.type === "get-pending-permissions") {
        // Pending-permission introspection is gateway-internal. The
        // permission_request event already contains everything the
        // UI needs, so the response is now an empty stub.
        writer.send({
          type: "pending-permissions-response",
          sessionId: data.sessionId,
          data: [],
        });
      } else if (data.type === "get-active-sessions") {
        const ids = getActiveSessionIdsViaGateway();
        // Keep the four-provider keys so the legacy UI store does
        // not need to change shape; everything routes through
        // Sati under the hood.
        writer.send({
          type: "active-sessions",
          sessions: { claude: ids, cursor: [], codex: [], gemini: [], sati: ids },
        });
      }
    } catch (error) {
      console.error("[ERROR] Chat WebSocket error:", error.message);
      writer.send({
        type: "error",
        error: error.message,
      });
    }
  });

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    // Remove from connected clients
    connectedClients.delete(ws);
    sessionWatchRegistry.removeClient(ws);
    // 看板：连接关闭时清理其查看的项目（防 gateway 订阅残留）
    kanbanUnwatchAll(ws);
    // M4：浏览器连接关闭 → 移除该连接跟踪的会话活跃（其他标签页的引用不受影响）
    untrackBrowserSessions(ws);
  };

  ws.on("close", (code, reason) => {
    const reasonText = reason?.toString?.() || "";
    console.log(`🔌 Chat client disconnected code=${code}${reasonText ? ` reason=${reasonText}` : ""}`);
    cleanup();
  });
  ws.on("error", () => {
    cleanup();
  });
}

// Handle shell WebSocket connections
