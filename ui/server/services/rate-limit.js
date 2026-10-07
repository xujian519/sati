/**
 * ui/server 路由限流器（B1 分片）。
 *
 * 从 ui/server/index.js 拆出（机械搬移，不改逻辑）：闭包限流器工厂 +
 * Office 预览的两个实例。
 */

function createRouteRateLimiter({ windowMs, maxRequests, keyPrefix, message = "Too many requests" }) {
  const buckets = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const identity = req.user?.id || req.ip || "anonymous";
    const key = `${keyPrefix}:${identity}`;
    const bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count <= maxRequests) {
      return next();
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({
      error: message,
      code: "RATE_LIMITED",
    });
  };
}

const officePreviewStatusRateLimiter = createRouteRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  keyPrefix: "office-preview-status",
  message: "Too many Office preview status requests",
});

const officePreviewPdfRateLimiter = createRouteRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 30,
  keyPrefix: "office-preview-pdf",
  message: "Too many Office preview conversion requests",
});

// 连接性探测会向上游发真实请求（出网 + 按量计费），必须限流：
// 无限流时可被反复触发刷出网/计费。10 次/分钟 ≈ 逐个试模型的正常节奏。
const connectionTestRateLimiter = createRouteRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: "config-test-connection",
  message: "Too many connection test requests",
});

const webSearchTestRateLimiter = createRouteRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: "config-test-web-search",
  message: "Too many web search test requests",
});

export {
  createRouteRateLimiter,
  officePreviewStatusRateLimiter,
  officePreviewPdfRateLimiter,
  connectionTestRateLimiter,
  webSearchTestRateLimiter,
};
