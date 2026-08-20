/**
 * 团队活动面板 REST 路由（M4）：浏览器 → ui/server → gateway 协议方法。
 * 面板不直接碰 TeamDb（ui/server 无 teams.db 访问权），全部经 gateway
 * team_panel_snapshot / team_tool_call / panel_heartbeat 转发；权限/校验/事件广播
 * 在 gateway 侧工具层完成。
 *
 * gateway 访问统一走 getSatiGatewayWithReset（sati-bridge）：gateway 重启后缓存
 * 死连接自动复位，避免面板永久 500；catch 仍记录日志并转发错误给 express 错误
 * 处理链。
 */
import express from "express";
import { getSatiGatewayWithReset } from "../sati-bridge.js";

const router = express.Router();

/**
 * POST /api/teams/panel
 * 面板快照：TeamDb 直查 + SessionPresence 在线态合并（gateway team_panel_snapshot）。
 */
router.post("/panel", async (req, res, next) => {
  try {
    const { sessionKey } = req.body || {};
    if (sessionKey !== undefined && typeof sessionKey !== "string") {
      return res.status(400).json({ ok: false, error: { code: "invalid_request", message: "sessionKey 类型不合法" } });
    }
    const gw = await getSatiGatewayWithReset();
    const snapshot = await gw.teamPanelSnapshot({ sessionKey });
    res.json(snapshot);
  } catch (error) {
    console.error("[teams:/panel] gateway 调用失败:", error);
    next(error);
  }
});

/**
 * POST /api/teams/action
 * 面板操作：直调既有 team_* 工具（gateway team_tool_call；权限/校验/事件广播在
 * gateway 工具层完成）。tool 非 string/空串或 input 非 object → 400；sessionKey
 * 类型不合法 → 400。
 */
router.post("/action", async (req, res, next) => {
  try {
    const { tool, input, sessionKey } = req.body || {};
    if (
      typeof tool !== "string" ||
      tool.length === 0 ||
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input)
    ) {
      return res.status(400).json({ ok: false, error: { code: "invalid_request", message: "tool/input 必填" } });
    }
    if (sessionKey !== undefined && typeof sessionKey !== "string") {
      return res.status(400).json({ ok: false, error: { code: "invalid_request", message: "sessionKey 类型不合法" } });
    }
    const gw = await getSatiGatewayWithReset();
    const result = await gw.teamToolCall({ tool, input, sessionKey });
    res.json(result);
  } catch (error) {
    console.error("[teams:/action] gateway 调用失败:", error);
    next(error);
  }
});

/**
 * POST /api/teams/heartbeat
 * 面板心跳：汇总活跃浏览器会话 key 上报 gateway（SessionPresence.panelTouch）。
 * sessionKeys 非数组 → 400。
 */
router.post("/heartbeat", async (req, res, next) => {
  try {
    const { sessionKeys } = req.body || {};
    if (!Array.isArray(sessionKeys)) {
      return res.status(400).json({ touched: 0 });
    }
    const gw = await getSatiGatewayWithReset();
    const result = await gw.panelHeartbeat({ sessionKeys });
    res.json(result);
  } catch (error) {
    console.error("[teams:/heartbeat] gateway 调用失败:", error);
    next(error);
  }
});

export default router;
