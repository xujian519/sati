/**
 * 项目级 hook 信任 REST 路由（1.2b）：浏览器 → ui/server → gateway 协议方法。
 *
 * 未评审的项目插件 hook 默认**不装载**（门在 `src/` 的会话装配点），所以浏览器侧必须有一个
 * 看得见声明原文的授权入口。本路由经 `getSatiGatewayWithReset()` 调 `hook_trust_list` /
 * `hook_trust_decide`，不直接读信任存储文件——唯一事实源是 gateway 那侧的
 * `HookTrustStore` 与插件运行时。
 */
import express from "express";
import { logger } from "../utils/consoleLogger.js";
import { getSatiGatewayWithReset } from "../sati-bridge.js";

const router = express.Router();

function requireProjectKey(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// GET /?projectKey=<项目根> — 列出该项目「项目来源」插件的 hook 声明与信任状态
router.get("/", async (req, res, next) => {
  const projectKey = req.query.projectKey;
  if (!requireProjectKey(projectKey)) {
    return res.status(400).json({ error: { code: "invalid_request", message: "projectKey is required" } });
  }
  try {
    const gw = await getSatiGatewayWithReset();
    if (typeof gw.hookTrustList !== "function") {
      return res.status(501).json({
        error: { code: "not_configured", message: "gateway 不支持 hook_trust_list（可能版本过低）" },
      });
    }
    res.json(await gw.hookTrustList({ projectKey }));
  } catch (error) {
    logger.error("[hook-trust:list] gateway 调用失败:", error);
    next(error);
  }
});

// POST /decide — { projectKey, pluginId, verdict: "grant" | "revoke" }
router.post("/decide", async (req, res, next) => {
  const body = req.body || {};
  const { projectKey, pluginId, verdict } = body;
  if (!requireProjectKey(projectKey) || typeof pluginId !== "string" || pluginId.trim().length === 0) {
    return res
      .status(400)
      .json({ error: { code: "invalid_request", message: "projectKey and pluginId are required" } });
  }
  if (verdict !== "grant" && verdict !== "revoke") {
    return res.status(400).json({ error: { code: "invalid_request", message: 'verdict must be "grant" or "revoke"' } });
  }
  try {
    const gw = await getSatiGatewayWithReset();
    if (typeof gw.hookTrustDecide !== "function") {
      return res.status(501).json({
        error: { code: "not_configured", message: "gateway 不支持 hook_trust_decide（可能版本过低）" },
      });
    }
    res.json(await gw.hookTrustDecide({ projectKey, pluginId, verdict }));
  } catch (error) {
    logger.error("[hook-trust:decide] gateway 调用失败:", error);
    next(error);
  }
});

export default router;
