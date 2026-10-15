// @vitest-environment node
/**
 * URL 票据鉴权判据（#626：去 URL 会话 JWT）。
 *
 * 不变式：
 * - 通用鉴权（authenticateToken）不再从 query 或 Referer 接受会话 JWT——两条泄露源被切断；
 * - 无 Authorization 头时只认 `?ticket=` 里的短期、scope=url-ticket 的一次性凭据；
 * - 绑定按「请求侧」驱动以防跨载体复用：带 `?path=` 的文件路由拒绝无 path 绑定的票据；
 * - 票据分支绝不进入会话 auto-refresh，也绝不换发会话 token；
 * - 签发端点只认会话头，拒绝用一份票据续换凭据。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";

const TEST_SECRET = "test-secret-for-url-ticket";
const USER = { id: 11, username: "ticket-tester" };

vi.mock("../constants/config.js", () => ({
  IS_PLATFORM: false,
  DISABLE_LOCAL_AUTH: false,
}));

vi.mock("../utils/consoleLogger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../database/db.js", () => ({
  appConfigDb: { getOrCreateJwtSecret: () => TEST_SECRET },
  userDb: {
    getUserById: id => (id === USER.id ? USER : null),
    getFirstUser: () => USER,
  },
}));

// auth.js 优先读取环境变量 JWT_SECRET；测试必须用上面注入的密钥签发，故导入前清掉它。
delete process.env.JWT_SECRET;
const auth = await import("./auth.js");
const urlTicketRoutes = (await import("../routes/url-ticket.js")).default;
const { authenticateToken, generateUrlTicket, urlTicketTtl } = auth;

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(urlTicketRoutes);
  app.get("/api/projects/:projectName/files/content", authenticateToken, (req, res) => {
    res.json({ ok: true, project: req.params.projectName, userId: req.user.id });
  });
  // 无 projectName、无 path 的载体路由（如 gateway 二维码）：purpose 级票据即可放行。
  app.get("/api/gateway/qr-image", authenticateToken, (req, res) => {
    res.json({ ok: true });
  });
  server = app.listen(0);
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

const sessionToken = () => jwt.sign({ userId: USER.id, username: USER.username }, TEST_SECRET, { expiresIn: "1h" });

async function get(path, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  return { status: response.status, headers: response.headers };
}

const CONTENT = (project, path) => `/api/projects/${project}/files/content?path=${encodeURIComponent(path)}`;

describe("generateUrlTicket 形状", () => {
  it("票据带 scope=url-ticket、purpose 与可选绑定", () => {
    const decoded = jwt.decode(generateUrlTicket(USER, { purpose: "file", project: "alpha", path: "a/b.txt" }));
    expect(decoded.scope).toBe("url-ticket");
    expect(decoded.purpose).toBe("file");
    expect(decoded.project).toBe("alpha");
    expect(decoded.path).toBe("a/b.txt");
    expect(decoded.userId).toBe(USER.id);
  });

  it("purpose 级票据不含 project/path", () => {
    const decoded = jwt.decode(generateUrlTicket(USER, { purpose: "qr" }));
    expect(decoded.project).toBeUndefined();
    expect(decoded.path).toBeUndefined();
  });

  it("各用途 TTL 短，dashboard 稍长（复用 cookie 子资源）", () => {
    expect(urlTicketTtl("file")).toBeLessThanOrEqual(5 * 60);
    expect(urlTicketTtl("qr")).toBeLessThanOrEqual(5 * 60);
    expect(urlTicketTtl("sse")).toBeLessThanOrEqual(5 * 60);
    expect(urlTicketTtl("dashboard")).toBeLessThanOrEqual(15 * 60);
    expect(urlTicketTtl("dashboard")).toBeGreaterThan(urlTicketTtl("file"));
  });
});

describe("通用鉴权接受合法 URL 票据", () => {
  it("绑定项目与路径的文件票据可访问对应文件内容", async () => {
    const ticket = generateUrlTicket(USER, { purpose: "file", project: "alpha", path: "a/b.txt" });
    const { status } = await get(`${CONTENT("alpha", "a/b.txt")}&ticket=${ticket}`);
    expect(status).toBe(200);
  });

  it("purpose 级票据可访问无项目/路径绑定的载体路由（二维码）", async () => {
    const ticket = generateUrlTicket(USER, { purpose: "qr" });
    const { status } = await get(`/api/gateway/qr-image?data=hello&ticket=${ticket}`);
    expect(status).toBe(200);
  });
});

describe("跨载体复用与绑定校验被拒", () => {
  it("项目不匹配：票据绑 alpha、请求打 beta → 403", async () => {
    const ticket = generateUrlTicket(USER, { purpose: "file", project: "alpha", path: "a/b.txt" });
    const { status } = await get(`${CONTENT("beta", "a/b.txt")}&ticket=${ticket}`);
    expect(status).toBe(403);
  });

  it("路径不匹配：票据绑 a/b.txt、请求要 a/secret.txt → 403", async () => {
    const ticket = generateUrlTicket(USER, { purpose: "file", project: "alpha", path: "a/b.txt" });
    const { status } = await get(`${CONTENT("alpha", "a/secret.txt")}&ticket=${ticket}`);
    expect(status).toBe(403);
  });

  it("无 path 绑定的 purpose 级票据不得读文件（文件路由带 ?path） → 403", async () => {
    const ticket = generateUrlTicket(USER, { purpose: "qr" });
    const { status } = await get(`${CONTENT("alpha", "a/b.txt")}&ticket=${ticket}`);
    expect(status).toBe(403);
  });
});

describe("会话 JWT 被彻底赶出 URL 与 cookie", () => {
  it("会话 JWT 放 `?ticket=` 被拒（scope 必须是 url-ticket） → 403", async () => {
    const { status } = await get(`${CONTENT("alpha", "a/b.txt")}&ticket=${sessionToken()}`);
    expect(status).toBe(403);
  });

  it("会话 JWT 放 `?token=` 不再被回退接受（回退已删） → 401", async () => {
    const { status } = await get(`${CONTENT("alpha", "a/b.txt")}&token=${sessionToken()}`);
    expect(status).toBe(401);
  });

  it("Referer 内嵌 token 不再作为凭据来源 → 401", async () => {
    const { status } = await get(CONTENT("alpha", "a/b.txt"), {
      Referer: `${baseUrl}/memory-dashboard/index.html?token=${sessionToken()}`,
    });
    expect(status).toBe(401);
  });

  it("完全无凭据 → 401", async () => {
    const { status } = await get(CONTENT("alpha", "a/b.txt"));
    expect(status).toBe(401);
  });

  it("会话 JWT 走 Authorization 头仍是正常程序化请求 → 200", async () => {
    const { status } = await get(CONTENT("alpha", "a/b.txt"), { Authorization: `Bearer ${sessionToken()}` });
    expect(status).toBe(200);
  });
});

describe("票据过期与不换发会话", () => {
  const expiredTicket = () =>
    jwt.sign(
      {
        userId: USER.id,
        scope: "url-ticket",
        purpose: "file",
        project: "alpha",
        path: "a/b.txt",
        exp: Math.floor(Date.now() / 1000) - 60,
      },
      TEST_SECRET,
    );

  it("过期票据 → 403", async () => {
    const { status } = await get(`${CONTENT("alpha", "a/b.txt")}&ticket=${expiredTicket()}`);
    expect(status).toBe(403);
  });

  it("票据分支不触发 auto-refresh、不换发会话 token（无 X-Refreshed-Token）", async () => {
    // 造一份已过半生命周期仍未过期的票据：若走会话 auto-refresh 分支会种 X-Refreshed-Token。
    const iat = Math.floor(Date.now() / 1000) - 240;
    const exp = Math.floor(Date.now() / 1000) + 60; // 300s 生命，已过半
    const ticket = jwt.sign(
      { userId: USER.id, scope: "url-ticket", purpose: "file", project: "alpha", path: "a/b.txt", iat, exp },
      TEST_SECRET,
    );
    const { status, headers } = await get(`${CONTENT("alpha", "a/b.txt")}&ticket=${ticket}`);
    expect(status).toBe(200);
    expect(headers.get("x-refreshed-token")).toBeNull();
  });
});

describe("签发端点 POST /api/url-ticket 只认会话头", () => {
  async function postTicket(body, headers = {}) {
    const response = await fetch(`${baseUrl}/api/url-ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  }

  it("会话头换取合法文件票据，票据随即可用", async () => {
    const { status, data } = await postTicket(
      { purpose: "file", project: "alpha", path: "a/b.txt" },
      { Authorization: `Bearer ${sessionToken()}` },
    );
    expect(status).toBe(200);
    expect(typeof data.token).toBe("string");
    expect(data.expiresIn).toBe(urlTicketTtl("file"));
    const use = await get(`${CONTENT("alpha", "a/b.txt")}&ticket=${data.token}`);
    expect(use.status).toBe(200);
  });

  it("拒绝未知 purpose → 400", async () => {
    const { status } = await postTicket({ purpose: "admin" }, { Authorization: `Bearer ${sessionToken()}` });
    expect(status).toBe(400);
  });

  it("无 Authorization 头 → 401（不接受 query 票据 / cookie 续换）", async () => {
    const ticket = generateUrlTicket(USER, { purpose: "file", project: "alpha", path: "a/b.txt" });
    const { status } = await postTicket(
      { purpose: "file", project: "alpha", path: "a/b.txt" },
      { Cookie: `x=${ticket}` },
    );
    expect(status).toBe(401);
  });

  it("把票据塞进 Authorization 头也不被接受为会话（scope 隔离） → 403", async () => {
    const ticket = generateUrlTicket(USER, { purpose: "file", project: "alpha", path: "a/b.txt" });
    const { status } = await postTicket({ purpose: "file" }, { Authorization: `Bearer ${ticket}` });
    expect(status).toBe(403);
  });
});
