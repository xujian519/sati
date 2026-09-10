import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

/**
 * 转录读取失败必须显式 500（上游 #568）。用 `messages: []` 掩盖失败会让前端把
 * "读不出来"渲染成"没有消息"，用户在错误前提上继续操作。
 */
describe("messages routes", () => {
  it("session 转录读取失败 → 500 session_messages_read_failed，不返回空历史", async () => {
    const { request, logger } = await createMessagesApp({
      readSessionMessages: vi.fn(async () => {
        throw new Error("transcript unreadable");
      }),
    });

    const result = await request("/api/sessions/session-1/messages?projectPath=/tmp/project");

    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ error: { code: "session_messages_read_failed" } });
    expect(result.body).not.toHaveProperty("messages");
    expect(logger.error).toHaveBeenCalled();
  });

  it("subagent 转录读取失败 → 500 subagent_messages_read_failed，不返回空历史", async () => {
    const { request } = await createMessagesApp({
      readSubagentMessages: vi.fn(async () => {
        throw new Error("subagent transcript unreadable");
      }),
    });

    const result = await request("/api/sessions/session-1/subagent/sub-1/messages?projectPath=/tmp/project");

    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ error: { code: "subagent_messages_read_failed" } });
    expect(result.body).not.toHaveProperty("messages");
  });

  it("读取成功时照常返回消息（错误分支不得吞掉正常路径）", async () => {
    const { request } = await createMessagesApp({
      readSessionMessages: vi.fn(async () => ({
        messages: [
          {
            id: "entry-1",
            createdAt: "2026-09-10T10:00:00.000Z",
            provider: "sati",
            kind: "text",
            role: "assistant",
            text: "hello",
          },
        ],
        total: 1,
      })),
    });

    const result = await request("/api/sessions/session-1/messages?projectPath=/tmp/project");

    expect(result.status).toBe(200);
    expect(result.body.messages).toHaveLength(1);
    expect(result.body.messages[0]).toMatchObject({ kind: "text", content: "hello" });
  });
});

async function createMessagesApp(gatewayOverrides) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  vi.doMock("../utils/consoleLogger.js", () => ({ logger }));
  vi.doMock("../sati-bridge.js", () => ({
    getSatiGateway: vi.fn(async () => gatewayOverrides),
  }));

  const { default: messagesRoutes } = await import("./messages.js");
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", messagesRoutes);

  return {
    logger,
    request: (path, init) => requestJson(app, path, init),
  };
}

async function requestJson(app, path, init = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
      ...init,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
