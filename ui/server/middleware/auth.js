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
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  // 无 Authorization 头：改由 `?ticket=` 的短期 URL 票据放行（#626）。会话 JWT 不再从 query 或
  // Referer 接受——旧的两条泄露源（会话 token 落进 URL/历史/日志、子资源靠 Referer 内嵌 token）
  // 一并切断。票据是 scope 受限、短 TTL、不可当完整会话的一次性凭据（见 verifyUrlTicket）。
  if (!token) {
    return verifyUrlTicket(req, res, next);
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

/** URL 票据的 scope 标记（#626）：供无法自定义头的载体短期访问受限资源，不能当完整会话。 */
const URL_TICKET_SCOPE = "url-ticket";

/**
 * 各用途票据的有效期（秒）。一次性文件/二维码/SSE 取短值（仅需覆盖 URL 暴露窗口，
 * 连接/加载一经建立即不受 TTL 约束）；dashboard 稍长（cookie 携子资源复用，参照 #615 预览先例）。
 */
const URL_TICKET_TTL_SECONDS = {
  file: 5 * 60,
  qr: 5 * 60,
  sse: 5 * 60,
  dashboard: 15 * 60,
};

/** 该用途的有效期（秒），供签发端点回传 expiresIn。 */
export const urlTicketTtl = purpose => URL_TICKET_TTL_SECONDS[purpose] || URL_TICKET_TTL_SECONDS.file;

/**
 * 签发一份 URL 票据：短期、scope 受限，可选绑定项目/文件路径。
 *
 * 它替代把会话 JWT 拼进 `<iframe>`/`<img>`/EventSource/dashboard 文档 URL。即便落进浏览器历史、
 * Referer、反代/服务日志或分享链接，也无法当完整会话调用其它 API（通用鉴权与 WebSocket 都拒绝带 scope 的 token），
 * 且很快过期。
 *
 * @param {{ id: number }} user - 当前用户。
 * @param {{ purpose: string, project?: string, path?: string }} opts - 用途与可选资源绑定。
 * @returns {string} 票据。
 */
export const generateUrlTicket = (user, { purpose, project, path }) => {
  const payload = { userId: user.id, scope: URL_TICKET_SCOPE, purpose };
  if (project !== undefined) payload.project = project;
  if (path !== undefined) payload.path = path;
  return jwt.sign(payload, JWT_SECRET, { expiresIn: urlTicketTtl(purpose) });
};

/**
 * 校验 `?ticket=` 里的 URL 票据并放行（供 authenticateToken 在无 Authorization 头时委派）。
 *
 * 只认 scope==="url-ticket"（会话 JWT 或别的 scoped 凭据塞进 `?ticket=` 一律拒绝）；
 * 绑定按「请求侧」驱动以避免跨载体复用：项目级路由（带 `:projectName`）要求票据绑定同一项目，
 * 文件级路由（带 `?path=`）要求票据绑定同一路径。放行时设 `req.user` 并直接 next——
 * 不进入会话 auto-refresh，绝不换发会话 token。
 */
function verifyUrlTicket(req, res, next) {
  const ticket = req.query.ticket;
  if (typeof ticket !== "string" || !ticket) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }
  let decoded;
  try {
    decoded = jwt.verify(ticket, JWT_SECRET);
  } catch (error) {
    logger.error("URL ticket verification error:", error);
    return res.status(403).json({ error: "Invalid ticket" });
  }
  if (decoded.scope !== URL_TICKET_SCOPE) {
    return res.status(403).json({ error: "Invalid ticket" });
  }
  if (req.params.projectName !== undefined && decoded.project !== req.params.projectName) {
    return res.status(403).json({ error: "Invalid ticket" });
  }
  if (typeof req.query.path === "string" && decoded.path !== req.query.path) {
    return res.status(403).json({ error: "Invalid ticket" });
  }
  const user = userDb.getUserById(decoded.userId);
  if (!user) {
    return res.status(401).json({ error: "Invalid token. User not found." });
  }
  req.user = user;
  return next();
}

/**
 * 仅接受 Authorization 头会话 token 的鉴权（不接受 query 票据 / cookie）。
 * 用于「用会话换发票据」的签发端点，防止一份短票据被用来续换更长/更宽的票据。
 * 平台 / 免登录模式下委派 authenticateToken 整体旁路（与现状一致）。
 */
const authenticateSessionOnly = async (req, res, next) => {
  if (IS_PLATFORM || DISABLE_LOCAL_AUTH) {
    return authenticateToken(req, res, next);
  }
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.scope) {
      return res.status(403).json({ error: "Invalid token" });
    }
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: "Invalid token. User not found." });
    }
    req.user = user;
    return next();
  } catch (error) {
    logger.error("Token verification error:", error);
    return res.status(403).json({ error: "Invalid token" });
  }
};

/**
 * memory-dashboard 子资源 cookie 名：文档为同目录相对资源（app.js/app.css）种下的路径限定凭据。
 * 与项目预览 cookie 同一范式（沙箱/相对请求不带 Authorization 头，靠路径限定 cookie 携带）。
 */
export const MEMORY_DASHBOARD_COOKIE = "sati_dashboard";

/** memory-dashboard 票据 cookie 的 Set-Cookie 串（路径限定到 /memory-dashboard）。 */
export const buildMemoryDashboardCookie = (token, ttlSeconds) =>
  `${MEMORY_DASHBOARD_COOKIE}=${token}; Path=/memory-dashboard; HttpOnly; SameSite=None; Secure; Max-Age=${ttlSeconds}`;

/** 校验一份 memory-dashboard 票据；`setCookie` 时把凭据种成路径限定 cookie 供子资源携带。 */
function verifyMemoryDashboardTicket(req, res, next, token, { setCookie }) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.scope !== URL_TICKET_SCOPE || decoded.purpose !== "dashboard") {
      return res.status(403).json({ error: "Invalid ticket" });
    }
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: "Invalid token. User not found." });
    }
    req.user = user;
    if (setCookie) {
      res.setHeader("Set-Cookie", buildMemoryDashboardCookie(token, urlTicketTtl("dashboard")));
    }
    return next();
  } catch (error) {
    logger.error("Memory dashboard ticket verification error:", error);
    return res.status(403).json({ error: "Invalid ticket" });
  }
}

/**
 * memory-dashboard 文档与静态子资源的鉴权（替代旧的 Referer 内嵌会话 token）。
 *
 * 接受三种凭据：
 * - `Authorization: Bearer <会话 JWT>`（程序化请求）；
 * - `?ticket=<dashboard 票据>`（iframe 文档导航；同时种下路径限定 cookie 供子资源使用）；
 * - `Cookie: sati_dashboard=<dashboard 票据>`（文档发出的相对子资源请求）。
 * 会话 JWT 放 query 一律拒绝（#626）。
 */
const authenticateMemoryDashboard = async (req, res, next) => {
  if (IS_PLATFORM || DISABLE_LOCAL_AUTH) {
    return authenticateToken(req, res, next);
  }
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.split(" ")[1]) {
    return authenticateToken(req, res, next);
  }
  const ticket = req.query.ticket;
  if (typeof ticket === "string" && ticket) {
    return verifyMemoryDashboardTicket(req, res, next, ticket, { setCookie: true });
  }
  const cookieToken = readRequestCookie(req, MEMORY_DASHBOARD_COOKIE);
  if (cookieToken) {
    return verifyMemoryDashboardTicket(req, res, next, cookieToken, { setCookie: false });
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
  authenticateMemoryDashboard,
  authenticateSessionOnly,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET,
};
