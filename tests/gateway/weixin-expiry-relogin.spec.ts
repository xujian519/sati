import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LoginResult } from "weixin-ilink";
import { WeixinChannel } from "../../src/adapters/index.js";
import type { WeixinIlinkClient } from "../../src/adapters/channel/weixin/WeixinChannel.js";
import type { ChannelRuntimeStatusUpdate } from "../../src/adapters/channel/protocol/ChannelRuntimeStatus.js";
import type { Gateway, GatewayChannelKey } from "../../src/gateway/index.js";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error("waitFor: condition not met within timeout");
}

function stubConsole(t: test.TestContext): void {
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "error", () => undefined);
}

function makeFakeClient(pollImpl: () => Promise<{ errcode?: number; ret?: number; msgs: unknown[] }>): {
  client: WeixinIlinkClient;
  pollCount: () => number;
} {
  let pollCount = 0;
  const client = {
    cursor: "",
    poll: async () => {
      pollCount++;
      return pollImpl();
    },
    sendTextChunked: async () => 1,
    sendMedia: async () => ({}),
    getUploadUrl: async () => ({}),
    sendTyping: async () => undefined,
  } as unknown as WeixinIlinkClient;
  return { client, pollCount: () => pollCount };
}

test("expired session (errcode -14) clears credentials and auto-starts QR login", async t => {
  stubConsole(t);

  const tempDir = await mkdtemp(join(tmpdir(), "sati-weixin-expiry-"));
  const credentialsPath = join(tempDir, "weixin-credentials.json");
  writeFileSync(
    credentialsPath,
    JSON.stringify({ baseUrl: "https://ilink.example", botToken: "expired-token", accountId: "bot-1" }),
  );
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const updates: Array<{ channelKey: GatewayChannelKey; update: ChannelRuntimeStatusUpdate }> = [];
  let qrLoginStarted = false;

  const channel = new WeixinChannel({
    credentialsPath,
    clientFactory: () => makeFakeClient(async () => ({ errcode: -14, msgs: [] })).client,
    loginWithQR: async ({ onQRCode }) => {
      qrLoginStarted = true;
      onQRCode("https://wechat.example/qr-fresh");
      return new Promise<LoginResult>(() => undefined);
    },
  });

  const handle = await channel.start({
    gateway: {} as Gateway,
    reportChannelStatus: (channelKey, update) => updates.push({ channelKey, update }),
  });

  await waitFor(() => qrLoginStarted);
  assert.ok(qrLoginStarted, "QR login should start automatically after expiry");
  assert.equal(existsSync(credentialsPath), false, "expired credentials file must be removed");
  assert.ok(
    updates.some(u => u.channelKey === "weixin" && u.update.state === "expired"),
    "expired state should be reported",
  );
  assert.ok(
    updates.some(
      u =>
        u.channelKey === "weixin" &&
        u.update.state === "waiting_for_login" &&
        u.update.qrUrl === "https://wechat.example/qr-fresh",
    ),
    "fresh QR url should be reported after auto re-login",
  );
  // 顺序契约：expired 必须早于自愈后的 waiting_for_login+qrUrl。通道在上报
  // expired 后必须同步启动扫码登录（不能先 await notifyActiveChats），否则 UI
  // 会停留在 expired 且停止轮询，新二维码永远到不了界面。
  const expiredIdx = updates.findIndex(u => u.channelKey === "weixin" && u.update.state === "expired");
  const qrIdx = updates.findIndex(
    u => u.channelKey === "weixin" && u.update.state === "waiting_for_login" && u.update.qrUrl !== undefined,
  );
  assert.ok(expiredIdx !== -1 && qrIdx !== -1, "both expired and fresh-QR updates must be present");
  assert.ok(expiredIdx < qrIdx, "expired must be reported before the self-healed QR url");
  // 且 expired 与首个 waiting_for_login（无论是否带 qrUrl）之间不应再隔其它状态：
  // 自愈必须同步衔接，保证 runtime-status.json 中 expired 只是瞬时状态。
  const firstWaitingIdx = updates.findIndex(u => u.channelKey === "weixin" && u.update.state === "waiting_for_login");
  assert.ok(
    firstWaitingIdx !== -1 && firstWaitingIdx <= qrIdx && firstWaitingIdx - expiredIdx <= 1,
    "QR login must start immediately after the expired report (no async gap)",
  );

  await (handle as Awaited<ReturnType<WeixinChannel["start"]>>).stop("test");
});

test("forceRelogin ignores saved credentials and starts QR login without polling client", async t => {
  stubConsole(t);

  const tempDir = await mkdtemp(join(tmpdir(), "sati-weixin-relogin-"));
  const credentialsPath = join(tempDir, "weixin-credentials.json");
  writeFileSync(
    credentialsPath,
    JSON.stringify({ baseUrl: "https://ilink.example", botToken: "stale-token", accountId: "bot-1" }),
  );
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const updates: Array<{ channelKey: GatewayChannelKey; update: ChannelRuntimeStatusUpdate }> = [];
  let clientCreated = false;
  let qrLoginStarted = false;

  const channel = new WeixinChannel({
    credentialsPath,
    forceRelogin: true,
    clientFactory: () => {
      clientCreated = true;
      return makeFakeClient(async () => ({ ret: 0, msgs: [] })).client;
    },
    loginWithQR: async ({ onQRCode }) => {
      qrLoginStarted = true;
      onQRCode("https://wechat.example/qr-relogin");
      return new Promise<LoginResult>(() => undefined);
    },
  });

  const handle = await channel.start({
    gateway: {} as Gateway,
    reportChannelStatus: (channelKey, update) => updates.push({ channelKey, update }),
  });

  await waitFor(() => qrLoginStarted);
  assert.ok(qrLoginStarted, "QR login should start under forceRelogin");
  assert.equal(clientCreated, false, "poll client must not be created under forceRelogin");
  assert.equal(existsSync(credentialsPath), false, "stale credentials file must be removed under forceRelogin");
  assert.ok(
    updates.some(
      u =>
        u.channelKey === "weixin" &&
        u.update.state === "waiting_for_login" &&
        u.update.qrUrl === "https://wechat.example/qr-relogin",
    ),
    "QR url should be reported under forceRelogin",
  );

  await (handle as Awaited<ReturnType<WeixinChannel["start"]>>).stop("test");
});

test("poll loop restarts with fresh credentials after QR re-login", async t => {
  stubConsole(t);

  const tempDir = await mkdtemp(join(tmpdir(), "sati-weixin-restart-"));
  const credentialsPath = join(tempDir, "weixin-credentials.json");
  writeFileSync(
    credentialsPath,
    JSON.stringify({ baseUrl: "https://ilink.example", botToken: "expired-token", accountId: "bot-1" }),
  );
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const clients: Array<{ pollCount: () => number }> = [];
  const channel = new WeixinChannel({
    credentialsPath,
    clientFactory: () => {
      // 第一个 client 的 poll 返回 -14 触发过期；重新登录后创建的第二个
      // client 恢复正常轮询。poll 需带短延迟模拟真实 long-poll，避免
      // 无限微任务忙循环饿死测试的定时器。
      const fake = makeFakeClient(async () => {
        await sleep(30);
        return clients.length === 1 ? { errcode: -14, msgs: [] } : { ret: 0, msgs: [] };
      });
      clients.push(fake);
      return fake.client;
    },
    loginWithQR: async ({ onQRCode }) => {
      onQRCode("https://wechat.example/qr-fresh");
      return { baseUrl: "https://ilink.example", botToken: "fresh-token", accountId: "bot-2" };
    },
  });

  const handle = await channel.start({
    gateway: {} as Gateway,
    reportChannelStatus: () => undefined,
  });

  await waitFor(() => clients.length >= 2);
  assert.equal(clients.length, 2, "a fresh poll client should be created after re-login");
  await waitFor(() => clients[1].pollCount() >= 1, 3000);
  assert.ok(clients[1].pollCount() >= 1, "poll loop should be running again after re-login");

  const saved = JSON.parse(readFileSync(credentialsPath, "utf-8")) as { botToken: string };
  assert.equal(saved.botToken, "fresh-token", "credentials file should be overwritten with fresh token");

  await (handle as Awaited<ReturnType<WeixinChannel["start"]>>).stop("test");
});
