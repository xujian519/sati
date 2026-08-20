import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("teams panel routes", () => {
  it("POST /panel forwards to gateway.teamPanelSnapshot and returns teams", async () => {
    const gateway = {
      teamPanelSnapshot: vi.fn(async () => ({
        teams: [
          {
            id: "team-1",
            name: "专利检索组",
            captainSessionKey: "web:s_captain",
            captainOnline: true,
            members: [],
            tasks: [],
            unreadForCaptain: 0,
          },
        ],
      })),
    };
    const { request } = await createTeamsApp(gateway);

    const { status, body } = await request("/api/teams/panel", {
      method: "POST",
      body: JSON.stringify({ sessionKey: "web:s_captain" }),
    });

    expect(status).toBe(200);
    expect(body.teams).toHaveLength(1);
    expect(body.teams[0].name).toBe("专利检索组");
    expect(gateway.teamPanelSnapshot).toHaveBeenCalledWith({ sessionKey: "web:s_captain" });
  });

  it("POST /action forwards team_tool_call input and returns data", async () => {
    const gateway = {
      teamToolCall: vi.fn(async ({ input }) => ({
        ok: true,
        data: { reassigned: true, taskId: input.taskId },
      })),
    };
    const { request } = await createTeamsApp(gateway);

    const { status, body } = await request("/api/teams/action", {
      method: "POST",
      body: JSON.stringify({
        tool: "team_reassign_task",
        input: { taskId: "task-9", assigneeId: "member-2" },
        sessionKey: "web:s_captain",
      }),
    });

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, data: { reassigned: true, taskId: "task-9" } });
    expect(gateway.teamToolCall).toHaveBeenCalledWith({
      tool: "team_reassign_task",
      input: { taskId: "task-9", assigneeId: "member-2" },
      sessionKey: "web:s_captain",
    });
  });

  it("POST /action rejects missing tool/input with 400", async () => {
    const gateway = { teamToolCall: vi.fn() };
    const { request } = await createTeamsApp(gateway);

    const { status, body } = await request("/api/teams/action", {
      method: "POST",
      body: JSON.stringify({ tool: "team_reassign_task" }),
    });

    expect(status).toBe(400);
    expect(body).toEqual({ ok: false, error: { code: "invalid_request", message: "tool/input 必填" } });
    expect(gateway.teamToolCall).not.toHaveBeenCalled();
  });

  it("POST /heartbeat forwards sessionKeys to gateway.panelHeartbeat", async () => {
    const gateway = {
      panelHeartbeat: vi.fn(async ({ sessionKeys }) => ({ touched: sessionKeys.length })),
    };
    const { request } = await createTeamsApp(gateway);

    const { status, body } = await request("/api/teams/heartbeat", {
      method: "POST",
      body: JSON.stringify({ sessionKeys: ["web:s_a", "web:s_b"] }),
    });

    expect(status).toBe(200);
    expect(body).toEqual({ touched: 2 });
    expect(gateway.panelHeartbeat).toHaveBeenCalledWith({ sessionKeys: ["web:s_a", "web:s_b"] });
  });

  it("POST /heartbeat rejects non-array sessionKeys with 400", async () => {
    const gateway = { panelHeartbeat: vi.fn() };
    const { request } = await createTeamsApp(gateway);

    const { status, body } = await request("/api/teams/heartbeat", {
      method: "POST",
      body: JSON.stringify({ sessionKeys: "web:s_a" }),
    });

    expect(status).toBe(400);
    expect(body).toEqual({ touched: 0 });
    expect(gateway.panelHeartbeat).not.toHaveBeenCalled();
  });
});

async function createTeamsApp(gateway) {
  vi.resetModules();
  vi.doMock("../sati-bridge.js", () => ({
    getSatiGateway: vi.fn(async () => gateway),
  }));

  const { default: teamsRoutes } = await import("./teams.js");
  const app = express();
  app.use(express.json());
  app.use("/api/teams", teamsRoutes);

  return {
    app,
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
