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
 * 项目预览凭据的有效期（秒）。iframe 只在导航时带一次凭据，子资源不携带它，
 * 因此有效期只需覆盖一次预览会话；取短值以限制泄露窗口。
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
 * 项目预览路由的鉴权。
 *
 * 接受两种凭据：
 * - `Authorization: Bearer <会话 JWT>`（程序化请求）；
 * - `?token=<项目预览凭据>`，且必须 scope 为预览、项目名与路径参数一致。
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

  const token = req.query.token;
  if (typeof token !== "string" || !token) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }

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
    return next();
  } catch (error) {
    logger.error("Preview token verification error:", error);
    return res.status(403).json({ error: "Invalid token" });
  }
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
