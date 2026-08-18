import express from "express";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

const nativeFetch = globalThis.fetch;
const tempDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.SATI_HOME;
  delete process.env.SATI_CONFIG_PATH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway WeCom routes", () => {
  it("returns WeCom status from sati.yaml", async () => {
    const { request } = await createGatewayApp({
      adapters: {
        wecom: {
          enabled: true,
          token: "bot-1234567890",
          extra: {
            secret: "secret",
            websocket_url: "wss://custom.example",
            dm_policy: "open",
            group_policy: "disabled",
            allow_from: ["user-a"],
            group_allow_from: ["group-a"],
          },
        },
      },
    });

    const status = await request("/api/gateway/status");

    expect(status.wecom).toEqual({
      enabled: true,
      botId: "bot-…7890",
      hasSecret: true,
      websocketUrl: "wss://custom.example",
      dmPolicy: "open",
      groupPolicy: "disabled",
      allowFrom: ["user-a"],
      groupAllowFrom: ["group-a"],
    });
  });

  it("saves manual WeCom config to sati.yaml", async () => {
    const { request, configPath } = await createGatewayApp({});

    const result = await request("/api/gateway/wecom/save", {
      method: "POST",
      body: JSON.stringify({
        botId: "bot-manual",
        secret: "secret-manual",
        websocketUrl: "wss://custom.example",
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        allowFrom: "user-a, user-b",
        groupAllowFrom: ["group-a", "group-b"],
      }),
    });

    expect(result.ok).toBe(true);
    const config = parseYaml(readFileSync(configPath, "utf-8"));
    expect(config.adapters.wecom).toEqual({
      enabled: true,
      token: "bot-manual",
      extra: {
        secret: "secret-manual",
        websocket_url: "wss://custom.example",
        dm_policy: "allowlist",
        group_policy: "allowlist",
        allow_from: ["user-a", "user-b"],
        group_allow_from: ["group-a", "group-b"],
      },
    });
  });

  it("preserves existing WeCom credentials on settings-only saves", async () => {
    const { request, configPath } = await createGatewayApp({
      adapters: {
        wecom: {
          enabled: true,
          token: "bot-existing",
          extra: {
            secret: "secret-existing",
            websocket_url: "wss://old.example",
            dm_policy: "open",
            group_policy: "disabled",
          },
        },
      },
    });

    const result = await request("/api/gateway/wecom/save", {
      method: "POST",
      body: JSON.stringify({
        websocketUrl: "wss://new.example",
        dmPolicy: "disabled",
        groupPolicy: "open",
      }),
    });

    expect(result.ok).toBe(true);
    const config = parseYaml(readFileSync(configPath, "utf-8"));
    expect(config.adapters.wecom).toEqual({
      enabled: true,
      token: "bot-existing",
      extra: {
        secret: "secret-existing",
        websocket_url: "wss://new.example",
        dm_policy: "disabled",
        group_policy: "open",
      },
    });
  });

  it("disables WeCom config", async () => {
    const { request, configPath } = await createGatewayApp({
      adapters: {
        wecom: {
          enabled: true,
          token: "bot-id",
          extra: { secret: "secret" },
        },
      },
    });

    const result = await request("/api/gateway/wecom/disable", { method: "POST" });

    expect(result.ok).toBe(true);
    const config = parseYaml(readFileSync(configPath, "utf-8"));
    expect(config.adapters.wecom.enabled).toBe(false);
  });

  it("writes WeCom config after successful QR polling", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async url => {
        const href = String(url);
        if (href.includes("/generate")) {
          return jsonResponse({
            data: {
              scode: "scan-code",
              auth_url: "https://work.weixin.qq.com/scan",
            },
          });
        }
        return jsonResponse({
          data: {
            status: "success",
            bot_info: {
              botid: "bot-from-qr",
              secret: "secret-from-qr",
            },
          },
        });
      }),
    );
    const { request, configPath } = await createGatewayApp({});

    const begin = await request("/api/gateway/wecom/qr-begin", { method: "POST" });
    expect(begin.ok).toBe(true);
    expect(begin.qrUrl).toBe("https://work.weixin.qq.com/scan");

    const poll = await request("/api/gateway/wecom/qr-poll");
    expect(poll).toEqual({ ok: true, botId: "bot-…m-qr" });

    const config = parseYaml(readFileSync(configPath, "utf-8"));
    expect(config.adapters.wecom).toEqual({
      enabled: true,
      token: "bot-from-qr",
      extra: {
        secret: "secret-from-qr",
        websocket_url: "wss://openws.work.weixin.qq.com",
        dm_policy: "open",
        group_policy: "disabled",
      },
    });
  });
});

describe("gateway Weixin routes", () => {
  it("reports pending (not terminal error) while weixin runtime is expired", async () => {
    const { request, pilotHome } = await createGatewayApp({});
    writeRuntimeStatus(pilotHome, {
      weixin: {
        channelKey: "weixin",
        state: "expired",
        updatedAt: new Date().toISOString(),
        message: "微信登录已过期，请重新扫码登录",
      },
    });

    // 过期是通道自愈瞬态：通道会立即重新发起扫码登录（waiting_for_login + qrUrl）。
    // qr-poll 必须返回 pending 让 UI 继续轮询拾取新二维码，而不是 ok:false 终态。
    const poll = await request("/api/gateway/weixin/qr-poll");
    expect(poll.pending).toBe(true);
    expect(poll.ok).toBeUndefined();
    expect(poll.error).toBeUndefined();
  });

  it("returns pending with qrUrl while weixin runtime is waiting_for_login", async () => {
    const { request, pilotHome } = await createGatewayApp({});
    writeRuntimeStatus(pilotHome, {
      weixin: {
        channelKey: "weixin",
        state: "waiting_for_login",
        updatedAt: new Date().toISOString(),
        qrUrl: "https://wechat.example/fresh-qr",
      },
    });

    const poll = await request("/api/gateway/weixin/qr-poll");
    expect(poll.pending).toBe(true);
    expect(poll.qrUrl).toBe("https://wechat.example/fresh-qr");
  });

  it("returns ok with accountId once weixin is connected", async () => {
    const { request, pilotHome } = await createGatewayApp({});
    writeRuntimeStatus(pilotHome, {
      weixin: {
        channelKey: "weixin",
        state: "connected",
        updatedAt: new Date().toISOString(),
        accountId: "wx-account",
      },
    });

    const poll = await request("/api/gateway/weixin/qr-poll");
    expect(poll.ok).toBe(true);
    expect(poll.accountId).toBe("wx-account");
  });
});

function writeRuntimeStatus(pilotHome, channels) {
  const dir = join(pilotHome, "channels");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "runtime-status.json"),
    JSON.stringify({ updatedAt: new Date().toISOString(), channels }),
    "utf-8",
  );
}

async function createGatewayApp(initialConfig) {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-wecom-gateway-"));
  tempDirs.push(pilotHome);
  const configPath = join(pilotHome, "sati.yaml");
  writeFileSync(configPath, stringifyYaml(initialConfig), "utf-8");

  process.env.SATI_HOME = pilotHome;
  process.env.SATI_CONFIG_PATH = configPath;
  vi.resetModules();
  vi.doMock("../services/satiConfigWatcher.js", () => ({
    suppressNextWatchEvent: vi.fn(),
  }));
  vi.doMock("../services/satiConfigReloader.js", () => ({
    reloadSatiConfig: vi.fn(async () => undefined),
  }));
  vi.doMock("../services/satiConfig.js", () => ({
    readSatiConfigFile: vi.fn(() => ({ config: {} })),
  }));
  vi.doMock("../sati-bridge.js", () => ({
    getSatiGateway: vi.fn(async () => ({ reloadConfig: vi.fn(async () => undefined) })),
  }));

  const { default: gatewayRoutes } = await import("./gateway.js");
  const app = express();
  app.use(express.json());
  app.use("/api/gateway", gatewayRoutes);

  return {
    pilotHome,
    configPath,
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
    return response.json();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  };
}

describe("gateway QR image route", () => {
  async function qrRequest(app, path) {
    const server = app.listen(0);
    try {
      const { port } = server.address();
      return await nativeFetch(`http://127.0.0.1:${port}${path}`);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }

  it("generates a PNG locally for a valid data URL", async () => {
    const { app } = await createGatewayApp({});
    const res = await qrRequest(app, `/api/gateway/qr-image?data=${encodeURIComponent("https://example.com/login")}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const buf = Buffer.from(await res.arrayBuffer());
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(buf.length).toBeGreaterThan(200);
  });

  it("rejects requests without data", async () => {
    const { app } = await createGatewayApp({});
    const res = await qrRequest(app, "/api/gateway/qr-image");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing");
  });

  it("rejects overly long data payloads", async () => {
    const { app } = await createGatewayApp({});
    const res = await qrRequest(app, `/api/gateway/qr-image?data=${"a".repeat(3000)}`);

    expect(res.status).toBe(400);
  });
});
