/**
 * 本机免登录模式下的请求来源守卫。
 *
 * 本机默认免登录（`middleware/auth.js`：`IS_PLATFORM || DISABLE_LOCAL_AUTH` 直接放行），而
 * `index.js` 的 `cors()` 又放行任意 origin —— 于是**用户浏览器里任意一个外部网页**都能 `fetch()`
 * 本机 API 并读到响应：注册任意目录（`POST /api/create-workspace`）、读写文件、甚至开 WebSocket。
 * 授权的收口（root 只认项目注册表）挡不住这一类，因为攻击者可以先注册再访问。
 *
 * 判据是「只有**本机可达**的来源能调用」——`Host` 与 `Origin` 两个头都要落在同一套本机名字里：
 * 回环名/地址、私有地址字面量、本机主机名，或显式 `SATI_TRUSTED_HOSTS` 里列出的名字。
 *
 * - `Host` 这一半挡的是 **DNS rebinding**：攻击者的域名解析到 127.0.0.1，请求到达时 `Host` 就是
 *   那个公网域名，不是本机名字。
 * - `Origin` 这一半挡的是 **外部网页直连**：跨站 `fetch` 一定带 `Origin`（值就是页面来源），
 *   `Origin: null`（沙箱 iframe / `file://` 页面）解析不出主机名，同样不算本机来源。
 *
 * 两半都**不要求** `Origin` 与 `Host` 相等：dev 下 Vite 代理默认 `changeOrigin: true` 会把 `Host`
 * 改写成代理目标（`localhost:3001`），而页面的 `Origin` 是 `127.0.0.1:5173`——按相等判会直接打断
 * `pnpm dev`。
 *
 * 边界要说清（不夸大）：**本机进程级信任不在防护内**。本机任何端口上的页面（localhost/127.0.0.1/
 * 私有地址字面量）仍可调用，因为本机进程本来就能直连 API；被挡住的是公网来源（含 rebinding 域名）。
 * 无 `Origin` 的请求（curl、Node 客户端、Electron 主进程、同源 GET 导航）只看 `Host` 这一半。
 */
import { hostname } from "node:os";

/** 从 `Host` / `Origin` 里取出主机名：去掉端口，`[::1]:3001` 去掉方括号。 */
export function extractHostname(value) {
  if (typeof value !== "string") {
    return "";
  }
  let host = value.trim().toLowerCase();
  if (!host) {
    return "";
  }
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? "" : host.slice(1, end);
  }
  // 裸 IPv6（`::1`）含多个冒号，不能按最后一个冒号切端口。
  const colon = host.lastIndexOf(":");
  if (colon !== -1 && host.indexOf(":") === colon) {
    host = host.slice(0, colon);
  }
  return host;
}

function isPrivateOrLoopbackName(host) {
  if (!host) {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) {
    return false;
  }
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return (
    a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  );
}

/**
 * `Host` 是否为本机可达的名字。
 *
 * @param {string} value 原始 `Host` 头。
 * @param {{ selfHostname?: string, trustedHosts?: string[] }} [options] 本机主机名与显式信任名单。
 * @returns {boolean} 可信则 true。
 */
export function isTrustedLocalHost(value, { selfHostname = hostname(), trustedHosts = [] } = {}) {
  const host = extractHostname(value);
  if (!host) {
    return false;
  }
  const self = String(selfHostname || "").toLowerCase();
  if (self && (host === self || host === `${self}.local`)) {
    return true;
  }
  if (trustedHosts.some(entry => extractHostname(entry) === host)) {
    return true;
  }
  return isPrivateOrLoopbackName(host);
}

/** 从 `Origin`（完整 URL，如 `http://localhost:5173`）里取出主机名；`null` 等非 URL 值取不到。 */
export function originHostname(value) {
  if (typeof value !== "string") {
    return "";
  }
  try {
    return extractHostname(new URL(value).host);
  } catch {
    // `Origin: null`（沙箱 iframe / `file://` 页面）与畸形值都解析失败 → 取不到主机名即不可信。
    return "";
  }
}

/**
 * 请求来源是否可信（HTTP 中间件与 WebSocket 握手共用同一条判据）。
 *
 * 两个头各自过一遍「本机可达名字」的判定：`Host` 必有，`Origin` 有则必须也过（缺 `Origin` 的
 * 客户端不是浏览器，不受该半条约束）。
 *
 * @param {{ host?: string, origin?: string }} headers `Host` 与 `Origin` 头（WS 握手用 `info.origin`）。
 * @param {{ selfHostname?: string, trustedHosts?: string[] }} [options] 本机主机名与显式信任名单。
 * @returns {boolean} 可信则 true。
 */
export function isTrustedRequestSource({ host, origin }, options = {}) {
  if (!isTrustedLocalHost(host, options)) {
    return false;
  }
  return !origin || isTrustedLocalHost(originHostname(origin), options);
}

/** 403：请求来自不可信来源（跨站页面 / DNS rebinding / 非本机 Host）。 */
function untrustedOrigin(res) {
  return res.status(403).json({
    error: {
      code: "UNTRUSTED_REQUEST_ORIGIN",
      message:
        "This API is only reachable from the local app. If you serve the UI on another host, list it in SATI_TRUSTED_HOSTS.",
    },
  });
}

/**
 * 构造来源守卫中间件。
 *
 * @param {{ enabled?: boolean, selfHostname?: string, trustedHosts?: string[] }} [options]
 *   `enabled` 为 false 时是透传中间件（托管部署走这条）。`core` 参数供测试注入。
 * @returns {(req: any, res: any, next: any) => unknown} Express 中间件。
 */
export function createLocalOriginGuard({ enabled = false, selfHostname = hostname(), trustedHosts = [] } = {}) {
  if (!enabled) {
    return (_req, _res, next) => next();
  }
  const trustOptions = { selfHostname, trustedHosts };
  return (req, res, next) => {
    if (!isTrustedRequestSource({ host: req.headers.host, origin: req.headers.origin }, trustOptions)) {
      return untrustedOrigin(res);
    }
    return next();
  };
}
