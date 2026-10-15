// @vitest-environment node
/**
 * 跨站来源收窄判据（#625）。
 *
 * 威胁模型：默认免登录模式下服务端曾无条件 `cors()`（ACAO `*`），同机任意第三方
 * 网页可跨域读取本机 API；WebSocket 更是不受 CORS 约束，可被任意网页直接建连。
 *
 * 不变式（isTrustedOrigin 放行条件，任一成立即可信）：
 * 1. 无 `Origin`——非浏览器来源（curl / 本地工具 / 服务器间调用）；
 * 2. Origin 主机与 Host 同源——Web UI / Electron 渲染层命中 http://127.0.0.1:PORT；
 * 3. Origin 主机是环回（localhost / 127.0.0.1 / ::1，任意端口）——Vite dev 代理等本机来源；
 * 4. Origin 在显式白名单内——反向代理 / 容器 / 跨机部署。
 * 其余（含 `null`：file:// / data: / 沙箱 iframe）拒绝。
 */
import { describe, expect, it } from "vitest";
import { corsPolicy, isTrustedOrigin } from "./corsPolicy.js";

const EMPTY = new Set();

describe("isTrustedOrigin（纯判定）", () => {
  it("无 Origin 头放行（非浏览器来源）", () => {
    expect(isTrustedOrigin(undefined, "127.0.0.1:3001", EMPTY)).toBe(true);
    expect(isTrustedOrigin("", "127.0.0.1:3001", EMPTY)).toBe(true);
  });

  it("同源放行（Origin 主机 == Host）", () => {
    expect(isTrustedOrigin("http://127.0.0.1:3001", "127.0.0.1:3001", EMPTY)).toBe(true);
    expect(isTrustedOrigin("http://localhost:3001", "localhost:3001", EMPTY)).toBe(true);
  });

  it("环回主机（任意端口）放行", () => {
    expect(isTrustedOrigin("http://127.0.0.1:5173", "127.0.0.1:3001", EMPTY)).toBe(true);
    expect(isTrustedOrigin("http://localhost:5173", "127.0.0.1:3001", EMPTY)).toBe(true);
    expect(isTrustedOrigin("http://[::1]:5173", "127.0.0.1:3001", EMPTY)).toBe(true);
  });

  it("显式白名单放行非环回来源", () => {
    const allowlist = new Set(["https://sati.example.com"]);
    expect(isTrustedOrigin("https://sati.example.com", "127.0.0.1:3001", allowlist)).toBe(true);
    // 白名单未含的其它外部来源仍被拒。
    expect(isTrustedOrigin("https://evil.example.com", "127.0.0.1:3001", allowlist)).toBe(false);
  });

  it("外部跨站拒绝", () => {
    expect(isTrustedOrigin("http://evil.com", "127.0.0.1:3001", EMPTY)).toBe(false);
    expect(isTrustedOrigin("https://attacker.test", "sati.lan:3001", EMPTY)).toBe(false);
  });

  it("null Origin（file:// / data: / 沙箱 iframe）拒绝", () => {
    expect(isTrustedOrigin("null", "127.0.0.1:3001", EMPTY)).toBe(false);
  });

  it("畸形 Origin 拒绝", () => {
    expect(isTrustedOrigin("not-a-url", "127.0.0.1:3001", EMPTY)).toBe(false);
  });

  it('允许显式登记 "null" 放行 file:// 场景', () => {
    const allowlist = new Set(["null"]);
    expect(isTrustedOrigin("null", "127.0.0.1:3001", allowlist)).toBe(true);
  });
});

// --- 中间件层 fake 对象 ---

function fakeRes() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    body: undefined,
    ended: false,
    setHeader(name, value) {
      headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function run(req) {
  const res = fakeRes();
  let nextCalled = false;
  corsPolicy(EMPTY)(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

describe("corsPolicy 中间件", () => {
  it("无 Origin：原样透传，不设 CORS 头", () => {
    const { res, nextCalled } = run({ method: "GET", headers: { host: "127.0.0.1:3001" } });
    expect(nextCalled).toBe(true);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(res.headers["Vary"]).toBe("Origin");
  });

  it("同源：透传，不需要 CORS 头", () => {
    const { res, nextCalled } = run({
      method: "GET",
      headers: { host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" },
    });
    expect(nextCalled).toBe(true);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("环回跨源（Vite dev）：反射 Origin + 凭据并放行", () => {
    const { res, nextCalled } = run({
      method: "GET",
      headers: { host: "127.0.0.1:3001", origin: "http://localhost:5173" },
    });
    expect(nextCalled).toBe(true);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
    expect(res.headers["Access-Control-Allow-Credentials"]).toBe("true");
    expect(res.headers["Access-Control-Expose-Headers"]).toBe("X-Refreshed-Token");
  });

  it("不可信跨站实际请求：403 且不调用 next", () => {
    const { res, nextCalled } = run({
      method: "GET",
      headers: { host: "127.0.0.1:3001", origin: "http://evil.com" },
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toMatch(/Cross-origin request blocked/);
  });

  it("不可信跨站预检 OPTIONS：204 空体且不调用 next", () => {
    const { res, nextCalled } = run({
      method: "OPTIONS",
      headers: { host: "127.0.0.1:3001", origin: "http://evil.com" },
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("null Origin：拒绝（不进入路由）", () => {
    const { res, nextCalled } = run({
      method: "GET",
      headers: { host: "127.0.0.1:3001", origin: "null" },
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});
