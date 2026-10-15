// @vitest-environment node
/**
 * 本机免登录模式下的请求来源守卫。
 *
 * 判据是「浏览器里任意网页不能调用本机 API」这条不变式：跨站 `fetch` 一定带 `Origin`（本轮判据
 * 的核心输入），而对 `127.0.0.1` 的跨站请求里 `Host` 仍是本机地址，因此两条判据必须同时成立才放行。
 * 负控制：把守卫 `enabled: false`（即关闭）时，跨站请求确实进得来——见最后一组用例。
 */
import express from "express";
import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import {
  createLocalOriginGuard,
  extractHostname,
  isTrustedLocalHost,
  isTrustedRequestSource,
} from "./localOriginGuard.js";

const nativeFetch = globalThis.fetch;

describe("extractHostname", () => {
  it.each([
    ["127.0.0.1:3001", "127.0.0.1"],
    ["localhost:5173", "localhost"],
    ["[::1]:3001", "::1"],
    ["::1", "::1"],
    ["LOCALHOST", "localhost"],
    ["evil.com:443", "evil.com"],
    ["", ""],
    [undefined, ""],
  ])("%s → %s", (input, expected) => {
    expect(extractHostname(input)).toBe(expected);
  });
});

describe("isTrustedLocalHost", () => {
  const options = { selfHostname: "my-mac", trustedHosts: [] };

  it.each([
    ["localhost:3001", true],
    ["127.0.0.1:3001", true],
    ["127.9.9.9", true],
    ["::1", true],
    ["192.168.1.5:3001", true],
    ["10.0.0.7:3001", true],
    ["172.20.1.1", true],
    ["169.254.1.1", true],
    ["fe80::1", true],
    ["fd00::1", true],
    ["my-mac:3001", true],
    ["my-mac.local:3001", true],
    // DNS rebinding：攻击者的域名解析到 127.0.0.1，Host 仍是那个域名
    ["evil.com", false],
    ["evil.com:3001", false],
    ["8.8.8.8", false],
    ["172.32.0.1", false],
    ["192.169.0.1", false],
    ["", false],
  ])("%s → %s", (host, expected) => {
    expect(isTrustedLocalHost(host, options)).toBe(expected);
  });

  it("显式列出的主机名被信任（非常规部署的逃生口）", () => {
    expect(isTrustedLocalHost("ui.internal:3001", { selfHostname: "my-mac", trustedHosts: ["ui.internal"] })).toBe(
      true,
    );
  });
});

describe("isTrustedRequestSource", () => {
  it("无 Origin 的请求（curl / Node 客户端 / 同源 GET 导航）只看 Host 这一半", () => {
    expect(isTrustedRequestSource({ host: "127.0.0.1:3001" })).toBe(true);
    expect(isTrustedRequestSource({ host: "evil.com" })).toBe(false);
  });

  it("本机来源放行：页面与 API 不同端口、不同本机名字都算（dev 下 Vite 会把 Host 改写成代理目标）", () => {
    expect(isTrustedRequestSource({ host: "localhost:3001", origin: "http://localhost:5173" })).toBe(true);
    expect(isTrustedRequestSource({ host: "localhost:3001", origin: "http://127.0.0.1:5173" })).toBe(true);
    expect(isTrustedRequestSource({ host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" })).toBe(true);
    expect(isTrustedRequestSource({ host: "127.0.0.1:3001", origin: "http://192.168.1.5:5173" })).toBe(true);
  });

  it.each([
    // 公网来源：这是本判据要挡的那一类（浏览器里的任意外部网页）
    ["外部网页（公网域名来源）", { host: "127.0.0.1:3001", origin: "https://evil.com" }],
    // DNS rebinding：攻击者域名解析到 127.0.0.1，页面来源与 Host 都是那个公网域名
    ["DNS rebinding（Host 与 Origin 都是公网域名）", { host: "evil.com", origin: "http://evil.com" }],
    ["DNS rebinding 的页面来源（Host 是本机地址）", { host: "127.0.0.1:3001", origin: "http://evil.com" }],
    [
      "nip.io 形态（公网 DNS 指向 127.0.0.1 的来源）",
      { host: "127.0.0.1:3001", origin: "http://127.0.0.1.nip.io:8899" },
    ],
    ["沙箱 iframe / file:// 页面的 null origin", { host: "127.0.0.1:3001", origin: "null" }],
    ["Host 缺失", { host: undefined, origin: "http://127.0.0.1:3001" }],
  ])("%s 被拒", (_caseName, headers) => {
    expect(isTrustedRequestSource(headers)).toBe(false);
  });

  it("显式列出的名字同时用于 Host 与 Origin（反代/自定义域名的逃生口）", () => {
    const options = { selfHostname: "my-mac", trustedHosts: ["app.example.com"] };
    expect(isTrustedRequestSource({ host: "127.0.0.1:3001", origin: "https://app.example.com" }, options)).toBe(true);
    expect(isTrustedRequestSource({ host: "app.example.com", origin: "https://app.example.com" }, options)).toBe(true);
  });
});

describe("中间件行为", () => {
  /** 原生 http 客户端：`fetch`（undici）不允许覆写 `Host`，而 rebinding 判据正是要伪造 `Host`。 */
  function rawGet(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, headers }, res => {
        let body = "";
        res.on("data", chunk => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  async function start({ enabled, ...options }) {
    const app = express();
    app.use(createLocalOriginGuard({ enabled, selfHostname: "my-mac", ...options }));
    app.get("/api/probe", (_req, res) => res.json({ ok: true }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    return {
      port: server.address().port,
      close: () => new Promise(resolve => server.close(resolve)),
    };
  }

  it("启用后只放行本机来源，公网来源与 rebinding 一律 403", async () => {
    const { port, close } = await start({ enabled: true });
    try {
      const allowed = await nativeFetch(`http://127.0.0.1:${port}/api/probe`, {
        headers: { Origin: `http://127.0.0.1:${port}` },
      });
      expect(allowed.status).toBe(200);

      const noOrigin = await nativeFetch(`http://127.0.0.1:${port}/api/probe`);
      expect(noOrigin.status).toBe(200);

      // dev 形态：页面与 API 不同端口（Vite 代理把 Host 改写成代理目标，Origin 仍是页面来源）
      const devLike = await rawGet(port, "/api/probe", { host: "localhost:3001", origin: "http://127.0.0.1:5173" });
      expect(devLike.status).toBe(200);

      const crossSite = await nativeFetch(`http://127.0.0.1:${port}/api/probe`, {
        headers: { Origin: "https://evil.com" },
      });
      expect(crossSite.status).toBe(403);
      expect((await crossSite.json()).error.code).toBe("UNTRUSTED_REQUEST_ORIGIN");

      // Host 是攻击者域名（DNS rebinding）：即使不带 Origin 也拒。
      const rebound = await rawGet(port, "/api/probe", { host: "evil.com" });
      expect(rebound.status).toBe(403);
      expect(rebound.body).toContain("UNTRUSTED_REQUEST_ORIGIN");
    } finally {
      await close();
    }
  });

  it("关闭时（托管部署 / 逃生口）是透传中间件，跨站请求照旧进得来", async () => {
    const { port, close } = await start({ enabled: false });
    try {
      const crossSite = await nativeFetch(`http://127.0.0.1:${port}/api/probe`, {
        headers: { Origin: "https://evil.com" },
      });
      expect(crossSite.status).toBe(200);
    } finally {
      await close();
    }
  });
});
