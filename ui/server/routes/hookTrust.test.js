import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/hook-trust` 路由：转发到 gateway `hook_trust_*` 方法（协议 1.11）。
 *
 * 与 `routes/kanban.js` 同一形态——路由不碰信任存储，唯一事实源是 gateway 侧。
 * 本测试钉三件事：入参校验、feature-detect（旧 gateway 无该方法 → 501 not_configured）、
 * 以及列表/决定如实转发。
 */

const gateway = vi.hoisted(() => ({
  hookTrustList: vi.fn(),
  hookTrustDecide: vi.fn(),
}));

vi.mock("../sati-bridge.js", () => ({
  getSatiGatewayWithReset: async () => gateway,
}));

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.clearAllMocks();
});

async function createApp() {
  const { default: hookTrustRoutes } = await import("./hookTrust.js");
  const app = express();
  app.use(express.json());
  app.use("/api/hook-trust", hookTrustRoutes);
  return app;
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

describe("hook trust routes", () => {
  it("GET / 转发 hookTrustList 并原样返回条目", async () => {
    gateway.hookTrustList = vi.fn(async () => ({
      workspaceIdentityKey: "ws",
      entries: [{ pluginId: "x@project", status: "pending", hooks: [] }],
    }));
    const app = await createApp();
    const result = await requestJson(app, "/api/hook-trust?projectKey=%2Frepo");
    expect(result.status).toBe(200);
    expect(gateway.hookTrustList).toHaveBeenCalledWith({ projectKey: "/repo" });
    expect(result.body).toMatchObject({ workspaceIdentityKey: "ws", entries: [{ pluginId: "x@project" }] });
  });

  it("GET / 缺 projectKey → 400", async () => {
    const app = await createApp();
    const result = await requestJson(app, "/api/hook-trust");
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("invalid_request");
    expect(gateway.hookTrustList).not.toHaveBeenCalled();
  });

  it("POST /decide 转发 grant/revoke，且校验 verdict", async () => {
    gateway.hookTrustDecide = vi.fn(async () => ({
      applied: true,
      entry: { pluginId: "x@project", status: "trusted" },
    }));
    const app = await createApp();

    const granted = await requestJson(app, "/api/hook-trust/decide", {
      method: "POST",
      body: JSON.stringify({ projectKey: "/repo", pluginId: "x@project", verdict: "grant" }),
    });
    expect(granted.status).toBe(200);
    expect(gateway.hookTrustDecide).toHaveBeenCalledWith({
      projectKey: "/repo",
      pluginId: "x@project",
      verdict: "grant",
    });

    const bogus = await requestJson(app, "/api/hook-trust/decide", {
      method: "POST",
      body: JSON.stringify({ projectKey: "/repo", pluginId: "x@project", verdict: "maybe" }),
    });
    expect(bogus.status).toBe(400);
    expect(gateway.hookTrustDecide).toHaveBeenCalledTimes(1);
  });

  it("旧 gateway 无该方法 → 501 not_configured（feature-detect）", async () => {
    gateway.hookTrustList = undefined;
    const app = await createApp();
    const result = await requestJson(app, "/api/hook-trust?projectKey=%2Frepo");
    expect(result.status).toBe(501);
    expect(result.body.error.code).toBe("not_configured");
  });
});
