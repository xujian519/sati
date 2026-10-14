import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/knowledge-drafts` 路由：浏览器 → ui/server → gateway HTTP 面
 * （`/api/web/knowledge-drafts*`，Bearer server-token）。
 *
 * 钉四件事：转发形状（query/body 透传）、状态码与错误体透传（gateway 的
 * 404/409/500 语义原样回到浏览器）、token 注入、以及 ui/server 侧 502 兜底
 * （gateway 未起/不可达时可观测，不静默）。
 */

const bridge = vi.hoisted(() => ({
  readGatewayToken: vi.fn(),
}));

vi.mock("../sati-bridge.js", () => bridge);

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function createApp() {
  const { default: knowledgeDraftsRoutes } = await import("./knowledgeDrafts.js");
  const app = express();
  app.use(express.json());
  app.use("/api/knowledge-drafts", knowledgeDraftsRoutes);
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
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  } finally {
    server.close();
  }
}

describe("/api/knowledge-drafts 透传", () => {
  it("GET / 透传 limit 查询参数并原样回传 gateway 响应", async () => {
    const app = await createApp();
    bridge.readGatewayToken.mockResolvedValue("server-token");
    const gatewayFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ drafts: [{ id: "d1", title: "草稿", sessionId: "s1", status: "pending" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", gatewayFetch);

    const { status, payload } = await requestJson(app, "/api/knowledge-drafts?limit=5");
    expect(status).toBe(200);
    expect(payload.drafts).toHaveLength(1);
    expect(gatewayFetch).toHaveBeenCalledWith("http://127.0.0.1:19789/api/web/knowledge-drafts?limit=5", {
      method: "GET",
      headers: { authorization: "Bearer server-token" },
    });
  });

  it("POST /confirm 透传 body；gateway 409 原样回到浏览器", async () => {
    const app = await createApp();
    bridge.readGatewayToken.mockResolvedValue("server-token");
    const gatewayFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "draft_not_pending", message: "草稿状态为 rejected" } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", gatewayFetch);

    const { status, payload } = await requestJson(app, "/api/knowledge-drafts/confirm", {
      method: "POST",
      body: JSON.stringify({ id: "d1" }),
    });
    expect(status).toBe(409);
    expect(payload.error.code).toBe("draft_not_pending");
    const [url, init] = gatewayFetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:19789/api/web/knowledge-drafts/confirm");
    expect(JSON.parse(init.body)).toEqual({ id: "d1" });
  });

  it("POST /reject 透传可选 reason", async () => {
    const app = await createApp();
    bridge.readGatewayToken.mockResolvedValue("server-token");
    const gatewayFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
      );
    vi.stubGlobal("fetch", gatewayFetch);

    const { status } = await requestJson(app, "/api/knowledge-drafts/reject", {
      method: "POST",
      body: JSON.stringify({ id: "d1", reason: "内容不准确" }),
    });
    expect(status).toBe(200);
    expect(JSON.parse(gatewayFetch.mock.calls[0][1].body)).toEqual({ id: "d1", reason: "内容不准确" });
  });

  it("gateway 不可达 → 502 可观测兜底（不静默）", async () => {
    const app = await createApp();
    bridge.readGatewayToken.mockResolvedValue("server-token");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const { status, payload } = await requestJson(app, "/api/knowledge-drafts");
    expect(status).toBe(502);
    expect(payload.error.code).toBe("gateway_unreachable");
  });
});
