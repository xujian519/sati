/**
 * `/ws` 的 edit-last-turn / regenerate-last-turn 流式帧投递判据（issue #411）。
 *
 * 判据：同一会话的**兄弟 watcher**必须收到这一轮的 `stream_delta`。两条 rewrite
 * 分支若把 gateway 流交给只回提交页的 `writer`，兄弟页会永远停在 `Processing`
 * ——同一份代码里乐观 user 行与 `Processing` 走广播（`broadcastRewriteOptimisticFrames`），
 * 回答流却只回提交页，是「半广播半私有」的可见界面错误。
 *
 * 这里用真实 HTTP + 真实 WS + 真实广播注册表；只替换 gateway 调用（帧本身是否带
 * `sessionId` 由 `sati-bridge.test.js` 的既有用例负责）。
 */
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

const SESSION_ID = "web:s_rewrite";
const USER = { id: 7, username: "tester" };
const ANSWER = "regenerated answer";

const openSockets = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) {
    socket.close();
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("/ws rewrite streaming frames", () => {
  it("delivers the answer stream of edit-last-turn to a sibling watcher", async () => {
    const harness = await startChatServer();
    try {
      const submitter = await harness.connect("submitter");
      const sibling = await harness.connect("sibling");

      sibling.send(JSON.stringify({ type: "watch-session", sessionId: SESSION_ID }));
      await harness.waitForWatchers(SESSION_ID, 1);

      submitter.send(
        JSON.stringify({
          type: "edit-last-turn",
          sessionId: SESSION_ID,
          text: "edited text",
          options: { projectPath: "/tmp/demo" },
        }),
      );

      await waitFor(() => sibling.frames.some(frame => frame.kind === "stream_delta"));

      expect(sibling.frames.find(frame => frame.kind === "stream_delta").content).toBe(ANSWER);
      // 提交页自己也要拿到回答流（广播不得以「排除了提交者」为代价）
      expect(submitter.frames.some(frame => frame.kind === "stream_delta")).toBe(true);
      // 兄弟页的乐观行与 Processing 仍在（回归：这条路径本来就在广播）
      expect(sibling.frames.some(frame => frame.kind === "text" && frame.role === "user")).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("delivers the answer stream of regenerate-last-turn to a sibling watcher", async () => {
    const harness = await startChatServer();
    try {
      const submitter = await harness.connect("submitter");
      const sibling = await harness.connect("sibling");

      sibling.send(JSON.stringify({ type: "watch-session", sessionId: SESSION_ID }));
      await harness.waitForWatchers(SESSION_ID, 1);

      submitter.send(
        JSON.stringify({
          type: "regenerate-last-turn",
          sessionId: SESSION_ID,
          options: { projectPath: "/tmp/demo" },
        }),
      );

      await waitFor(() => sibling.frames.some(frame => frame.kind === "stream_delta"));

      expect(sibling.frames.find(frame => frame.kind === "stream_delta").content).toBe(ANSWER);
    } finally {
      await harness.close();
    }
  });
});

async function startChatServer() {
  vi.resetModules();
  vi.doMock("../middleware/auth.js", () => ({ authenticateWebSocket: () => USER }));
  vi.doMock("./shell.js", () => ({ handleShellConnection: vi.fn() }));
  vi.doMock("../utils/plugin-process-manager.js", () => ({ getPluginPort: vi.fn(() => null) }));
  vi.doMock("../sati-bridge.js", () => ({
    abortViaGateway: vi.fn(async () => true),
    approvalDecideViaGateway: vi.fn(async () => ({})),
    decidePermissionViaGateway: vi.fn(async () => ({})),
    editLastTurnViaGateway: vi.fn(async () => ({ rewritten: true })),
    elicitationRespondViaGateway: vi.fn(async () => ({})),
    getActiveSessionIdsViaGateway: vi.fn(async () => []),
    getSessionActivityViaGateway: vi.fn(async () => ({})),
    getSessionTokenBudget: vi.fn(() => null),
    grantSessionPermissionViaGateway: vi.fn(async () => ({})),
    regenerateLastTurnViaGateway: vi.fn(async () => ({ rewritten: true, originalText: "original text" })),
    registerAlwaysOnNotificationForwarding: vi.fn(),
    registerKanbanNotificationForwarding: vi.fn(),
    gwKanbanSubscribe: vi.fn(async () => undefined),
    gwKanbanUnsubscribe: vi.fn(async () => undefined),
    // 把回答流按真实形态推给 handler 选定的 writer：帧带 sessionId，
    // 因此「投给谁」完全取决于 handler 交来的是 writer 还是 streamWriter。
    runChatViaGateway: vi.fn(async (command, options, writer) => {
      writer.send({ kind: "stream_delta", sessionId: SESSION_ID, content: ANSWER });
    }),
    steerViaGateway: vi.fn(async () => ({ delivered: true })),
  }));

  const { createChatWebSocketServer } = await import("./chat.js");
  const { sessionWatchRegistry } = await import("./broadcast.js");

  const server = createServer();
  const wss = createChatWebSocketServer(server);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    connect: label => connectClient(`ws://127.0.0.1:${port}/ws?token=test`, label),
    waitForWatchers: async (sessionId, expected) => {
      // `getWatchers()` 返回 Set（不是数组）
      await waitFor(() => sessionWatchRegistry.getWatchers(sessionId).size >= expected);
    },
    close: async () => {
      // 先断开客户端，否则 server.close() 会一直等这些连接（失败路径会伪装成
      // vitest 的 5s 用例超时，把真实断言失败藏起来）。
      for (const socket of openSockets.splice(0)) {
        socket.terminate();
      }
      wss.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function connectClient(url, label) {
  const socket = new WebSocket(url);
  openSockets.push(socket);
  const client = { label, frames: [], socket, send: payload => socket.send(payload) };
  socket.on("message", raw => {
    client.frames.push(JSON.parse(raw.toString()));
  });
  return new Promise((resolve, reject) => {
    socket.on("open", () => resolve(client));
    socket.on("error", reject);
  });
}

/** Poll until `predicate()` holds; fails loudly instead of hanging the suite. */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the expected frame");
}
