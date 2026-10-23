// Ensure unified YAML config is applied before reading flags.
import "../load-env.js";

/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
export const IS_PLATFORM = process.env.VITE_IS_PLATFORM === "true";

/**
 * legacy(pre-rebrand): 兼容 PilotDeck 旧环境变量，升级用户数据迁移用。
 * When true, skip JWT login/register in the web UI (single-user local mode).
 * Set SATI_DISABLE_LOCAL_AUTH=0 or false to require username/password again.
 * The pre-rebrand PILOTDECK_DISABLE_LOCAL_AUTH is honored too: an explicit
 * "0"/"false" there must keep auth required after an upgrade, otherwise a
 * previously password-protected UI would silently open up.
 * @type {boolean}
 */
export const DISABLE_LOCAL_AUTH =
  process.env.SATI_DISABLE_LOCAL_AUTH !== "0" &&
  process.env.SATI_DISABLE_LOCAL_AUTH !== "false" &&
  process.env.PILOTDECK_DISABLE_LOCAL_AUTH !== "0" &&
  process.env.PILOTDECK_DISABLE_LOCAL_AUTH !== "false";

/**
 * 跨站请求的显式可信来源白名单（#625）。
 * `SATI_ALLOWED_ORIGINS` 为逗号/空格分隔的 Origin 列表（如 `https://sati.example.com null`）。
 * 白名单之外的**非环回**外部网页 Origin 一律被服务端拒绝（不依赖浏览器侧 CORS）。
 * 桌面（同源 http://127.0.0.1:PORT）与 Web（同源）与 Vite dev（同源/环回）默认放行，无需登记；
 * 反向代理、容器、跨机部署等非环回来源须在此显式声明。
 * @type {ReadonlySet<string>}
 */
export const ALLOWED_ORIGINS = new Set(
  (process.env.SATI_ALLOWED_ORIGINS || "")
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean),
);

/**
 * 本机免登录模式下的显式 Host 信任名单（#748）。
 * `SATI_TRUSTED_HOSTS` 为逗号/空格分隔的主机名或 IP（如 `192.168.1.5 sati.lan`）。
 * 默认只信任环回名字；绑定 `HOST=0.0.0.0` 或经局域网 / 自定义域名访问时，须把访问名登记在此，
 * 否则 HTTP 返回 403、WebSocket 拒绝握手。
 * @type {ReadonlySet<string>}
 */
export const TRUSTED_HOSTS = new Set(
  (process.env.SATI_TRUSTED_HOSTS || "")
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean),
);
