import { isLoopbackHost } from "../../shared/networkHosts.js";
import { ALLOWED_ORIGINS } from "../constants/config.js";

/**
 * 跨站来源判定与 CORS 收窄（#625）。
 *
 * 背景：默认免登录模式（`DISABLE_LOCAL_AUTH`）下，服务端曾无条件 `cors()`（ACAO `*`），
 * 于是同机浏览器里任意第三方网页都能跨域读取本机 API。本模块把「是否可信来源」做成一个
 * **纯判定**，供 HTTP 中间件与 WebSocket 握手共用（WebSocket 不受 CORS 约束，必须服务端拒）。
 *
 * 可信判据（任一成立即放行）：
 * 1. 请求**不带 `Origin`**——非浏览器来源（curl、本地工具、健康检查、服务器间调用）；
 * 2. `Origin` 主机与请求 `Host` **同源**——Web UI / Electron 渲染层直接命中 `http://127.0.0.1:PORT`；
 * 3. `Origin` 主机是**环回地址**（localhost / 127.0.0.1 / ::1，任意端口）——覆盖 Vite dev 代理等本机来源；
 * 4. `Origin` 在 `SATI_ALLOWED_ORIGINS` 显式白名单内——反向代理 / 容器 / 跨机部署。
 * 其余（含 `null`：file://、data:、沙箱 iframe）一律拒绝。
 */

/** 解析 Origin 的主机名与「host:port」；畸形或 `null` 返回 null。 */
function parseOrigin(origin) {
  if (!origin || origin === "null") return null;
  try {
    const url = new URL(origin);
    return { hostname: url.hostname, host: url.host };
  } catch {
    // 畸形 Origin（不可解析为 URL）：视为不可信来源，交由调用方判拒——宁拒勿放。
    return null;
  }
}

/**
 * 纯判定：给定 Origin/Host 头与白名单，返回该请求来源是否可信。
 * @param {string | undefined} origin 请求 `Origin` 头（可能缺省）
 * @param {string | undefined} host   请求 `Host` 头
 * @param {ReadonlySet<string>} allowlist 显式白名单
 */
export function isTrustedOrigin(origin, host, allowlist = ALLOWED_ORIGINS) {
  // 1. 无 Origin：非浏览器 / 同工具，放行。
  if (!origin) return true;
  // 4. 显式白名单（含允许登记 "null" 以放行特定 file:// 场景）。
  if (allowlist.has(origin)) return true;
  const parsed = parseOrigin(origin);
  if (!parsed) return false; // 畸形或 null 且未白名单 → 拒。
  // 2. 同源：Origin 的 host[:port] 与请求 Host 完全一致。
  if (host && parsed.host === host) return true;
  // 3. 环回主机（任意端口）：本机来源。
  return isLoopbackHost(parsed.hostname);
}

/**
 * Express 中间件：拒绝不可信跨站请求；对「可信但跨源」的请求回填 CORS 响应头
 * （反射 Origin + 凭据 + `X-Refreshed-Token` 暴露），使可信的跨机部署仍可用。
 * 同源请求不需要 CORS 头；无 Origin 请求原样透传。
 */
export function corsPolicy(allowlist = ALLOWED_ORIGINS) {
  return function corsPolicyMiddleware(req, res, next) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    // ACAO 随 Origin 变化，声明 Vary 以免缓存串源。
    res.setHeader("Vary", "Origin");

    if (origin && !isTrustedOrigin(origin, host, allowlist)) {
      // 不可信跨站：在抵达任何路由/副作用前拒绝（预检回 204 空，实际请求回 403）。
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        return res.end();
      }
      return res.status(403).json({
        error: "Cross-origin request blocked. Trust this origin via SATI_ALLOWED_ORIGINS if required.",
      });
    }

    // 可信且跨源（Origin 主机 ≠ Host）：反射来源 + 允许凭据，覆盖白名单/环回跨机场景。
    const parsed = parseOrigin(origin);
    const isCrossOrigin = Boolean(origin) && !(host && parsed && parsed.host === host);
    if (isCrossOrigin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Expose-Headers", "X-Refreshed-Token");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, X-Refreshed-Token");
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        return res.end();
      }
    }

    return next();
  };
}
