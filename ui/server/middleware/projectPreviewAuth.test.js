// @vitest-environment node
/**
 * 项目预览凭据的鉴权判据（P0：凭据外泄修复）。
 *
 * 不变式：会话 JWT 永远不能出现在预览 URL 中被接受；预览凭据只对它绑定的单个项目的
 * 预览路由有效，且不能通过任何通用鉴权面（REST / WebSocket）当作完整会话使用。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";

const TEST_SECRET = "test-secret-for-project-preview";
const USER = { id: 7, username: "tester" };

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
const { authenticateToken, authenticateProjectPreview, generateProjectPreviewToken } = auth;

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.get("/api/projects/:projectName/preview/{*splat}", authenticateProjectPreview, (req, res) => {
    res.json({ ok: true, project: req.params.projectName, userId: req.user.id });
  });
  app.get("/api/projects/:projectName/files/content", authenticateToken, (req, res) => {
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
  return response.status;
}

describe("项目预览凭据", () => {
  it("签发的预览凭据可以访问它绑定的项目预览", async () => {
    const token = generateProjectPreviewToken(USER, "alpha");
    expect(await get(`/api/projects/alpha/preview/index.html?token=${token}`)).toBe(200);
  });

  it("预览凭据不能访问另一个项目的预览", async () => {
    const token = generateProjectPreviewToken(USER, "alpha");
    expect(await get(`/api/projects/beta/preview/index.html?token=${token}`)).toBe(403);
  });

  it("预览凭据不能通过通用鉴权调用其它 API（scope 隔离）", async () => {
    const token = generateProjectPreviewToken(USER, "alpha");
    expect(await get(`/api/projects/alpha/files/content?token=${token}`)).toBe(403);
  });

  it("预览凭据放在 Authorization 头中同样不被当作完整会话", async () => {
    const token = generateProjectPreviewToken(USER, "alpha");
    expect(await get("/api/projects/alpha/files/content", { Authorization: `Bearer ${token}` })).toBe(403);
  });

  it("过期的预览凭据被拒绝", async () => {
    const expired = jwt.sign(
      {
        userId: USER.id,
        scope: "project-preview",
        project: "alpha",
        exp: Math.floor(Date.now() / 1000) - 60,
      },
      TEST_SECRET,
    );
    expect(await get(`/api/projects/alpha/preview/index.html?token=${expired}`)).toBe(403);
  });

  it("预览凭据的有效期很短（不超过 15 分钟）", () => {
    expect(auth.PROJECT_PREVIEW_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
    const decoded = jwt.decode(generateProjectPreviewToken(USER, "alpha"));
    expect(decoded.exp - decoded.iat).toBe(auth.PROJECT_PREVIEW_TOKEN_TTL_SECONDS);
  });
});

describe("会话 JWT 不得再出现在预览 URL 中", () => {
  it("会话 JWT 放在 query 中访问预览路由被拒绝", async () => {
    expect(await get(`/api/projects/alpha/preview/index.html?token=${sessionToken()}`)).toBe(403);
  });

  it("没有任何凭据访问预览路由返回 401", async () => {
    expect(await get("/api/projects/alpha/preview/index.html")).toBe(401);
  });

  it("会话 JWT 通过 Authorization 头访问预览路由仍可用（程序化请求）", async () => {
    expect(await get("/api/projects/alpha/preview/index.html", { Authorization: `Bearer ${sessionToken()}` })).toBe(
      200,
    );
  });

  it("通用鉴权的 query 会话 token 行为保持不变（SSE 等既有用途）", async () => {
    expect(await get(`/api/projects/alpha/files/content?token=${sessionToken()}`)).toBe(200);
  });
});

describe("WebSocket 鉴权不接受受限凭据", () => {
  it("预览凭据不能开启 WebSocket 会话", () => {
    const token = generateProjectPreviewToken(USER, "alpha");
    expect(auth.authenticateWebSocket(token)).toBeNull();
  });

  it("会话 JWT 的 WebSocket 鉴权保持可用", () => {
    expect(auth.authenticateWebSocket(sessionToken())).toEqual({ userId: USER.id, username: USER.username });
  });
});

/**
 * 预览 cookie（H2 #1 回退）：沙箱文档的相对子资源请求不携带 Authorization 头；
 * 文档导航的 query 凭据会种下 `SameSite=None; Secure` 的路径限定 cookie 供其携带。
 */
describe("项目预览 cookie", () => {
  const COOKIE = auth.PROJECT_PREVIEW_COOKIE;

  async function fetchPreview(path, headers = {}) {
    return fetch(`${baseUrl}${path}`, { headers });
  }

  it("pin the cookie name and attributes", () => {
    expect(COOKIE).toBe("sati_project_preview");
    const cookie = auth.buildProjectPreviewCookie("tok", "/api/projects/alpha/preview");
    expect(cookie).toContain(`Path=/api/projects/alpha/preview`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain(`Max-Age=${auth.PROJECT_PREVIEW_TOKEN_TTL_SECONDS}`);
  });

  it("有效预览 cookie 可访问预览路由（无 query、无 Authorization）", async () => {
    const token = generateProjectPreviewToken(USER, "alpha");
    expect(await get("/api/projects/alpha/preview/index.html", { Cookie: `${COOKIE}=${token}` })).toBe(200);
  });

  it("跨项目的 cookie 被拒绝", async () => {
    const token = generateProjectPreviewToken(USER, "alpha");
    expect(await get("/api/projects/beta/preview/index.html", { Cookie: `${COOKIE}=${token}` })).toBe(403);
  });

  it("会话 JWT 放进 cookie 不被接受（scope 隔离不因载体改变）", async () => {
    expect(await get("/api/projects/alpha/preview/index.html", { Cookie: `${COOKIE}=${sessionToken()}` })).toBe(403);
  });

  it("query 凭据导航会种下路径限定的 cookie，cookie 鉴权不刷新它", async () => {
    const token = generateProjectPreviewToken(USER, "alpha");

    const navigation = await fetchPreview(`/api/projects/alpha/preview/index.html?token=${token}`);
    expect(navigation.status).toBe(200);
    const setCookie = navigation.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${COOKIE}=${token}`);
    expect(setCookie).toContain("Path=/api/projects/alpha/preview");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=None");
    expect(setCookie).toContain("Secure");

    const subresource = await fetchPreview("/api/projects/alpha/preview/style.css", { Cookie: `${COOKIE}=${token}` });
    expect(subresource.status).toBe(200);
    // 子资源不重复种 cookie（避免用资产请求刷新 TTL）。
    expect(subresource.headers.get("set-cookie")).toBeNull();
  });

  it("cookie 在其它路由不被当作凭据（通用鉴权不读它）", async () => {
    const token = generateProjectPreviewToken(USER, "alpha");
    expect(await get("/api/projects/alpha/files/content", { Cookie: `${COOKIE}=${token}` })).toBe(401);
  });
});
