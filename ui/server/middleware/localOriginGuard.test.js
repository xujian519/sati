// @vitest-environment node
/**
 * 本机免登录模式下的请求来源守卫。
 *
 * 判据是「浏览器里任意网页不能调用本机 API」这条不变式：跨站 `fetch` 一定带 `Origin`（本轮判据
 * 的核心输入），而对 `127.0.0.1` 的跨站请求里 `Host` 仍是本机地址，因此两条判据必须同时成立才放行。
 * 默认只信任环回名字；私有地址 / 本机主机名须显式登记在 `SATI_TRUSTED_HOSTS`（#748）。
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
import { corsPolicy } from "./corsPolicy.js";

const nativeFetch = globalThis.fetch;

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

/** 起一个只挂给定中间件的探针服务（`/api/probe` 恒 200）。 */
async function serve(middlewares) {
  const app = express();
  for (const middleware of middlewares) app.use(middleware);
  app.get("/api/probe", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  return {
    port: server.address().port,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

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
  const options = { trustedHosts: [] };

  it.each([
    ["localhost:3001", true],
    ["127.0.0.1:3001", true],
    ["127.9.9.9", true],
    ["::1", true],
    ["app.localhost:3001", true],
    // 非环回的本机可达名不再隐式信任：须显式登记（#748）
    ["192.168.1.5:3001", false],
    ["10.0.0.7:3001", false],
    ["172.20.1.1", false],
    ["169.254.1.1", false],
    ["fe80::1", false],
    ["fd00::1", false],
    ["my-mac:3001", false],
    ["my-mac.local:3001", false],
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

  it("显式列出的非环回名字被信任（局域网 / 反代 / 自定义域名的逃生口）", () => {
    const trusted = { trustedHosts: ["192.168.1.5", "ui.internal", "sati.lan:3001"] };
    expect(isTrustedLocalHost("192.168.1.5:3001", trusted)).toBe(true);
    expect(isTrustedLocalHost("ui.internal:3001", trusted)).toBe(true);
    expect(isTrustedLocalHost("sati.lan", trusted)).toBe(true);
    // 名单外的其它非环回名字仍拒。
    expect(isTrustedLocalHost("10.0.0.7:3001", trusted)).toBe(false);
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
  });

  it("非环回来源默认拒绝，显式登记后放行", () => {
    const lan = { host: "192.168.1.5:3001", origin: "http://192.168.1.5:5173" };
    expect(isTrustedRequestSource(lan)).toBe(false);
    expect(isTrustedRequestSource(lan, { trustedHosts: ["192.168.1.5"] })).toBe(true);
    expect(isTrustedRequestSource({ host: "sati.lan:3001" }, { trustedHosts: ["sati.lan"] })).toBe(true);
    expect(isTrustedRequestSource({ host: "sati.lan:3001" }, { trustedHosts: ["other.lan"] })).toBe(false);
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
    const options = { trustedHosts: ["app.example.com"] };
    expect(isTrustedRequestSource({ host: "127.0.0.1:3001", origin: "https://app.example.com" }, options)).toBe(true);
    expect(isTrustedRequestSource({ host: "app.example.com", origin: "https://app.example.com" }, options)).toBe(true);
  });
});

describe("中间件行为", () => {
  function start({ enabled, ...options }) {
    return serve([createLocalOriginGuard({ enabled, ...options })]);
  }

  it("启用后只放行环回来源，公网来源、非环回 Host 与 rebinding 一律 403", async () => {
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

      // 局域网直连（Host 为私有地址）：默认不再隐式信任。
      const lan = await rawGet(port, "/api/probe", { host: "192.168.1.5:3001" });
      expect(lan.status).toBe(403);
      expect(lan.body).toContain("UNTRUSTED_REQUEST_ORIGIN");
    } finally {
      await close();
    }
  });

  it("显式登记的非环回 Host 放行（局域网 / 反代部署）", async () => {
    const { port, close } = await start({ enabled: true, trustedHosts: ["192.168.1.5"] });
    try {
      const lan = await rawGet(port, "/api/probe", {
        host: "192.168.1.5:3001",
        origin: "http://192.168.1.5:3001",
      });
      expect(lan.status).toBe(200);

      const other = await rawGet(port, "/api/probe", { host: "10.0.0.7:3001" });
      expect(other.status).toBe(403);
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

// 本层与 corsPolicy（#625）职责相邻，故把「两层叠加才拦得住」这件事本身钉成用例：
// 少了本层，下面这个 rebinding 形态会被 corsPolicy 判成同源而放行。
describe("与 corsPolicy 叠加", () => {
  // DNS rebinding 且攻击页跑在同端口：Host 与 Origin 同为主机名 evil.com:PORT
  const rebinding = { host: "evil.com:3001", origin: "http://evil.com:3001" };

  it("只用 corsPolicy 时，该形态被判同源放行（本层存在的理由）", async () => {
    const { port, close } = await serve([corsPolicy(new Set())]);
    try {
      const res = await rawGet(port, "/api/probe", rebinding);
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("两层叠加后拒绝，且本机同源请求不受影响", async () => {
    const { port, close } = await serve([corsPolicy(new Set()), createLocalOriginGuard({ enabled: true })]);
    try {
      const blocked = await rawGet(port, "/api/probe", rebinding);
      expect(blocked.status).toBe(403);
      expect(blocked.body).toContain("UNTRUSTED_REQUEST_ORIGIN");

      const local = await rawGet(port, "/api/probe", {
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
      });
      expect(local.status).toBe(200);
    } finally {
      await close();
    }
  });
});
