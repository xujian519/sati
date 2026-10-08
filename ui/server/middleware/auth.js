import { logger } from "../utils/consoleLogger.js";
import jwt from "jsonwebtoken";
import { userDb, appConfigDb } from "../database/db.js";
import { IS_PLATFORM, DISABLE_LOCAL_AUTH } from "../constants/config.js";

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }

  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }
  next();
};

function extractDashboardRefererToken(req) {
  const refererHeader = req.headers.referer || req.headers.referrer;
  if (!refererHeader || Array.isArray(refererHeader)) {
    return null;
  }

  try {
    const refererUrl = new URL(refererHeader, `${req.protocol}://${req.get("host")}`);
    if (!refererUrl.pathname.startsWith("/memory-dashboard")) {
      return null;
    }
    return refererUrl.searchParams.get("token");
  } catch {
    // Referer 头畸形、无法解析成 URL（new URL 抛 TypeError）→ 视为取不到内嵌 token，authenticateToken 继续按「无 token」回 401 而非 500。
    return null;
  }
}

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  // Platform mode:  use single database user
  if (IS_PLATFORM || DISABLE_LOCAL_AUTH) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: "No user found in database (restart server after DB init)" });
      }
      req.user = user;
      return next();
    } catch (error) {
      logger.error("Auth bypass mode error:", error);
      return res.status(500).json({ error: "Failed to fetch user" });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers["authorization"];
  let token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  // Also check query param for SSE endpoints (EventSource can't set headers)
  if (!token && req.query.token) {
    token = req.query.token;
  }
  // Memory dashboard static assets inherit the iframe document URL as Referer,
  // but do not inherit the query string onto app.js/app.css requests.
  if (!token) {
    token = extractDashboardRefererToken(req);
  }

  if (!token) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // 带 scope 的 token 是受限凭据（如项目预览凭据），只能由其专属中间件接受，不得当作完整会话。
    if (decoded.scope) {
      return res.status(403).json({ error: "Invalid token" });
    }

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: "Invalid token. User not found." });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken(user);
        res.setHeader("X-Refreshed-Token", newToken);
      }
    }

    req.user = user;
    next();
  } catch (error) {
    logger.error("Token verification error:", error);
    return res.status(403).json({ error: "Invalid token" });
  }
};

// Generate JWT token
const generateToken = user => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
    },
    JWT_SECRET,
    { expiresIn: "7d" },
  );
};

/** 项目预览凭据的 scope 标记。带此 scope 的 token 不能通过通用鉴权。 */
const PROJECT_PREVIEW_SCOPE = "project-preview";

/**
 * 项目预览凭据的有效期（秒）。iframe 只在导航时带一次凭据，子资源靠 cookie；取短值以限制泄露窗口。
 */
export const PROJECT_PREVIEW_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * 签发项目预览凭据：只对单个项目的预览路由有效。
 *
 * 它用于替代把会话 JWT 拼进预览 URL。即便被预览文档读取，它也无法调用任何其它 API
 * （通用鉴权与 WebSocket 鉴权都拒绝带 scope 的 token）。
 *
 * @param {{ id: number }} user - 当前用户。
 * @param {string} projectName - 绑定的项目名。
 * @returns {string} 预览凭据。
 */
export const generateProjectPreviewToken = (user, projectName) => {
  return jwt.sign({ userId: user.id, scope: PROJECT_PREVIEW_SCOPE, project: projectName }, JWT_SECRET, {
    expiresIn: PROJECT_PREVIEW_TOKEN_TTL_SECONDS,
  });
};

/**
 * 项目预览 cookie 名：文档为同目录子资源（CSS/JS/图片）种下的路径限定凭据。
 *
 * 预览文档处于不透明源（CSP sandbox），相对子资源请求不携带 Authorization 头；
 * H0 #1 实测：`SameSite=None; Secure` 是唯一能在沙箱文档子资源请求上被携带的组合
 * （`Lax` 已存储也不携带、`Partitioned` 不携带）。
 */
export const PROJECT_PREVIEW_COOKIE = "sati_project_preview";

/**
 * 预览 cookie 的 Set-Cookie 串。
 *
 * - `HttpOnly`：文档脚本读不到（沙箱不透明源下 `document.cookie` 本就抛 SecurityError，双保险）。
 * - `Secure`：要求可信源（https / localhost / 127.0.0.1）；局域网 http 下浏览器拒收，
 *   相对资源随之降级——这是已知分叉，由界面提示（H3）。
 * - `Path` 精确到该项目的预览前缀：一份 cookie 只对一个项目的预览生效。
 *
 * @param {string} token - 预览凭据。
 * @param {string} path - 该项目预览的原始 URL 前缀（`req.path` 截取，保留编码）。
 * @returns {string} Set-Cookie 头值。
 */
export const buildProjectPreviewCookie = (token, path) => {
  return `${PROJECT_PREVIEW_COOKIE}=${token}; Path=${path}; HttpOnly; SameSite=None; Secure; Max-Age=${PROJECT_PREVIEW_TOKEN_TTL_SECONDS}`;
};

/** 读取一个请求 cookie 的值（不引依赖；只认第一个同名项）。 */
function readRequestCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== "string" || header === "") return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

/**
 * 从预览请求的原始路径截出 cookie Path（`…/preview`，保留客户端使用的百分号编码）。
 *
 * Path 用 `req.path` 而不是由 `projectName` 重新编码：项目名可能含 `/`（绝对路径形态），
 * 重新编码可能得到与请求不同的十六进制大小写形态，导致 cookie 不匹配。
 */
function previewCookiePath(req) {
  const rawPath = typeof req.path === "string" ? req.path : "";
  const marker = "/preview";
  const at = rawPath.indexOf(marker);
  if (at < 0) return null;
  return rawPath.slice(0, at + marker.length);
}

/**
 * 校验一份预览凭据并放行；`setCookie` 时把凭据种成路径限定 cookie（供沙箱文档的子资源携带）。
 */
function verifyProjectPreviewToken(req, res, next, token, { setCookie }) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.scope !== PROJECT_PREVIEW_SCOPE || decoded.project !== req.params.projectName) {
      return res.status(403).json({ error: "Invalid token" });
    }
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: "Invalid token. User not found." });
    }
    req.user = user;
    if (setCookie) {
      const cookiePath = previewCookiePath(req);
      if (cookiePath !== null) {
        res.setHeader("Set-Cookie", buildProjectPreviewCookie(token, cookiePath));
      }
    }
    return next();
  } catch (error) {
    logger.error("Preview token verification error:", error);
    return res.status(403).json({ error: "Invalid token" });
  }
}

/**
 * 项目预览路由的鉴权。
 *
 * 接受三种凭据：
 * - `Authorization: Bearer <会话 JWT>`（程序化请求）；
 * - `?token=<项目预览凭据>`（文档导航；同时种下路径限定 cookie 供子资源使用）；
 * - `Cookie: sati_project_preview=<项目预览凭据>`（沙箱文档发出的相对子资源请求）。
 *
 * 会话 JWT 放在 query 中一律拒绝——它是此前泄露的来源。
 */
const authenticateProjectPreview = async (req, res, next) => {
  if (IS_PLATFORM || DISABLE_LOCAL_AUTH) {
    return authenticateToken(req, res, next);
  }

  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.split(" ")[1]) {
    return authenticateToken(req, res, next);
  }

  const queryToken = req.query.token;
  if (typeof queryToken === "string" && queryToken) {
    return verifyProjectPreviewToken(req, res, next, queryToken, { setCookie: true });
  }

  const cookieToken = readRequestCookie(req, PROJECT_PREVIEW_COOKIE);
  if (cookieToken) {
    return verifyProjectPreviewToken(req, res, next, cookieToken, { setCookie: false });
  }

  return res.status(401).json({ error: "Access denied. No token provided." });
};

// WebSocket authentication function
const authenticateWebSocket = token => {
  // Platform mode: bypass token validation, return first user
  if (IS_PLATFORM || DISABLE_LOCAL_AUTH) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { id: user.id, userId: user.id, username: user.username };
      }
      return null;
    } catch (error) {
      logger.error("Platform mode WebSocket error:", error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // 受限凭据（带 scope）不得开启 WebSocket 会话（与 REST authenticateToken 一致）。
    if (decoded.scope) {
      return null;
    }
    // Verify user actually exists in database (matches REST authenticateToken behavior)
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return null;
    }
    return { userId: user.id, username: user.username };
  } catch (error) {
    logger.error("WebSocket token verification error:", error);
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  authenticateProjectPreview,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET,
};
