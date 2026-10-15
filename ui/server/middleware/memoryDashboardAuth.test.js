// @vitest-environment node
/**
 * memory-dashboard 鉴权判据（#626：Referer 内嵌会话 token → 票据 + 路径限定 cookie）。
 *
 * 范式（与 #615 项目预览同构）：
 * - 文档导航带 `?ticket=<dashboard 票据>`，校验 purpose 后种下路径限定 cookie；
 * - 同目录子资源（app.js/app.css）不带凭据，靠 cookie 携带；
 * - 会话 JWT 不再出现在 query / cookie / Referer 中作为凭据来源。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";

const TEST_SECRET = "test-secret-for-memory-dashboard";
const USER = { id: 21, username: "dash-tester" };

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

delete process.env.JWT_SECRET;
const auth = await import("./auth.js");
const { authenticateMemoryDashboard, generateUrlTicket, urlTicketTtl } = auth;
const COOKIE = auth.MEMORY_DASHBOARD_COOKIE;

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  const doc = (req, res) => res.json({ ok: true, userId: req.user.id });
  app.get("/memory-dashboard/index.html", authenticateMemoryDashboard, doc);
  app.get("/memory-dashboard/app.js", authenticateMemoryDashboard, doc);
  server = app.listen(0);
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

const sessionToken = () => jwt.sign({ userId: USER.id, username: USER.username }, TEST_SECRET, { expiresIn: "1h" });
const dashboardTicket = () => generateUrlTicket(USER, { purpose: "dashboard" });

async function fetchDashboard(path, headers = {}) {
  return fetch(`${baseUrl}${path}`, { headers });
}

describe("cookie 属性", () => {
  it("cookie 名为 sati_dashboard，路径限定 /memory-dashboard", () => {
    expect(COOKIE).toBe("sati_dashboard");
    const setCookie = auth.buildMemoryDashboardCookie("tok", urlTicketTtl("dashboard"));
    expect(setCookie).toContain("Path=/memory-dashboard");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=None");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain(`Max-Age=${urlTicketTtl("dashboard")}`);
  });
});

describe("文档导航用票据", () => {
  it("`?ticket=<dashboard>` 放行并种下路径限定 cookie", async () => {
    const ticket = dashboardTicket();
    const res = await fetchDashboard(`/memory-dashboard/index.html?ticket=${ticket}`);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${COOKIE}=${ticket}`);
    expect(setCookie).toContain("Path=/memory-dashboard");
    expect(setCookie).toContain("HttpOnly");
  });

  it("非 dashboard purpose 的 url-ticket 被拒 → 403", async () => {
    const ticket = generateUrlTicket(USER, { purpose: "file", project: "alpha", path: "a.txt" });
    const res = await fetchDashboard(`/memory-dashboard/index.html?ticket=${ticket}`);
    expect(res.status).toBe(403);
  });

  it("会话 JWT 放 `?ticket=` 被拒（scope 必须 url-ticket） → 403", async () => {
    const res = await fetchDashboard(`/memory-dashboard/index.html?ticket=${sessionToken()}`);
    expect(res.status).toBe(403);
  });

  it("会话 JWT 放 `?token=` 不再被接受 → 401", async () => {
    const res = await fetchDashboard(`/memory-dashboard/index.html?token=${sessionToken()}`);
    expect(res.status).toBe(401);
  });

  it("无凭据 → 401", async () => {
    const res = await fetchDashboard("/memory-dashboard/index.html");
    expect(res.status).toBe(401);
  });

  it("会话 JWT 走 Authorization 头仍可（程序化请求） → 200", async () => {
    const res = await fetchDashboard("/memory-dashboard/index.html", { Authorization: `Bearer ${sessionToken()}` });
    expect(res.status).toBe(200);
  });
});

describe("子资源靠 cookie 携带", () => {
  it("有效 cookie 访问子资源 → 200，且不重复种 cookie（不用资产请求刷新 TTL）", async () => {
    const ticket = dashboardTicket();
    const res = await fetchDashboard("/memory-dashboard/app.js", { Cookie: `${COOKIE}=${ticket}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("会话 JWT 放进 cookie 不被接受（scope 隔离不因载体改变） → 403", async () => {
    const res = await fetchDashboard("/memory-dashboard/app.js", { Cookie: `${COOKIE}=${sessionToken()}` });
    expect(res.status).toBe(403);
  });

  it("Referer 内嵌 token 不再作为凭据来源 → 401", async () => {
    const res = await fetchDashboard("/memory-dashboard/app.js", {
      Referer: `${baseUrl}/memory-dashboard/index.html?token=${sessionToken()}`,
    });
    expect(res.status).toBe(401);
  });

  it("非 dashboard purpose 的票据作为 cookie 被拒 → 403", async () => {
    const ticket = generateUrlTicket(USER, { purpose: "sse", path: "/ws/path" });
    const res = await fetchDashboard("/memory-dashboard/app.js", { Cookie: `${COOKIE}=${ticket}` });
    expect(res.status).toBe(403);
  });
});
